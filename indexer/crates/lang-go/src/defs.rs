//! Go definition extraction with stable rs1 ids. struct→Class, interface→
//! Interface; free functions bare, methods as ReceiverType.method; consts/vars
//! as Variable. The FROZEN arity rule is documented in reposkein_core::id.

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
    pub heritage: Vec<reposkein_core::extractor::RawHeritage>,
    used: HashMap<String, u32>,
    /// name → id for types declared in this file (for DEFINES from receiver type).
    declared: HashMap<String, String>,
    pending_heritage: Vec<reposkein_core::heritage::PendingHeritage>,
}

/// Go `@arity` — FROZEN. See `reposkein_core::id` for the contract.
///
/// Sum over parameter_declaration and variadic_parameter_declaration children
/// of the `parameters` list of: max(1, count of `name` fields). The receiver
/// parameter_list and result are excluded — only the `parameters` field counts.
fn arity(func: TsNode) -> usize {
    let Some(params) = func.child_by_field_name("parameters") else {
        return 0;
    };
    let mut c = params.walk();
    params
        .named_children(&mut c)
        .filter(|n| {
            matches!(
                n.kind(),
                "parameter_declaration" | "variadic_parameter_declaration"
            )
        })
        .map(|pd| {
            let mut nc = pd.walk();
            pd.children_by_field_name("name", &mut nc).count().max(1)
        })
        .sum()
}

/// Extract the base type identifier from a receiver type node.
/// Handles: type_identifier, pointer_type → type_identifier,
/// and generic receivers by finding the first type_identifier child.
fn strip_to_type_identifier(ty: TsNode, src: &[u8]) -> String {
    if ty.kind() == "type_identifier" {
        return text(ty, src).to_string();
    }
    // pointer_type (*Server) or generic_type (Stack[T]): find first type_identifier child.
    let mut c = ty.walk();
    let children: Vec<TsNode> = ty.named_children(&mut c).collect();
    children
        .into_iter()
        .find(|n| n.kind() == "type_identifier")
        .map(|n| text(n, src).to_string())
        .unwrap_or_default()
}

