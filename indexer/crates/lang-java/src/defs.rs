//! Java definition extraction with stable rs1 ids.
//! class→Class, interface→Interface, enum→Enum; methods as Class.method;
//! constructors as Class.<init>; fields as Variable. FROZEN @arity rule
//! documented in reposkein_core::id.

use reposkein_core::hash::content_hash;
use reposkein_core::model::{Edge, Node};
use reposkein_lang_common::{module_var_kind, text, unique};
use serde_json::json;
use std::collections::HashMap;
use tree_sitter::Node as TsNode;

pub struct Walk<'a> {
    repo: &'a str,
    rel_path: &'a str,
    source: &'a [u8],
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub calls: Vec<reposkein_core::extractor::RawCall>,
    used: HashMap<String, u32>,
    declared: HashMap<String, String>,
    pending_heritage: Vec<reposkein_core::heritage::PendingHeritage>,
    pub heritage: Vec<reposkein_core::extractor::RawHeritage>,
    pub constructions: Vec<reposkein_core::extractor::RawConstruction>,
}

/// Java `@arity` — FROZEN. See `reposkein_core::id` for the contract.
///
/// Count named children of `formal_parameters` of kind `formal_parameter` or
/// `spread_parameter`. `receiver_parameter` is excluded. Generics in a param
/// type count as 1. A varargs `spread_parameter` counts as 1.
fn arity(node: TsNode) -> usize {
    let Some(params) = node.child_by_field_name("parameters") else {
        return 0;
    };
    let mut c = params.walk();
    params
        .named_children(&mut c)
        .filter(|n| matches!(n.kind(), "formal_parameter" | "spread_parameter"))
        .count()
}

/// Extract the simple type identifier from a type node (strips generics).
fn strip_to_type_identifier(ty: TsNode, src: &[u8]) -> String {
    if ty.kind() == "type_identifier" {
        return text(ty, src).to_string();
    }
    let mut c = ty.walk();
    let children: Vec<TsNode> = ty.named_children(&mut c).collect();
    children
        .into_iter()
        .find(|n| n.kind() == "type_identifier")
        .map(|n| text(n, src).to_string())
        .unwrap_or_default()
}

fn first_line(node: TsNode, source: &[u8]) -> String {
    text(node, source)
        .lines()
        .next()
        .unwrap_or("")
        .trim_end_matches('{')
        .trim()
        .to_string()
}

