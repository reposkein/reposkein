//! Rust definition extraction with stable rs1 ids. structs→Class, traits→
//! Interface, enums→Enum; impl-block methods attribute to their type.

use reposkein_core::hash::content_hash;
use reposkein_core::model::{Edge, Node};
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
}

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn name_of(node: TsNode, source: &[u8]) -> String {
    node.child_by_field_name("name")
        .map(|n| text(n, source).to_string())
        .unwrap_or_default()
}

fn arity(node: TsNode) -> usize {
    let Some(params) = node.child_by_field_name("parameters") else {
        return 0;
    };
    let mut c = params.walk();
    params
        .named_children(&mut c)
        .filter(|n| n.kind() == "parameter" || n.kind() == "self_parameter")
        .count()
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

/// The type_identifier name within an impl `type:` node (handles generic_type).
fn type_name(node: TsNode, source: &[u8]) -> String {
    if node.kind() == "type_identifier" {
        return text(node, source).to_string();
    }
    let mut c = node.walk();
    let children: Vec<TsNode> = node.named_children(&mut c).collect();
    children
        .into_iter()
        .find(|n| n.kind() == "type_identifier")
        .map(|n| text(n, source).to_string())
        .unwrap_or_default()
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
        let id = if *n == 0 {
            base.clone()
        } else {
            format!("{base}.{n}")
        };
        *n += 1;
        id
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

    fn qualified(scope: &[String], name: &str) -> String {
        if scope.is_empty() {
            name.to_string()
        } else {
            format!("{}.{name}", scope.join("."))
        }
    }

    fn push_function(&mut self, node: TsNode, qualified: &str, parent_id: &str) {
        let a = arity(node);
        let id = self.func_id(qualified, a);
        let id = self.unique(id);
        let span = &self.source[node.byte_range()];
        let name = qualified
            .rsplit('.')
            .next()
            .unwrap_or(qualified)
            .to_string();
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
                qualified,
                self.rel_path,
                &mut self.calls,
            );
        }
    }

    fn push_type(&mut self, id: String, label: &str, name: &str, node: TsNode, parent_id: &str) {
        let id = self.unique(id);
        let span = &self.source[node.byte_range()];
        self.nodes.push(
            Node::new(id.clone(), label)
                .set("name", json!(name))
                .set("qualified_name", json!(name))
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
                "function_item" => {
                    let name = name_of(child, self.source);
                    let qualified = Self::qualified(scope, &name);
                    self.push_function(child, &qualified, parent_id);
                }
                "struct_item" => {
                    let name = name_of(child, self.source);
                    let qualified = Self::qualified(scope, &name);
                    let id = self.class_id(&qualified);
                    self.push_type(id, "Class", &qualified, child, parent_id);
                }
                "trait_item" => {
                    let name = name_of(child, self.source);
                    let qualified = Self::qualified(scope, &name);
                    let id = self.iface_id(&qualified);
                    self.push_type(id, "Interface", &qualified, child, parent_id);
                }
                "enum_item" => {
                    let name = name_of(child, self.source);
                    let qualified = Self::qualified(scope, &name);
                    let id = self.enum_id(&qualified);
                    self.push_type(id, "Enum", &qualified, child, parent_id);
                }
                "const_item" | "static_item" => {
                    let name = name_of(child, self.source);
                    let qualified = Self::qualified(scope, &name);
                    let id = self.var_id(&qualified);
                    let kind = if child.kind() == "static_item" {
                        "static"
                    } else {
                        "const"
                    };
                    self.nodes.push(
                        Node::new(id.clone(), "Variable")
                            .set("name", json!(name))
                            .set("file_path", json!(self.rel_path))
                            .set("kind", json!(kind)),
                    );
                    self.edges
                        .push(Edge::new(parent_id.to_string(), "DEFINES", id));
                }
                "impl_item" => {
                    let ty = child
                        .child_by_field_name("type")
                        .map(|n| type_name(n, self.source))
                        .unwrap_or_default();
                    if ty.is_empty() {
                        continue;
                    }
                    let qualified_ty = Self::qualified(scope, &ty);
                    let class_id = self.class_id(&qualified_ty);
                    // Trait impl → IMPLEMENTS.
                    if let Some(tr) = child.child_by_field_name("trait") {
                        let trait_name = type_name(tr, self.source);
                        if !trait_name.is_empty() {
                            let qualified_trait = Self::qualified(scope, &trait_name);
                            self.edges.push(Edge::new(
                                class_id.clone(),
                                "IMPLEMENTS",
                                self.iface_id(&qualified_trait),
                            ));
                        }
                    }
                    // Methods attribute to the type.
                    if let Some(body) = child.child_by_field_name("body") {
                        let mut bc = body.walk();
                        let methods: Vec<TsNode> = body.named_children(&mut bc).collect();
                        for m in methods {
                            if m.kind() == "function_item" {
                                let mname = name_of(m, self.source);
                                let qualified = format!("{qualified_ty}.{mname}");
                                self.push_function(m, &qualified, &class_id);
                            }
                        }
                    }
                }
                "mod_item" => {
                    let name = name_of(child, self.source);
                    if let Some(body) = child.child_by_field_name("body") {
                        let mut s = scope.to_vec();
                        s.push(name);
                        self.walk_scoped(body, parent_id, &s);
                    }
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
        let tree = parse(src).unwrap();
        let mut w = Walk::new("r", "m.rs", src);
        w.walk(tree.root_node(), "rs1:r:file:m.rs");
        w
    }

    #[test]
    fn struct_has_content_hash() {
        let w = run(b"struct Service { label: String }\n");
        let c = w.nodes.iter().find(|n| n.labels == ["Class"]).unwrap();
        assert!(c
            .props
            .get("content_hash")
            .and_then(|v| v.as_str())
            .is_some());
    }

    #[test]
    fn impl_methods_attribute_to_type_and_trait_impl_implements() {
        let src = b"struct Service;\ntrait Greeter {}\nimpl Service { fn run(&self, x: u32) -> u32 { x } }\nimpl Greeter for Service { fn greet(&self) {} }\n";
        let w = run(src);
        // Method run is qualified Service.run, DEFINES from the Service class node.
        let m = w
            .nodes
            .iter()
            .find(|n| n.props.get("qualified_name") == Some(&json!("Service.run")))
            .unwrap();
        assert_eq!(m.id, "rs1:r:func:m.rs#Service.run@2"); // &self + x
        assert!(w
            .edges
            .iter()
            .any(|e| e.from == "rs1:r:class:m.rs#Service" && e.typ == "DEFINES" && e.to == m.id));
        // greet from the trait impl, also under Service.
        assert!(w
            .nodes
            .iter()
            .any(|n| n.props.get("qualified_name") == Some(&json!("Service.greet"))));
        // Service IMPLEMENTS Greeter.
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:class:m.rs#Service"
            && e.typ == "IMPLEMENTS"
            && e.to == "rs1:r:iface:m.rs#Greeter"));
    }

    #[test]
    fn duplicate_name_arity_gets_ordinal() {
        // Two free fns same name+arity (e.g. behind cfg) — rare but must not collide.
        let w = run(b"fn f(x: u32) {}\nfn f(y: u32) {}\n");
        let ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Function"])
            .map(|n| n.id.as_str())
            .collect();
        assert!(ids.contains(&"rs1:r:func:m.rs#f@1"));
        assert!(ids.iter().any(|id| id.starts_with("rs1:r:func:m.rs#f@1.")));
    }

    #[test]
    fn extracts_module_items() {
        let src = b"fn helper(x: u32) -> u32 { x }\nstruct Service { label: String }\ntrait Greeter {}\nenum Color { Red }\nconst MAX: u32 = 5;\n";
        let w = run(src);
        let find = |id: &str| w.nodes.iter().find(|n| n.id == id);
        assert_eq!(
            find("rs1:r:func:m.rs#helper@1").unwrap().labels,
            ["Function"]
        );
        assert_eq!(find("rs1:r:class:m.rs#Service").unwrap().labels, ["Class"]);
        assert_eq!(
            find("rs1:r:iface:m.rs#Greeter").unwrap().labels,
            ["Interface"]
        );
        assert_eq!(find("rs1:r:enum:m.rs#Color").unwrap().labels, ["Enum"]);
        assert_eq!(
            find("rs1:r:var:m.rs#MAX").unwrap().props["kind"],
            json!("const")
        );
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:file:m.rs"
            && e.typ == "DEFINES"
            && e.to == "rs1:r:class:m.rs#Service"));
    }

    #[test]
    fn descends_into_inline_modules() {
        let src = b"mod util {\n    pub fn helper() {}\n    struct Inner;\n}\n#[cfg(test)]\nmod tests {\n    fn it_works() {}\n}\n";
        let w = run(src);
        let ids: Vec<&str> = w.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"rs1:r:func:m.rs#util.helper@0"), "fn in mod");
        assert!(
            ids.contains(&"rs1:r:class:m.rs#util.Inner"),
            "struct in mod"
        );
        assert!(
            ids.contains(&"rs1:r:func:m.rs#tests.it_works@0"),
            "fn in #[cfg(test)] mod"
        );
    }
}