/// Read the receiver type name from a method_declaration node.
fn receiver_type(method: TsNode, src: &[u8]) -> Option<String> {
    let recv = method.child_by_field_name("receiver")?; // parameter_list
    let mut rc = recv.walk();
    let pd = recv
        .named_children(&mut rc)
        .find(|n| n.kind() == "parameter_declaration")?;
    let ty = pd.child_by_field_name("type")?; // type_identifier | pointer_type | generic_type
    let name = strip_to_type_identifier(ty, src);
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
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

impl<'a> Walk<'a> {
    pub fn new(repo: &'a str, rel_path: &'a str, source: &'a [u8]) -> Self {
        Walk {
            repo,
            rel_path,
            source,
            nodes: Vec::new(),
            edges: Vec::new(),
            calls: Vec::new(),
            heritage: Vec::new(),
            used: HashMap::new(),
            declared: HashMap::new(),
            pending_heritage: Vec::new(),
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
    fn var_id(&self, name: &str) -> String {
        format!("rs1:{}:var:{}#{}", self.repo, self.rel_path, name)
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
        self.declared.insert(name.to_string(), id.clone());
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
        let mut cursor = node.walk();
        let children: Vec<TsNode> = node.named_children(&mut cursor).collect();
        for child in children {
            match child.kind() {
                "function_declaration" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    if !name.is_empty() {
                        self.push_function(child, &name, parent_id);
                    }
                }
                "method_declaration" => {
                    let name = child
                        .child_by_field_name("name")
                        .map(|n| text(n, self.source).to_string())
                        .unwrap_or_default();
                    let Some(recv_type) = receiver_type(child, self.source) else {
                        continue;
                    };
                    let qualified = format!("{recv_type}.{name}");
                    // DEFINES from the receiver type's node if declared in this file,
                    // else from the file node. This keeps the extractor file-local.
                    let defines_from = self
                        .declared
                        .get(&recv_type)
                        .cloned()
                        .unwrap_or_else(|| parent_id.to_string());
                    self.push_function(child, &qualified, &defines_from);
                }
                "type_declaration" => {
                    let mut tdc = child.walk();
                    let specs: Vec<TsNode> = child.named_children(&mut tdc).collect();
                    for spec in specs {
                        if spec.kind() != "type_spec" {
                            continue; // skip type_alias (deferred)
                        }
                        let name = spec
                            .child_by_field_name("name")
                            .map(|n| text(n, self.source).to_string())
                            .unwrap_or_default();
                        if name.is_empty() {
                            continue;
                        }
                        let Some(ty) = spec.child_by_field_name("type") else {
                            continue;
                        };
                        match ty.kind() {
                            "struct_type" => {
                                let id = self.class_id(&name);
                                self.push_type(id, "Class", &name, spec, parent_id);
                            }
                            "interface_type" => {
                                let id = self.iface_id(&name);
                                self.push_type(id, "Interface", &name, spec, parent_id);
                            }
                            _ => {} // aliases, function types, etc. — deferred
                        }
                    }
                }
                "const_declaration" => {
                    let mut cdc = child.walk();
                    let specs: Vec<TsNode> = child.named_children(&mut cdc).collect();
                    for spec in specs {
                        if spec.kind() != "const_spec" {
                            continue;
                        }
                        // const specs may have multiple names: `const a, b = 1, 2`
                        let mut sc = spec.walk();
                        let names: Vec<TsNode> =
                            spec.children_by_field_name("name", &mut sc).collect();
                        for name_node in names {
                            let name = text(name_node, self.source).to_string();
                            let id = self.var_id(&name);
                            let kind = module_var_kind(&name);
                            self.nodes.push(
                                Node::new(id.clone(), "Variable")
                                    .set("name", json!(name))
                                    .set("file_path", json!(self.rel_path))
                                    .set("kind", json!(kind)),
                            );
                            self.edges
                                .push(Edge::new(parent_id.to_string(), "DEFINES", id));
                        }
                    }
                }
                "var_declaration" => {
                    let mut vdc = child.walk();
                    let specs: Vec<TsNode> = child.named_children(&mut vdc).collect();
                    for spec in specs {
                        if spec.kind() != "var_spec" {
                            continue;
                        }
                        let mut sc = spec.walk();
                        let names: Vec<TsNode> =
                            spec.children_by_field_name("name", &mut sc).collect();
                        for name_node in names {
                            let name = text(name_node, self.source).to_string();
                            let id = self.var_id(&name);
                            let kind = module_var_kind(&name);
                            self.nodes.push(
                                Node::new(id.clone(), "Variable")
                                    .set("name", json!(name))
                                    .set("file_path", json!(self.rel_path))
                                    .set("kind", json!(kind)),
                            );
                            self.edges
                                .push(Edge::new(parent_id.to_string(), "DEFINES", id));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// Lowers pending heritage into RawHeritage facts (call once after the top-level walk).
    pub fn lower_heritage(&mut self) {
        self.heritage = reposkein_core::heritage::lower(
            &self.pending_heritage,
            &self.declared,
            self.rel_path,
            &format!("rs1:{}:file:{}", self.repo, self.rel_path),
            false,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn run(src: &[u8]) -> Walk<'_> {
        let tree = parse(src).unwrap();
        let mut w = Walk::new("r", "pkg/m.go", src);
        w.walk(tree.root_node(), "rs1:r:file:pkg/m.go");
        w.lower_heritage();
        w
    }

    #[test]
    fn arity_rule_frozen() {
        // The frozen Go @arity contract: sum over param-decls of max(1, name count);
        // receiver + result + generics excluded.
        let w = run(b"package p\nfunc f0() {}\nfunc f1(a int) {}\nfunc f2(a, b int) {}\nfunc f3(a, b int, c string) {}\nfunc fu(int, string) {}\nfunc fv(a int, b ...string) {}\n");
        let ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Function"])
            .map(|n| n.id.as_str())
            .collect();
        assert!(ids.contains(&"rs1:r:func:pkg/m.go#f0@0"));
        assert!(ids.contains(&"rs1:r:func:pkg/m.go#f1@1"));
        assert!(ids.contains(&"rs1:r:func:pkg/m.go#f2@2"));
        assert!(ids.contains(&"rs1:r:func:pkg/m.go#f3@3"));
        assert!(
            ids.contains(&"rs1:r:func:pkg/m.go#fu@2"),
            "unnamed type-only params each count 1"
        );
        assert!(
            ids.contains(&"rs1:r:func:pkg/m.go#fv@2"),
            "variadic counts as a param"
        );
    }

    #[test]
    fn method_uses_receiver_type_qualified_name() {
        let w = run(b"package p\ntype Server struct{}\nfunc (s *Server) Handle(a int) {}\n");
        let ids: Vec<&str> = w.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"rs1:r:class:pkg/m.go#Server"));
        assert!(
            ids.contains(&"rs1:r:func:pkg/m.go#Server.Handle@1"),
            "method qualified as ReceiverType.method, receiver excluded from arity"
        );
    }

    #[test]
    fn struct_and_interface_and_vars() {
        let w = run(
            b"package p\ntype S struct{ x int }\ntype G interface { Hi() }\nconst K = 1\nvar V = 2\n",
        );
        assert!(w
            .nodes
            .iter()
            .any(|n| n.labels == ["Class"] && n.id == "rs1:r:class:pkg/m.go#S"));
        assert!(w
            .nodes
            .iter()
            .any(|n| n.labels == ["Interface"] && n.id == "rs1:r:iface:pkg/m.go#G"));
        assert!(w.nodes.iter().any(|n| n.labels == ["Variable"]
            && n.props.get("name").and_then(|v| v.as_str()) == Some("K")));
        assert!(w.nodes.iter().any(|n| n.labels == ["Variable"]
            && n.props.get("name").and_then(|v| v.as_str()) == Some("V")));
    }

    #[test]
    fn function_has_content_hash_and_defines_edge() {
        let w = run(b"package p\nfunc Free() {}\n");
        let f = w.nodes.iter().find(|n| n.labels == ["Function"]).unwrap();
        assert!(f
            .props
            .get("content_hash")
            .and_then(|v| v.as_str())
            .is_some());
        assert!(w
            .edges
            .iter()
            .any(|e| e.typ == "DEFINES" && e.to == "rs1:r:func:pkg/m.go#Free@0"));
    }

    #[test]
    fn extraction_is_deterministic() {
        let src = b"package p\ntype S struct{}\nfunc (s *S) M(a, b int) {}\nfunc Free() {}\n";
        let a = run(src);
        let b = run(src);
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
    }

    #[test]
    fn method_without_receiver_type_in_file_defines_from_file() {
        // Method whose receiver type is declared in a different file — DEFINES from file node.
        let w = run(b"package p\nfunc (s *ExternalType) Handle() {}\n");
        let method_id = "rs1:r:func:pkg/m.go#ExternalType.Handle@0";
        assert!(w.nodes.iter().any(|n| n.id == method_id));
        // The DEFINES edge should be from the file, not from a class node (which doesn't exist).
        assert!(w
            .edges
            .iter()
            .any(|e| e.typ == "DEFINES" && e.to == method_id && e.from == "rs1:r:file:pkg/m.go"));
    }
}
