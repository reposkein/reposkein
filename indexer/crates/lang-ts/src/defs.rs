//! TypeScript definition extraction with stable rs1 ids.

use reposkein_core::hash::content_hash;
use reposkein_core::model::{Edge, Node};
use reposkein_lang_common::{module_var_kind, text, unique};
use serde_json::json;
use std::collections::HashMap;
use tree_sitter::Node as TsNode;

#[derive(Clone, Copy, PartialEq)]
pub enum ScopeKind {
    Module,
    Class,
    Function,
}

pub struct Walk<'a> {
    repo: &'a str,
    rel_path: &'a str,
    source: &'a [u8],
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub calls: Vec<reposkein_core::extractor::RawCall>,
    used: HashMap<String, u32>,
    declared: std::collections::HashMap<String, String>,
    pending_heritage: Vec<reposkein_core::heritage::PendingHeritage>,
}

/// TS/JS `@arity`: named children of `parameters` whose kind ends in
/// `parameter` (required/optional/rest); type-only nodes don't count. FROZEN
/// part of the rs1: scheme — see `reposkein_core::id` and the test below.
fn arity(node: TsNode) -> usize {
    let Some(params) = node.child_by_field_name("parameters") else {
        return 0;
    };
    let mut c = params.walk();
    params
        .named_children(&mut c)
        .filter(|n| n.kind().ends_with("parameter"))
        .count()
}

fn name_of(node: TsNode, source: &[u8]) -> String {
    node.child_by_field_name("name")
        .map(|n| text(n, source).to_string())
        .unwrap_or_default()
}