fn qualified(scope: &[String], name: &str) -> String {
    if scope.is_empty() {
        name.to_string()
    } else {
        format!("{}.{name}", scope.join("."))
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
            declared: HashMap::new(),
            pending_heritage: Vec::new(),
            heritage: Vec::new(),
            constructions: Vec::new(),
        }
    }

    fn unique(&mut self, base: String) -> String {
        unique(&mut self.used, base)
    }

    fn func_id(&self, qualified: &str, arity: usize) -> String {
        format!(
            "rs1:{}:func:{}#{}@{}",
            self.repo, self.rel_path, qualified, arity
        )
    }
    fn class_id(&self, name: &str) -> String {
        format!("rs1:{}:class:{}#{}", self.repo, self.rel_path, name)
    }
    fn iface_id(&self, name: &str) -> String {
        format!("rs1:{}:iface:{}#{}", self.repo, self.rel_path, name)
    }
    fn enum_id(&self, name: &str) -> String {
        format!("rs1:{}:enum:{}#{}", self.repo, self.rel_path, name)
    }
    fn var_id(&self, name: &str) -> String {
        format!("rs1:{}:var:{}#{}", self.repo, self.rel_path, name)
    }

    fn push_function(&mut self, node: TsNode, qual: &str, parent_id: &str) {
        let a = arity(node);
        let id = self.func_id(qual, a);
        let id = self.unique(id);
        let span = &self.source[node.byte_range()];
        let name = qual.rsplit('.').next().unwrap_or(qual).to_string();
        self.nodes.push(
            Node::new(id.clone(), "Function")
                .set("name", json!(name))
                .set("qualified_name", json!(qual))
                .set("file_path", json!(self.rel_path))
                .set("start_line", json!(node.start_position().row + 1))
                .set("end_line", json!(node.end_position().row + 1))
                .set("signature", json!(first_line(node, self.source)))
                .set("content_hash", json!(content_hash(span))),
        );
        self.edges
            .push(Edge::new(parent_id.to_string(), "DEFINES", id.clone()));
        if let Some(body) = node.child_by_field_name("body") {
            let caller_file_id = reposkein_core::id::file_id(self.repo, self.rel_path);
            crate::calls::collect_calls(
                body,
                self.source,
                &id,
                qual,
                self.rel_path,
                &caller_file_id,
                &mut self.calls,
                &mut self.constructions,
            );
        }
    }

    fn push_type(&mut self, id: String, label: &str, qual: &str, node: TsNode, parent_id: &str) {
        let id = self.unique(id);
        let simple = qual.rsplit('.').next().unwrap_or(qual);
        self.declared.insert(qual.to_string(), id.clone());
        // Also insert simple name for top-level types (no dot in qualified).
        if !qual.contains('.') {
            self.declared
                .entry(simple.to_string())
                .or_insert(id.clone());
        }
        let span = &self.source[node.byte_range()];
        self.nodes.push(
            Node::new(id.clone(), label)
                .set("name", json!(simple))
                .set("qualified_name", json!(qual))
                .set("file_path", json!(self.rel_path))
                .set("start_line", json!(node.start_position().row + 1))
                .set("end_line", json!(node.end_position().row + 1))
                .set("content_hash", json!(content_hash(span))),
        );
        self.edges
            .push(Edge::new(parent_id.to_string(), "DEFINES", id));
    }

    pub fn walk(&mut self, node: TsNode, parent_id: &str) {
        self.walk_scoped(node, parent_id, &[]);
    }

    fn walk_scoped(&mut self, node: TsNode, parent_id: &str, scope: &[String]) {
        let mut cursor = node.walk();
        let children: Vec<TsNode> = node.named_children(&mut cursor).collect();
        for child in children {
            match child.kind() {
                "class_declaration" | "record_declaration" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let qual = qualified(scope, &name);
                    let id = self.class_id(&qual);
                    self.push_type(id, "Class", &qual, child, parent_id);
                    // Heritage: superclass (extends)
                    if let Some(sc) = child.child_by_field_name("superclass") {
                        let base = strip_to_type_identifier(sc, self.source);
                        if !base.is_empty() {
                            self.pending_heritage
                                .push(reposkein_core::heritage::PendingHeritage {
                                    decl_scope: scope.to_vec(),
                                    from_name: name.clone(),
                                    edge_type: "INHERITS".to_string(),
                                    base_name: base,
                                });
                        }
                    }
                    // Heritage: interfaces (implements)
                    if let Some(ifaces) = child.child_by_field_name("interfaces") {
                        self.collect_type_list_heritage(&ifaces, &name, scope, "IMPLEMENTS");
                    }
                    // Recurse into body
                    let type_id = self
                        .declared
                        .get(&qual)
                        .cloned()
                        .unwrap_or_else(|| parent_id.to_string());
                    let mut new_scope = scope.to_vec();
                    new_scope.push(name);
                    if let Some(body) = child.child_by_field_name("body") {
                        self.walk_scoped(body, &type_id, &new_scope);
                    }
                }
                "interface_declaration" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let qual = qualified(scope, &name);
                    let id = self.iface_id(&qual);
                    self.push_type(id, "Interface", &qual, child, parent_id);
                    // Heritage: extends_interfaces
                    if let Some(ext) = child.child_by_field_name("extends_interfaces") {
                        self.collect_type_list_heritage(&ext, &name, scope, "INHERITS");
                    }
                    let type_id = self
                        .declared
                        .get(&qual)
                        .cloned()
                        .unwrap_or_else(|| parent_id.to_string());
                    let mut new_scope = scope.to_vec();
                    new_scope.push(name);
                    if let Some(body) = child.child_by_field_name("body") {
                        self.walk_scoped(body, &type_id, &new_scope);
                    }
                }
                "enum_declaration" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let qual = qualified(scope, &name);
                    let id = self.enum_id(&qual);
                    self.push_type(id, "Enum", &qual, child, parent_id);
                    // Heritage: interfaces (implements)
                    if let Some(ifaces) = child.child_by_field_name("interfaces") {
                        self.collect_type_list_heritage(&ifaces, &name, scope, "IMPLEMENTS");
                    }
                    let type_id = self
                        .declared
                        .get(&qual)
                        .cloned()
                        .unwrap_or_else(|| parent_id.to_string());
                    let mut new_scope = scope.to_vec();
                    new_scope.push(name);
                    if let Some(body) = child.child_by_field_name("body") {
                        self.walk_scoped(body, &type_id, &new_scope);
                    }
                }
                "method_declaration" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let qual = qualified(scope, &name);
                    self.push_function(child, &qual, parent_id);
                }
                "constructor_declaration" => {
                    let qual = qualified(scope, "<init>");
                    self.push_function(child, &qual, parent_id);
                }
                "field_declaration" => {
                    let mut dc = child.walk();
                    let declarators: Vec<TsNode> = child
                        .children_by_field_name("declarator", &mut dc)
                        .collect();
                    for decl in declarators {
                        if let Some(name_node) = decl.child_by_field_name("name") {
                            let name = text(name_node, self.source).to_string();
                            let qual = qualified(scope, &name);
                            let id = self.var_id(&qual);
                            let id = self.unique(id);
                            let kind = module_var_kind(&name);
                            self.nodes.push(
                                Node::new(id.clone(), "Variable")
                                    .set("name", json!(name))
                                    .set("qualified_name", json!(qual))
                                    .set("file_path", json!(self.rel_path))
                                    .set("kind", json!(kind)),
                            );
                            self.edges
                                .push(Edge::new(parent_id.to_string(), "DEFINES", id));
                        }
                    }
                }
                "enum_constant" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    if name.is_empty() {
                        continue;
                    }
                    let qual = qualified(scope, &name);
                    let id = self.var_id(&qual);
                    let id = self.unique(id);
                    self.nodes.push(
                        Node::new(id.clone(), "Variable")
                            .set("name", json!(name))
                            .set("qualified_name", json!(qual))
                            .set("file_path", json!(self.rel_path))
                            .set("kind", json!("enum_constant")),
                    );
                    self.edges
                        .push(Edge::new(parent_id.to_string(), "DEFINES", id));
                }
                // Recurse into body containers without changing scope/parent
                "class_body" | "interface_body" | "enum_body" | "enum_body_declarations" => {
                    self.walk_scoped(child, parent_id, scope);
                }
                _ => {}
            }
        }
    }

    /// Collect type references from a type list node (super_interfaces, etc.)
    /// and push PendingHeritage entries.
    fn collect_type_list_heritage(
        &mut self,
        node: &TsNode,
        from_name: &str,
        scope: &[String],
        edge_type: &str,
    ) {
        let mut c = node.walk();
        for child in node.named_children(&mut c) {
            match child.kind() {
                "type_identifier" | "generic_type" => {
                    let base = strip_to_type_identifier(child, self.source);
                    if !base.is_empty() {
                        self.pending_heritage
                            .push(reposkein_core::heritage::PendingHeritage {
                                decl_scope: scope.to_vec(),
                                from_name: from_name.to_string(),
                                edge_type: edge_type.to_string(),
                                base_name: base,
                            });
                    }
                }
                // type_list node contains type_identifier children
                "type_list" | "interface_type_list" => {
                    let mut tc = child.walk();
                    for ty in child.named_children(&mut tc) {
                        let base = strip_to_type_identifier(ty, self.source);
                        if !base.is_empty() {
                            self.pending_heritage
                                .push(reposkein_core::heritage::PendingHeritage {
                                    decl_scope: scope.to_vec(),
                                    from_name: from_name.to_string(),
                                    edge_type: edge_type.to_string(),
                                    base_name: base,
                                });
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Lowers pending heritage → RawHeritage (from-side resolved in-file; base
    /// resolved repo-wide by core::resolve). Call once after the top-level walk.
    pub fn lower_heritage(&mut self) {
        let from_file_id = reposkein_core::id::file_id(self.repo, self.rel_path);
        let mut raw = reposkein_core::heritage::lower(
            &self.pending_heritage,
            &self.declared,
            self.rel_path,
            &from_file_id,
            false,
        );
        self.heritage.append(&mut raw);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn run(src: &[u8]) -> Walk<'_> {
        let tree = parse(src).unwrap();
        let mut w = Walk::new("r", "a/b/Svc.java", src);
        w.walk(tree.root_node(), "rs1:r:file:a/b/Svc.java");
        w.lower_heritage();
        w
    }

    #[test]
    fn arity_rule_frozen() {
        // FROZEN Java @arity (plan §2): count formal_parameter + spread_parameter;
        // receiver_parameter excluded; generics in param type count as 1;
        // a varargs spread_parameter counts as exactly 1.
        let w = run(b"package a.b;\nclass Svc {\n void m0() {}\n void m1(int a) {}\n void m2(int a, String b) {}\n void mv(String... xs) {}\n <T> void mg(T a, int b) {}\n}\n");
        let ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Function"])
            .map(|n| n.id.as_str())
            .collect();
        assert!(ids.contains(&"rs1:r:func:a/b/Svc.java#Svc.m0@0"));
        assert!(ids.contains(&"rs1:r:func:a/b/Svc.java#Svc.m1@1"));
        assert!(ids.contains(&"rs1:r:func:a/b/Svc.java#Svc.m2@2"));
        assert!(
            ids.contains(&"rs1:r:func:a/b/Svc.java#Svc.mv@1"),
            "varargs-only method: spread_parameter counts as exactly 1"
        );
        assert!(
            ids.contains(&"rs1:r:func:a/b/Svc.java#Svc.mg@2"),
            "generic method: type parameter <T> excluded from arity, 2 formal params"
        );
    }

    #[test]
    fn class_interface_enum_extracted() {
        let w = run(b"package p;\nclass C {}\ninterface I {}\nenum E { A, B }\n");
        assert!(w
            .nodes
            .iter()
            .any(|n| n.labels == ["Class"] && n.id == "rs1:r:class:a/b/Svc.java#C"));
        assert!(w
            .nodes
            .iter()
            .any(|n| n.labels == ["Interface"] && n.id == "rs1:r:iface:a/b/Svc.java#I"));
        assert!(w
            .nodes
            .iter()
            .any(|n| n.labels == ["Enum"] && n.id == "rs1:r:enum:a/b/Svc.java#E"));
        // Enum constants become Variable nodes
        assert!(w.nodes.iter().any(|n| n.labels == ["Variable"]
            && n.props.get("name").and_then(|v| v.as_str()) == Some("A")
            && n.props.get("kind").and_then(|v| v.as_str()) == Some("enum_constant")));
    }

    #[test]
    fn constructor_qualified_as_init() {
        let w = run(b"package p;\nclass Foo { Foo(int x) {} }\n");
        let ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Function"])
            .map(|n| n.id.as_str())
            .collect();
        assert!(
            ids.contains(&"rs1:r:func:a/b/Svc.java#Foo.<init>@1"),
            "constructor qualified as <scope>.<init>"
        );
    }

    #[test]
    fn field_becomes_variable() {
        let w = run(
            b"package p;\nclass Svc { private int count; public static final int MAX = 10; }\n",
        );
        assert!(w.nodes.iter().any(|n| n.labels == ["Variable"]
            && n.props.get("name").and_then(|v| v.as_str()) == Some("count")));
        assert!(w.nodes.iter().any(|n| n.labels == ["Variable"]
            && n.props.get("name").and_then(|v| v.as_str()) == Some("MAX")));
    }

    #[test]
    fn types_methods_ctor_fields_heritage() {
        // Plan-required test covering all node kinds and heritage in one shot.
        let w = run(b"package a.b;\ninterface Greeter {}\nclass Base {}\nclass Svc extends Base implements Greeter {\n Svc() {}\n int x;\n void run() {}\n}\n");
        let ids: Vec<&str> = w.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"rs1:r:class:a/b/Svc.java#Svc"));
        assert!(ids.contains(&"rs1:r:iface:a/b/Svc.java#Greeter"));
        assert!(
            ids.contains(&"rs1:r:func:a/b/Svc.java#Svc.<init>@0"),
            "constructor qualified as <ClassName>.<init>"
        );
        assert!(ids.contains(&"rs1:r:func:a/b/Svc.java#Svc.run@0"));
        assert!(w.nodes.iter().any(|n| n.labels == ["Variable"]
            && n.props.get("name").and_then(|v| v.as_str()) == Some("x")));
        assert!(
            w.heritage
                .iter()
                .any(|h| h.edge_type == "INHERITS" && h.base_name == "Base"),
            "Svc INHERITS Base"
        );
        assert!(
            w.heritage
                .iter()
                .any(|h| h.edge_type == "IMPLEMENTS" && h.base_name == "Greeter"),
            "Svc IMPLEMENTS Greeter"
        );
    }

    #[test]
    fn heritage_inherits_and_implements() {
        let w = run(
            b"package p;\ninterface Base {}\ninterface Extra {}\nclass Outer {}\nclass Child extends Outer implements Base, Extra {}\n",
        );
        // Child IMPLEMENTS Base
        assert!(w
            .heritage
            .iter()
            .any(|h| h.edge_type == "IMPLEMENTS" && h.base_name == "Base"));
        // Child IMPLEMENTS Extra
        assert!(w
            .heritage
            .iter()
            .any(|h| h.edge_type == "IMPLEMENTS" && h.base_name == "Extra"));
        // Child INHERITS Outer
        assert!(w
            .heritage
            .iter()
            .any(|h| h.edge_type == "INHERITS" && h.base_name == "Outer"));
    }

    #[test]
    fn function_has_content_hash_and_defines_edge() {
        let w = run(b"package p;\nclass Svc { void run() {} }\n");
        let f = w.nodes.iter().find(|n| n.labels == ["Function"]).unwrap();
        assert!(f
            .props
            .get("content_hash")
            .and_then(|v| v.as_str())
            .is_some());
        assert!(w
            .edges
            .iter()
            .any(|e| e.typ == "DEFINES" && e.to == "rs1:r:func:a/b/Svc.java#Svc.run@0"));
    }

    #[test]
    fn extraction_is_deterministic() {
        let src = b"package p;\nclass Svc { private int x; void run(int a) { foo(); } }\n";
        let a = run(src);
        let b = run(src);
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
        assert_eq!(a.calls, b.calls);
    }
}
