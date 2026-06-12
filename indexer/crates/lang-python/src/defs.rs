//! Definition extraction: walks the CST building Function/Class/Variable
//! nodes and DEFINES/INHERITS edges with stable rs1 ids (PRD §5.3).

use reposkein_core::hash::content_hash;
use reposkein_core::model::{Edge, Node};
use serde_json::json;
use tree_sitter::Node as TsNode;

/// A definition discovered during the walk, with enough info to build a Node
/// and the DEFINES edge from its parent scope.
pub struct Walk<'a> {
    repo: &'a str,
    rel_path: &'a str,
    file_id: &'a str,
    source: &'a [u8],
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

/// Number of positional/keyword parameters (the @arity disambiguator).
fn param_arity(func: TsNode) -> usize {
    let Some(params) = func.child_by_field_name("parameters") else {
        return 0;
    };
    let mut cursor = params.walk();
    params
        .named_children(&mut cursor)
        .filter(|c| c.kind() != "comment")
        .count()
}

impl<'a> Walk<'a> {
    pub fn new(repo: &'a str, rel_path: &'a str, file_id: &'a str, source: &'a [u8]) -> Self {
        Walk {
            repo,
            rel_path,
            file_id,
            source,
            nodes: Vec::new(),
            edges: Vec::new(),
        }
    }

    /// Builds the rs1 id for a function given its qualified name and arity.
    fn func_id(&self, qualified: &str, arity: usize) -> String {
        format!(
            "rs1:{}:func:{}#{}@{}",
            self.repo, self.rel_path, qualified, arity
        )
    }

    /// Recursively walk `node` with the given scope stack (enclosing
    /// class/function names) and parent node id (File or Class/Function id).
    pub fn walk(&mut self, node: TsNode, scope: &[String], parent_id: &str) {
        let mut cursor = node.walk();
        let children: Vec<TsNode> = node.named_children(&mut cursor).collect();
        for child in children {
            match child.kind() {
                "function_definition" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    let mut qual = scope.to_vec();
                    qual.push(name.clone());
                    let qualified = qual.join(".");
                    let arity = param_arity(child);
                    let id = self.func_id(&qualified, arity);

                    let span = &self.source[child.byte_range()];
                    let signature = text(child, self.source)
                        .lines()
                        .next()
                        .unwrap_or("")
                        .trim_end_matches(':')
                        .trim()
                        .to_string();

                    self.nodes.push(
                        Node::new(id.clone(), "Function")
                            .set("name", json!(name))
                            .set("qualified_name", json!(qualified))
                            .set("file_path", json!(self.rel_path))
                            .set("start_line", json!(child.start_position().row + 1))
                            .set("end_line", json!(child.end_position().row + 1))
                            .set("signature", json!(signature))
                            .set("content_hash", json!(content_hash(span))),
                    );
                    self.edges
                        .push(Edge::new(parent_id.to_string(), "DEFINES", id.clone()));

                    // Recurse into the function body for nested defs/classes.
                    if let Some(body) = child.child_by_field_name("body") {
                        self.walk(body, &qual, &id);
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
        // Leak nothing: build a Walk borrowing the inputs, walk the root.
        let mut w = Walk::new("r", "m.py", "rs1:r:file:m.py", src);
        w.walk(tree.root_node(), &[], "rs1:r:file:m.py");
        w
    }

    #[test]
    fn extracts_top_level_function() {
        let src = b"def foo(a, b):\n    return a + b\n";
        let w = run(src);
        let f = w.nodes.iter().find(|n| n.labels == ["Function"]).unwrap();
        assert_eq!(f.id, "rs1:r:func:m.py#foo@2");
        assert_eq!(f.props["qualified_name"], json!("foo"));
        assert_eq!(f.props["signature"], json!("def foo(a, b)"));
        assert!(w
            .edges
            .iter()
            .any(|e| e.from == "rs1:r:file:m.py" && e.typ == "DEFINES" && e.to == f.id));
    }
}