fn first_line(node: TsNode, source: &[u8]) -> String {
    text(node, source)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Extracts a bare type name from a heritage base node, stripping any type
/// arguments. Handles:
///   - `type_identifier` / `identifier` → text directly
///   - `generic_type` → the `name` field (e.g. `Foo<T>` → `Foo`)
///   - anything else → text with `<…>` stripped as a fallback
fn base_type_name(node: TsNode, source: &[u8]) -> String {
    match node.kind() {
        "type_identifier" | "identifier" => text(node, source).to_string(),
        "generic_type" => {
            // generic_type has a `name` field (type_identifier or nested_type_identifier)
            node.child_by_field_name("name")
                .map(|n| text(n, source).to_string())
                .unwrap_or_else(|| strip_angle_brackets(text(node, source)))
        }
        _ => strip_angle_brackets(text(node, source)),
    }
}

/// Strips everything from the first `<` to the matching `>` (type arguments).
fn strip_angle_brackets(s: &str) -> String {
    match s.find('<') {
        Some(i) => s[..i].to_string(),
        None => s.to_string(),
    }
}

impl<'a> Walk<'a> {
    pub fn new(repo: &'a str, rel_path: &'a str, source: &'a [u8]) -> Self {
        Walk {
            repo,
            rel_path,
            source,
            nodes: Vec::new(),
            edges: Vec::new(),
            calls: Vec::new(),
            used: HashMap::new(),
            declared: std::collections::HashMap::new(),
            pending_heritage: Vec::new(),
        }
    }

    /// Returns a per-file-unique id: base for the first occurrence, then
    /// base.1, base.2, … for collisions (PRD §5.3 ordinal disambiguation).
    fn unique(&mut self, base: String) -> String {
        unique(&mut self.used, base)
    }

    fn func_id(&self, qualified: &str, arity: usize) -> String {
        format!(
            "rs1:{}:func:{}#{}@{}",
            self.repo, self.rel_path, qualified, arity
        )
    }
    fn class_id(&self, qualified: &str) -> String {
        format!("rs1:{}:class:{}#{}", self.repo, self.rel_path, qualified)
    }
    fn iface_id(&self, name: &str) -> String {
        format!("rs1:{}:iface:{}#{}", self.repo, self.rel_path, name)
    }
    fn enum_id(&self, name: &str) -> String {
        format!("rs1:{}:enum:{}#{}", self.repo, self.rel_path, name)
    }
    fn var_id(&self, qualified: &str) -> String {
        format!("rs1:{}:var:{}#{}", self.repo, self.rel_path, qualified)
    }

    fn push_function(&mut self, node: TsNode, name: &str, scope: &[String], parent_id: &str) {
        let mut qual = scope.to_vec();
        qual.push(name.to_string());
        let qualified = qual.join(".");
        let a = arity(node);
        let id = self.func_id(&qualified, a);
        let id = self.unique(id);
        let span = &self.source[node.byte_range()];
        self.nodes.push(
            Node::new(id.clone(), "Function")
                .set("name", json!(name))
                .set("qualified_name", json!(qualified))
                .set("file_path", json!(self.rel_path))
                .set("start_line", json!(node.start_position().row + 1))
                .set("end_line", json!(node.end_position().row + 1))
                .set("signature", json!(first_line(node, self.source)))
                .set("content_hash", json!(content_hash(span))),
        );
        self.edges
            .push(Edge::new(parent_id.to_string(), "DEFINES", id.clone()));
        if let Some(body) = node.child_by_field_name("body") {
            crate::calls::collect_calls(
                body,
                self.source,
                &id,
                &qualified,
                self.rel_path,
                &mut self.calls,
            );
            self.walk(body, &qual, &id, ScopeKind::Function);
        }
    }

    fn push_variable(
        &mut self,
        name: &str,
        scope: &[String],
        parent_id: &str,
        scope_kind: ScopeKind,
    ) {
        if scope_kind == ScopeKind::Function {
            return; // module/class scope only (PRD §5.1)
        }
        let mut qual = scope.to_vec();
        qual.push(name.to_string());
        let qualified = qual.join(".");
        let kind = if scope_kind == ScopeKind::Class {
            "class"
        } else {
            module_var_kind(name)
        };
        let id = self.var_id(&qualified);
        self.nodes.push(
            Node::new(id.clone(), "Variable")
                .set("name", json!(name))
                .set("file_path", json!(self.rel_path))
                .set("kind", json!(kind)),
        );
        self.edges
            .push(Edge::new(parent_id.to_string(), "DEFINES", id));
    }

    pub fn walk(&mut self, node: TsNode, scope: &[String], parent_id: &str, scope_kind: ScopeKind) {
        let mut cursor = node.walk();
        let children: Vec<TsNode> = node.named_children(&mut cursor).collect();
        for raw in children {
            // Unwrap `export <decl>` and `export default <value>`.
            let child = if raw.kind() == "export_statement" {
                raw.child_by_field_name("declaration")
                    .or_else(|| raw.child_by_field_name("value"))
                    .unwrap_or(raw)
            } else {
                raw
            };
            match child.kind() {
                "function_declaration"
                | "generator_function_declaration"
                | "function_expression" => {
                    // Handles `export default function f(){}` (value field) and
                    // anonymous `export default function(){}` — the latter has
                    // an empty name, so fall back to "default" for a usable id.
                    let n = name_of(child, self.source);
                    let name = if n.is_empty() {
                        "default".to_string()
                    } else {
                        n
                    };
                    self.push_function(child, &name, scope, parent_id);
                }
                "method_definition" => {
                    let name = name_of(child, self.source);
                    self.push_function(child, &name, scope, parent_id);
                }
                "lexical_declaration" | "variable_declaration" => {
                    let mut dc = child.walk();
                    for decl in child.named_children(&mut dc) {
                        if decl.kind() != "variable_declarator" {
                            continue;
                        }
                        let name = name_of(decl, self.source);
                        let is_arrow = decl
                            .child_by_field_name("value")
                            .map(|v| {
                                v.kind() == "arrow_function" || v.kind() == "function_expression"
                            })
                            .unwrap_or(false);
                        if is_arrow {
                            let value = decl.child_by_field_name("value").unwrap();
                            self.push_function(value, &name, scope, parent_id);
                        } else {
                            self.push_variable(&name, scope, parent_id, scope_kind);
                        }
                    }
                }
                "class_declaration" => {
                    let name = name_of(child, self.source);
                    let mut qual = scope.to_vec();
                    qual.push(name.clone());
                    let qualified = qual.join(".");
                    let id = self.class_id(&qualified);
                    let id = self.unique(id);
                    let span = &self.source[child.byte_range()];
                    self.nodes.push(
                        Node::new(id.clone(), "Class")
                            .set("name", json!(name))
                            .set("qualified_name", json!(qualified))
                            .set("file_path", json!(self.rel_path))
                            .set("start_line", json!(child.start_position().row + 1))
                            .set("end_line", json!(child.end_position().row + 1))
                            .set("content_hash", json!(content_hash(span))),
                    );
                    self.edges
                        .push(Edge::new(parent_id.to_string(), "DEFINES", id.clone()));
                    self.declared.insert(qualified.clone(), id.clone());

                    // Heritage: extends → INHERITS, implements → IMPLEMENTS (deferred).
                    let mut hc = child.walk();
                    for h in child.named_children(&mut hc) {
                        if h.kind() == "class_heritage" {
                            let mut cc = h.walk();
                            for clause in h.named_children(&mut cc) {
                                match clause.kind() {
                                    "extends_clause" => {
                                        if let Some(base) = clause.child_by_field_name("value") {
                                            // Use base_type_name to strip generic type args
                                            // e.g. `extends Base<T>` → "Base".
                                            let bn = base_type_name(base, self.source);
                                            if !bn.is_empty() {
                                                self.pending_heritage.push(
                                                    reposkein_core::heritage::PendingHeritage {
                                                        decl_scope: scope.to_vec(),
                                                        from_name: name.clone(),
                                                        edge_type: "INHERITS".to_string(),
                                                        base_name: bn,
                                                    },
                                                );
                                            }
                                        }
                                    }
                                    "implements_clause" => {
                                        let mut ic = clause.walk();
                                        for ty in clause.named_children(&mut ic) {
                                            // Strip type args (e.g. `implements Foo<T>` → "Foo")
                                            let bn = base_type_name(ty, self.source);
                                            if !bn.is_empty() {
                                                self.pending_heritage.push(
                                                    reposkein_core::heritage::PendingHeritage {
                                                        decl_scope: scope.to_vec(),
                                                        from_name: name.clone(),
                                                        edge_type: "IMPLEMENTS".to_string(),
                                                        base_name: bn,
                                                    },
                                                );
                                            }
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    if let Some(body) = child.child_by_field_name("body") {
                        self.walk(body, &qual, &id, ScopeKind::Class);
                    }
                }
                "interface_declaration" => {
                    let name = name_of(child, self.source);
                    let id = self.iface_id(&name);
                    let id = self.unique(id);
                    let span = &self.source[child.byte_range()];
                    self.nodes.push(
                        Node::new(id.clone(), "Interface")
                            .set("name", json!(name))
                            .set("qualified_name", json!(name))
                            .set("file_path", json!(self.rel_path))
                            .set("start_line", json!(child.start_position().row + 1))
                            .set("end_line", json!(child.end_position().row + 1))
                            .set("content_hash", json!(content_hash(span))),
                    );
                    self.declared.insert(name.clone(), id.clone());
                    self.edges
                        .push(Edge::new(parent_id.to_string(), "DEFINES", id));

                    // Heritage: `interface A extends B, C<T>` → INHERITS A→B, A→C.
                    // extends_type_clause is a named child (not a field) of
                    // interface_declaration; its `type` fields are the bases.
                    let mut hc = child.walk();
                    for h in child.named_children(&mut hc) {
                        if h.kind() == "extends_type_clause" {
                            let mut tc = h.walk();
                            for base_ty in h.named_children(&mut tc) {
                                let bn = base_type_name(base_ty, self.source);
                                if !bn.is_empty() {
                                    self.pending_heritage.push(
                                        reposkein_core::heritage::PendingHeritage {
                                            decl_scope: scope.to_vec(),
                                            from_name: name.clone(),
                                            edge_type: "INHERITS".to_string(),
                                            base_name: bn,
                                        },
                                    );
                                }
                            }
                        }
                    }
                }
                "enum_declaration" => {
                    let name = name_of(child, self.source);
                    let id = self.enum_id(&name);
                    let id = self.unique(id);
                    let span = &self.source[child.byte_range()];
                    self.nodes.push(
                        Node::new(id.clone(), "Enum")
                            .set("name", json!(name))
                            .set("qualified_name", json!(name))
                            .set("file_path", json!(self.rel_path))
                            .set("start_line", json!(child.start_position().row + 1))
                            .set("end_line", json!(child.end_position().row + 1))
                            .set("content_hash", json!(content_hash(span))),
                    );
                    self.declared.insert(name.clone(), id.clone());
                    self.edges
                        .push(Edge::new(parent_id.to_string(), "DEFINES", id));
                }
                "public_field_definition" => {
                    let name = name_of(child, self.source);
                    self.push_variable(&name, scope, parent_id, scope_kind);
                }
                _ => {}
            }
        }
    }

    /// Resolves deferred heritage edges (call once after the top-level walk).
    pub fn finalize_heritage(&mut self) {
        let e = reposkein_core::heritage::resolve(&self.pending_heritage, &self.declared);
        self.edges.extend(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn run(src: &[u8]) -> Walk<'_> {
        let tree = parse(src, false).unwrap(); // .ts grammar
        let mut w = Walk::new("r", "m.ts", src);
        w.walk(tree.root_node(), &[], "rs1:r:file:m.ts", ScopeKind::Module);
        w.finalize_heritage();
        w
    }

    #[test]
    fn class_has_content_hash() {
        let w = run(b"class Svc { m() {} }\n");
        let c = w.nodes.iter().find(|n| n.labels == ["Class"]).unwrap();
        assert!(c
            .props
            .get("content_hash")
            .and_then(|v| v.as_str())
            .is_some());
    }

    #[test]
    fn extracts_function_arrow_and_class_method() {
        let src = b"function top(a, b) {}\nconst arrow = (x) => x;\nclass Svc { run(y) {} }\n";
        let w = run(src);
        let ids: Vec<&str> = w.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"rs1:r:func:m.ts#top@2"));
        assert!(ids.contains(&"rs1:r:func:m.ts#arrow@1"));
        assert!(ids.contains(&"rs1:r:class:m.ts#Svc"));
        assert!(ids.contains(&"rs1:r:func:m.ts#Svc.run@1"));
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:class:m.ts#Svc"
            && e.typ == "DEFINES"
            && e.to == "rs1:r:func:m.ts#Svc.run@1"));
    }

    #[test]
    fn extracts_inherits_and_implements() {
        let src =
            b"class Base {}\ninterface Greeter {}\nclass Svc extends Base implements Greeter {}\n";
        let w = run(src);
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:class:m.ts#Svc"
            && e.typ == "INHERITS"
            && e.to == "rs1:r:class:m.ts#Base"));
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:class:m.ts#Svc"
            && e.typ == "IMPLEMENTS"
            && e.to == "rs1:r:iface:m.ts#Greeter"));
    }

    #[test]
    fn duplicate_name_arity_gets_ordinal() {
        let w = run(b"function f(x) {}\nfunction f(y) {}\n");
        let ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Function"])
            .map(|n| n.id.as_str())
            .collect();
        assert!(ids.contains(&"rs1:r:func:m.ts#f@1"));
        assert!(ids.iter().any(|id| id.starts_with("rs1:r:func:m.ts#f@1.")));
    }

    #[test]
    fn arity_counts_typed_optional_params_frozen() {
        // FROZEN @arity contract (PRD §5.3): named children ending in
        // `parameter` (required/optional/rest); types don't count.
        let w = run(b"function freeze2(a: number, b?: string) { return a; }\n");
        let ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Function"])
            .map(|n| n.id.as_str())
            .collect();
        assert!(ids.contains(&"rs1:r:func:m.ts#freeze2@2"));
    }

    #[test]
    fn anonymous_default_export_gets_default_name() {
        let w = run(b"export default function () { return 1; }\n");
        let f = w
            .nodes
            .iter()
            .find(|n| n.labels == ["Function"])
            .expect("anonymous default export → a Function node");
        assert_eq!(f.props["qualified_name"].as_str(), Some("default"));
        assert_eq!(f.id, "rs1:r:func:m.ts#default@0");
    }

    #[test]
    fn nested_namespace_class_inherits_resolves() {
        // A class extending an in-file sibling under a namespace scope.
        let w = run(b"class Base {}\nclass Mid extends Base {}\nclass Leaf extends Mid {}\n");
        let id = |q: &str| {
            w.nodes
                .iter()
                .find(|n| n.props.get("qualified_name").and_then(|v| v.as_str()) == Some(q))
                .map(|n| n.id.clone())
        };
        let leaf = id("Leaf").unwrap();
        let mid = id("Mid").unwrap();
        assert!(w
            .edges
            .iter()
            .any(|e| e.from == leaf && e.typ == "INHERITS" && e.to == mid));
    }

    #[test]
    fn extracts_interface_enum_and_variables() {
        let src = b"interface Greeter { greet(): string; }\nenum Color { Red, Green }\nconst MAX = 5;\nlet name = 'x';\nclass C { label = 'svc'; }\n";
        let w = run(src);
        let find = |id: &str| w.nodes.iter().find(|n| n.id == id);
        assert_eq!(
            find("rs1:r:iface:m.ts#Greeter").unwrap().labels,
            ["Interface"]
        );
        assert_eq!(find("rs1:r:enum:m.ts#Color").unwrap().labels, ["Enum"]);
        let max = find("rs1:r:var:m.ts#MAX").unwrap();
        assert_eq!(max.labels, ["Variable"]);
        assert_eq!(max.props["kind"], json!("const"));
        assert_eq!(
            find("rs1:r:var:m.ts#name").unwrap().props["kind"],
            json!("module")
        );
        assert_eq!(
            find("rs1:r:var:m.ts#C.label").unwrap().props["kind"],
            json!("class")
        );
    }

    #[test]
    fn duplicate_interface_and_enum_get_unique_ids_and_hash() {
        let w = run(b"interface Foo {}\ninterface Foo {}\nenum E {}\nenum E {}\n");
        let iface_ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Interface"])
            .map(|n| n.id.as_str())
            .collect();
        // both interfaces survive with distinct ids (no silent dedup)
        assert_eq!(iface_ids.len(), 2, "both interfaces must survive");
        assert!(iface_ids.contains(&"rs1:r:iface:m.ts#Foo"));
        assert!(iface_ids.contains(&"rs1:r:iface:m.ts#Foo.1"));
        let enum_ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Enum"])
            .map(|n| n.id.as_str())
            .collect();
        assert_eq!(enum_ids.len(), 2);
        assert!(enum_ids.contains(&"rs1:r:enum:m.ts#E"));
        assert!(enum_ids.contains(&"rs1:r:enum:m.ts#E.1"));
        // content_hash present on both kinds
        for n in w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Interface"] || n.labels == ["Enum"])
        {
            assert!(
                n.props
                    .get("content_hash")
                    .and_then(|v| v.as_str())
                    .is_some(),
                "type node {} must carry content_hash",
                n.id
            );
        }
    }

    #[test]
    fn interface_extends_emits_inherits_in_file() {
        // `interface B {} interface A extends B {}` → INHERITS A→B
        let w = run(b"interface B {}\ninterface A extends B {}\n");
        let a = w
            .nodes
            .iter()
            .find(|n| n.id == "rs1:r:iface:m.ts#A")
            .expect("interface A");
        let b = w
            .nodes
            .iter()
            .find(|n| n.id == "rs1:r:iface:m.ts#B")
            .expect("interface B");
        assert!(
            w.edges
                .iter()
                .any(|e| e.from == a.id && e.typ == "INHERITS" && e.to == b.id),
            "A must INHERITS B"
        );
    }

    #[test]
    fn interface_extends_multiple_bases() {
        // `interface A extends B, C {}` → INHERITS A→B, A→C
        let w = run(b"interface B {}\ninterface C {}\ninterface A extends B, C {}\n");
        let a_id = "rs1:r:iface:m.ts#A";
        let b_id = "rs1:r:iface:m.ts#B";
        let c_id = "rs1:r:iface:m.ts#C";
        assert!(w
            .edges
            .iter()
            .any(|e| e.from == a_id && e.typ == "INHERITS" && e.to == b_id));
        assert!(w
            .edges
            .iter()
            .any(|e| e.from == a_id && e.typ == "INHERITS" && e.to == c_id));
    }

    #[test]
    fn class_extends_with_type_args_strips_to_base() {
        // `class Base {} class C extends Base<T> {}` → INHERITS C→Base (not "Base<T>")
        let w = run(b"class Base {}\nclass C extends Base<number> {}\n");
        let c_id = w
            .nodes
            .iter()
            .find(|n| n.props.get("name").and_then(|v| v.as_str()) == Some("C"))
            .map(|n| n.id.clone())
            .expect("class C");
        let base_id = w
            .nodes
            .iter()
            .find(|n| n.props.get("name").and_then(|v| v.as_str()) == Some("Base"))
            .map(|n| n.id.clone())
            .expect("class Base");
        assert!(
            w.edges
                .iter()
                .any(|e| e.from == c_id && e.typ == "INHERITS" && e.to == base_id),
            "C must INHERITS Base (type args stripped)"
        );
    }
}
