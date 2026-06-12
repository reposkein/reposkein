//! Definition extraction: walks the CST building Function/Class/Variable
//! nodes and DEFINES/INHERITS edges with stable rs1 ids (PRD §5.3).

use reposkein_core::hash::content_hash;
use reposkein_core::model::{Edge, Node};
use serde_json::json;
use tree_sitter::Node as TsNode;

#[derive(Clone, Copy, PartialEq)]
pub enum ScopeKind {
    Module,
    Class,
    Function,
}

/// A definition discovered during the walk, with enough info to build a Node
/// and the DEFINES edge from its parent scope.
pub struct Walk<'a> {
    repo: &'a str,
    rel_path: &'a str,
    _file_id: &'a str,
    source: &'a [u8],
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub calls: Vec<reposkein_core::extractor::RawCall>,
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
            _file_id: file_id,
            source,
            nodes: Vec::new(),
            edges: Vec::new(),
            calls: Vec::new(),
        }
    }

    /// Builds the rs1 id for a function given its qualified name and arity.
    fn func_id(&self, qualified: &str, arity: usize) -> String {
        format!(
            "rs1:{}:func:{}#{}@{}",
            self.repo, self.rel_path, qualified, arity
        )
    }

    fn class_id(&self, qualified: &str) -> String {
        format!("rs1:{}:class:{}#{}", self.repo, self.rel_path, qualified)
    }

    fn var_id(&self, qualified: &str) -> String {
        format!("rs1:{}:var:{}#{}", self.repo, self.rel_path, qualified)
    }

    /// Recursively walk `node` with the given scope stack (enclosing
    /// class/function names) and parent node id (File or Class/Function id).
    pub fn walk(&mut self, node: TsNode, scope: &[String], parent_id: &str, scope_kind: ScopeKind) {
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

                    // Collect call sites in this function's body, then recurse for nested defs.
                    if let Some(body) = child.child_by_field_name("body") {
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
                "class_definition" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    let mut qual = scope.to_vec();
                    qual.push(name.clone());
                    let qualified = qual.join(".");
                    let id = self.class_id(&qualified);

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

                    // INHERITS: base classes named in the superclass list,
                    // resolved intra-file only (exact). The `superclasses`
                    // field is an `argument_list`.
                    if let Some(supers) = child.child_by_field_name("superclasses") {
                        let mut sc = supers.walk();
                        for base in supers.named_children(&mut sc) {
                            if base.kind() == "identifier" {
                                let base_name = text(base, self.source);
                                let base_id = self.class_id(base_name);
                                self.edges.push(Edge::new(id.clone(), "INHERITS", base_id));
                            }
                        }
                    }

                    if let Some(body) = child.child_by_field_name("body") {
                        self.walk(body, &qual, &id, ScopeKind::Class);
                    }
                }
                "expression_statement" => {
                    // Only module/class scope produces Variable nodes (PRD §5.1).
                    if scope_kind == ScopeKind::Function {
                        continue;
                    }
                    if let Some(assign) = child.named_child(0) {
                        if assign.kind() == "assignment" {
                            if let Some(lhs) = assign.child_by_field_name("left") {
                                if lhs.kind() == "identifier" {
                                    let name = text(lhs, self.source).to_string();
                                    let mut qual = scope.to_vec();
                                    qual.push(name.clone());
                                    let qualified = qual.join(".");
                                    let kind = if scope_kind == ScopeKind::Class {
                                        "class"
                                    } else if name
                                        .chars()
                                        .all(|c| c.is_ascii_uppercase() || c == '_')
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
                                    self.edges.push(Edge::new(
                                        parent_id.to_string(),
                                        "DEFINES",
                                        id,
                                    ));
                                }
                            }
                        }
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
        w.walk(tree.root_node(), &[], "rs1:r:file:m.py", ScopeKind::Module);
        w
    }

    #[test]
    fn extracts_module_and_class_variables() {
        let src = b"TIMEOUT = 30\nname = 'x'\n\nclass C:\n    LIMIT = 5\n";
        let w = run(src);

        let var = |id: &str| w.nodes.iter().find(|n| n.id == id);
        let timeout = var("rs1:r:var:m.py#TIMEOUT").expect("TIMEOUT");
        assert_eq!(timeout.labels, ["Variable"]);
        assert_eq!(timeout.props["kind"], json!("const")); // ALL_CAPS module var
        let name = var("rs1:r:var:m.py#name").expect("name");
        assert_eq!(name.props["kind"], json!("module"));
        let limit = var("rs1:r:var:m.py#C.LIMIT").expect("C.LIMIT");
        assert_eq!(limit.props["kind"], json!("class"));

        // DEFINES from File for module vars, from Class for class vars.
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:file:m.py"
            && e.typ == "DEFINES"
            && e.to == "rs1:r:var:m.py#TIMEOUT"));
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:class:m.py#C"
            && e.typ == "DEFINES"
            && e.to == "rs1:r:var:m.py#C.LIMIT"));
    }

    #[test]
    fn extracts_class_methods_and_inherits() {
        let src =
            b"class Base:\n    pass\n\nclass Foo(Base):\n    def m(self, x):\n        return x\n";
        let w = run(src);

        let class_ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Class"])
            .map(|n| n.id.as_str())
            .collect();
        assert!(class_ids.contains(&"rs1:r:class:m.py#Base"));
        assert!(class_ids.contains(&"rs1:r:class:m.py#Foo"));

        // Method qualified name is Foo.m; DEFINES from the class node.
        let m = w
            .nodes
            .iter()
            .find(|n| n.labels == ["Function"] && n.props["qualified_name"] == json!("Foo.m"))
            .unwrap();
        assert_eq!(m.id, "rs1:r:func:m.py#Foo.m@2");
        assert!(w
            .edges
            .iter()
            .any(|e| e.from == "rs1:r:class:m.py#Foo" && e.typ == "DEFINES" && e.to == m.id));

        // Foo INHERITS Base (resolved intra-file).
        assert!(w.edges.iter().any(|e| e.from == "rs1:r:class:m.py#Foo"
            && e.typ == "INHERITS"
            && e.to == "rs1:r:class:m.py#Base"));
    }

    #[test]
    fn class_has_content_hash() {
        let src = b"class Foo:\n    x = 1\n";
        let w = run(src);
        let c = w.nodes.iter().find(|n| n.labels == ["Class"]).unwrap();
        assert!(c
            .props
            .get("content_hash")
            .and_then(|v| v.as_str())
            .is_some());
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
