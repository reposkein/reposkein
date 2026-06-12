//! Rust definition extraction with stable rs1 ids. structs→Class, traits→
//! Interface, enums→Enum; impl-block methods attribute to their type.

use reposkein_core::hash::content_hash;
use reposkein_core::model::{Edge, Node};
use serde_json::json;
use tree_sitter::Node as TsNode;

pub struct Walk<'a> {
    repo: &'a str,
    rel_path: &'a str,
    source: &'a [u8],
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

fn name_of(node: TsNode, source: &[u8]) -> String {
    node.child_by_field_name("name").map(|n| text(n, source).to_string()).unwrap_or_default()
}

fn arity(node: TsNode) -> usize {
    let Some(params) = node.child_by_field_name("parameters") else { return 0 };
    let mut c = params.walk();
    params
        .named_children(&mut c)
        .filter(|n| n.kind() == "parameter" || n.kind() == "self_parameter")
        .count()
}

fn first_line(node: TsNode, source: &[u8]) -> String {
    text(node, source).lines().next().unwrap_or("").trim_end_matches('{').trim().to_string()
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
        Walk { repo, rel_path, source, nodes: Vec::new(), edges: Vec::new() }
    }

    fn func_id(&self, qualified: &str, arity: usize) -> String {
        format!("rs1:{}:func:{}#{}@{}", self.repo, self.rel_path, qualified, arity)
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

    fn push_function(&mut self, node: TsNode, qualified: &str, parent_id: &str) {
        let a = arity(node);
        let id = self.func_id(qualified, a);
        let span = &self.source[node.byte_range()];
        let name = qualified.rsplit('.').next().unwrap_or(qualified).to_string();
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
        self.edges.push(Edge::new(parent_id.to_string(), "DEFINES", id));
    }

    fn push_type(&mut self, id: String, label: &str, name: &str, node: TsNode, parent_id: &str) {
        self.nodes.push(
            Node::new(id.clone(), label)
                .set("name", json!(name))
                .set("qualified_name", json!(name))
                .set("file_path", json!(self.rel_path))
                .set("start_line", json!(node.start_position().row + 1))
                .set("end_line", json!(node.end_position().row + 1)),
        );
        self.edges.push(Edge::new(parent_id.to_string(), "DEFINES", id));
    }

    pub fn walk(&mut self, node: TsNode, parent_id: &str) {
        let mut cursor = node.walk();
        let children: Vec<TsNode> = node.named_children(&mut cursor).collect();
        for child in children {
            match child.kind() {
                "function_item" => {
                    let name = name_of(child, self.source);
                    self.push_function(child, &name, parent_id);
                }
                "struct_item" => {
                    let name = name_of(child, self.source);
                    let id = self.class_id(&name);
                    self.push_type(id, "Class", &name, child, parent_id);
                }
                "trait_item" => {
                    let name = name_of(child, self.source);
                    let id = self.iface_id(&name);
                    self.push_type(id, "Interface", &name, child, parent_id);
                }
                "enum_item" => {
                    let name = name_of(child, self.source);
                    let id = self.enum_id(&name);
                    self.push_type(id, "Enum", &name, child, parent_id);
                }
                "const_item" | "static_item" => {
                    let name = name_of(child, self.source);
                    let id = self.var_id(&name);
                    let kind = if child.kind() == "static_item" { "static" } else { "const" };
                    self.nodes.push(
                        Node::new(id.clone(), "Variable")
                            .set("name", json!(name))
                            .set("file_path", json!(self.rel_path))
                            .set("kind", json!(kind)),
                    );
                    self.edges.push(Edge::new(parent_id.to_string(), "DEFINES", id));
                }
                // impl_item handled in Task 3
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
    fn extracts_module_items() {
        let src = b"fn helper(x: u32) -> u32 { x }\nstruct Service { label: String }\ntrait Greeter {}\nenum Color { Red }\nconst MAX: u32 = 5;\n";
        let w = run(src);
        let find = |id: &str| w.nodes.iter().find(|n| n.id == id);
        assert_eq!(find("rs1:r:func:m.rs#helper@1").unwrap().labels, ["Function"]);
        assert_eq!(find("rs1:r:class:m.rs#Service").unwrap().labels, ["Class"]);
        assert_eq!(find("rs1:r:iface:m.rs#Greeter").unwrap().labels, ["Interface"]);
        assert_eq!(find("rs1:r:enum:m.rs#Color").unwrap().labels, ["Enum"]);
        assert_eq!(find("rs1:r:var:m.rs#MAX").unwrap().props["kind"], json!("const"));
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:file:m.rs" && e.typ == "DEFINES" && e.to == "rs1:r:class:m.rs#Service"));
    }
}
