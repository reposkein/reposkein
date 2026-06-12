//! TypeScript definition extraction with stable rs1 ids.

use reposkein_core::hash::content_hash;
use reposkein_core::model::{Edge, Node};
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
}

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

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
        }
    }

    /// Returns a per-file-unique id: base for the first occurrence, then
    /// base.1, base.2, … for collisions (PRD §5.3 ordinal disambiguation).
    fn unique(&mut self, base: String) -> String {
        let n = self.used.entry(base.clone()).or_insert(0);
        let id = if *n == 0 { base.clone() } else { format!("{base}.{n}") };
        *n += 1;
        id
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
        } else if name.chars().all(|c| c.is_ascii_uppercase() || c == '_')
            && name.chars().any(|c| c.is_ascii_uppercase())
        {
            "const"
        } else {
            "module"
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
            // Unwrap `export <decl>`.
            let child = if raw.kind() == "export_statement" {
                raw.child_by_field_name("declaration").unwrap_or(raw)
            } else {
                raw
            };
            match child.kind() {
                "function_declaration" => {
                    let name = name_of(child, self.source);
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

                    // Heritage: extends → INHERITS, implements → IMPLEMENTS (intra-file).
                    let mut hc = child.walk();
                    for h in child.named_children(&mut hc) {
                        if h.kind() == "class_heritage" {
                            let mut cc = h.walk();
                            for clause in h.named_children(&mut cc) {
                                match clause.kind() {
                                    "extends_clause" => {
                                        if let Some(base) = clause.child_by_field_name("value") {
                                            let base_name = text(base, self.source);
                                            self.edges.push(Edge::new(
                                                id.clone(),
                                                "INHERITS",
                                                self.class_id(base_name),
                                            ));
                                        }
                                    }
                                    "implements_clause" => {
                                        let mut ic = clause.walk();
                                        for ty in clause.named_children(&mut ic) {
                                            if ty.kind() == "type_identifier" {
                                                let iname = text(ty, self.source);
                                                self.edges.push(Edge::new(
                                                    id.clone(),
                                                    "IMPLEMENTS",
                                                    format!(
                                                        "rs1:{}:iface:{}#{}",
                                                        self.repo, self.rel_path, iname
                                                    ),
                                                ));
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
                    self.nodes.push(
                        Node::new(id.clone(), "Interface")
                            .set("name", json!(name))
                            .set("qualified_name", json!(name))
                            .set("file_path", json!(self.rel_path))
                            .set("start_line", json!(child.start_position().row + 1))
                            .set("end_line", json!(child.end_position().row + 1)),
                    );
                    self.edges
                        .push(Edge::new(parent_id.to_string(), "DEFINES", id));
                }
                "enum_declaration" => {
                    let name = name_of(child, self.source);
                    let id = self.enum_id(&name);
                    self.nodes.push(
                        Node::new(id.clone(), "Enum")
                            .set("name", json!(name))
                            .set("qualified_name", json!(name))
                            .set("file_path", json!(self.rel_path))
                            .set("start_line", json!(child.start_position().row + 1))
                            .set("end_line", json!(child.end_position().row + 1)),
                    );
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn run(src: &[u8]) -> Walk<'_> {
        let tree = parse(src, false).unwrap(); // .ts grammar
        let mut w = Walk::new("r", "m.ts", src);
        w.walk(tree.root_node(), &[], "rs1:r:file:m.ts", ScopeKind::Module);
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
        let ids: Vec<&str> = w.nodes.iter().filter(|n| n.labels == ["Function"]).map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"rs1:r:func:m.ts#f@1"));
        assert!(ids.iter().any(|id| id.starts_with("rs1:r:func:m.ts#f@1.")));
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
}
