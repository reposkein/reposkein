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

/// Extract the bare base name from an embedded type node.
///
/// Handles the three legal embedding forms in Go:
/// - `type_identifier`  → bare name  (`Animal` → `"Animal"`)
/// - `qualified_type`   → name segment only  (`io.Reader` → `"Reader"`)
/// - `pointer_type`     → peel one pointer level and recurse  (`*Animal` → `"Animal"`)
///
/// Returns `None` for all other node kinds (generic_type, function_type, etc.),
/// which silently skips the field — matching the existing pattern for
/// unnamed/empty nodes elsewhere in the extractor.
fn embedded_base_name(ty: TsNode, src: &[u8]) -> Option<String> {
    match ty.kind() {
        "type_identifier" => Some(text(ty, src).to_string()),
        "qualified_type" => ty
            .child_by_field_name("name")
            .map(|n| text(n, src).to_string()),
        "pointer_type" => {
            // A pointer_type has a single named child: the pointee type.
            let mut c = ty.walk();
            let pointee = ty.named_children(&mut c).next();
            drop(c);
            pointee.and_then(|child| embedded_base_name(child, src))
        }
        _ => None,
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
                                // Embedded fields: field_declaration with no "name" child.
                                // Walk: struct_type → field_declaration_list → field_declaration*.
                                let mut sc = ty.walk();
                                for fdl in ty.named_children(&mut sc) {
                                    if fdl.kind() != "field_declaration_list" {
                                        continue;
                                    }
                                    let mut fc = fdl.walk();
                                    for fd in fdl.named_children(&mut fc) {
                                        if fd.kind() != "field_declaration" {
                                            continue;
                                        }
                                        // Embedded = no name field (field_identifier absent).
                                        if fd.child_by_field_name("name").is_some() {
                                            continue;
                                        }
                                        let Some(type_node) = fd.child_by_field_name("type") else {
                                            continue;
                                        };
                                        let Some(base) = embedded_base_name(type_node, self.source)
                                        else {
                                            continue;
                                        };
                                        self.pending_heritage.push(
                                            reposkein_core::heritage::PendingHeritage {
                                                decl_scope: vec![],
                                                from_name: name.clone(),
                                                edge_type: "INHERITS".to_string(),
                                                base_name: base,
                                            },
                                        );
                                    }
                                }
                            }
                            "interface_type" => {
                                let id = self.iface_id(&name);
                                self.push_type(id, "Interface", &name, spec, parent_id);
                                // Embedded interfaces: type_elem children of interface_type.
                                // Skip type constraints (union: `int | float64`, tilde: `~int`).
                                let mut ic = ty.walk();
                                for elem in ty.named_children(&mut ic) {
                                    if elem.kind() != "type_elem" {
                                        continue;
                                    }
                                    // Plain embed has no `|` or `~` anonymous tokens.
                                    let has_union_token = {
                                        let mut ec = elem.walk();
                                        let tokens: Vec<_> = elem
                                            .children(&mut ec)
                                            .filter(|c| !c.is_named())
                                            .map(|c| text(c, self.source).to_string())
                                            .collect();
                                        tokens.iter().any(|t| t == "|" || t == "~")
                                    };
                                    if has_union_token {
                                        continue;
                                    }
                                    // Plain embed: exactly 1 named child.
                                    let mut ec2 = elem.walk();
                                    let type_children: Vec<_> =
                                        elem.named_children(&mut ec2).collect();
                                    if type_children.len() != 1 {
                                        continue;
                                    }
                                    let Some(base) =
                                        embedded_base_name(type_children[0], self.source)
                                    else {
                                        continue;
                                    };
                                    self.pending_heritage.push(
                                        reposkein_core::heritage::PendingHeritage {
                                            decl_scope: vec![],
                                            from_name: name.clone(),
                                            edge_type: "INHERITS".to_string(),
                                            base_name: base,
                                        },
                                    );
                                }
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

    // ── Grammar verification ─────────────────────────────────────────────────

    #[test]
    fn grammar_struct_embed_field_declaration_has_no_name_field() {
        // Verify tree-sitter-go grammar: embedded field is a field_declaration
        // with no "name" child (field_identifier), and its "type" child is
        // type_identifier. Named field has "name". This locks the grammar
        // assumption before the implementation depends on it.
        let src = b"package p\ntype Dog struct { Animal; breed string }";
        let tree = parse(src).unwrap();

        let mut found_embed = false;
        let mut found_named = false;

        fn check(
            node: tree_sitter::Node,
            found_embed: &mut bool,
            found_named: &mut bool,
        ) {
            if node.kind() == "field_declaration" {
                let has_name = node.child_by_field_name("name").is_some();
                if !has_name {
                    let ty = node
                        .child_by_field_name("type")
                        .expect("embedded field must have type child");
                    assert_eq!(
                        ty.kind(),
                        "type_identifier",
                        "embedded field type should be type_identifier, got {}",
                        ty.kind()
                    );
                    *found_embed = true;
                } else {
                    *found_named = true;
                }
            }
            let mut c = node.walk();
            for child in node.named_children(&mut c) {
                check(child, found_embed, found_named);
            }
        }

        check(tree.root_node(), &mut found_embed, &mut found_named);
        assert!(found_embed, "should find embedded field (no name field)");
        assert!(found_named, "should find named field");
    }

    #[test]
    fn grammar_interface_embed_is_type_elem_not_method_elem() {
        // Verify: `ReadWriter interface { Reader; Writer }` → type_elem children
        // (not method_elem). Each type_elem has a single type_identifier child.
        let src = b"package p\ntype ReadWriter interface { Reader; Writer }";
        let tree = parse(src).unwrap();

        let mut type_elem_count = 0u32;

        fn check(node: tree_sitter::Node, count: &mut u32) {
            if node.kind() == "interface_type" {
                let mut c = node.walk();
                for child in node.named_children(&mut c) {
                    if child.kind() == "type_elem" {
                        *count += 1;
                    }
                    // method_elem would have kind "method_elem"
                    assert_ne!(
                        child.kind(),
                        "method_elem",
                        "should be type_elem for bare interface embed"
                    );
                }
            }
            let mut c = node.walk();
            for child in node.named_children(&mut c) {
                check(child, count);
            }
        }

        check(tree.root_node(), &mut type_elem_count);
        assert_eq!(
            type_elem_count, 2,
            "expected 2 type_elem children for Reader and Writer"
        );
    }

    // ── T1: In-file struct embed ─────────────────────────────────────────────

    #[test]
    fn struct_embed_emits_inherits_heritage() {
        let src = b"package p\n\
            type Animal struct{ name string }\n\
            type Dog struct {\n\
                Animal\n\
                breed string\n\
            }";
        let w = run(src);
        assert_eq!(
            w.heritage.len(),
            1,
            "exactly 1 heritage entry for struct embed"
        );
        let h = &w.heritage[0];
        assert_eq!(h.from_id, "rs1:r:class:pkg/m.go#Dog");
        assert_eq!(h.base_name, "Animal");
        assert_eq!(h.edge_type, "INHERITS");
        assert!(!h.label_refine, "label_refine must be false");
        // No heritage for the named field "breed"
        assert!(
            w.heritage.iter().all(|h| h.base_name != "breed"),
            "named field must not become heritage"
        );
    }

    // ── T2: In-file interface embed ──────────────────────────────────────────

    #[test]
    fn interface_embed_emits_inherits_heritage() {
        let src = b"package p\n\
            type Reader interface { Read(p []byte) (int, error) }\n\
            type Writer interface { Write(p []byte) (int, error) }\n\
            type ReadWriter interface {\n\
                Reader\n\
                Writer\n\
            }";
        let w = run(src);
        let rw_heritage: Vec<_> = w
            .heritage
            .iter()
            .filter(|h| h.from_id == "rs1:r:iface:pkg/m.go#ReadWriter")
            .collect();
        assert_eq!(
            rw_heritage.len(),
            2,
            "ReadWriter should have 2 heritage entries"
        );
        assert_eq!(
            rw_heritage[0].base_name, "Reader",
            "first embed: Reader (source order)"
        );
        assert_eq!(
            rw_heritage[1].base_name, "Writer",
            "second embed: Writer (source order)"
        );
        assert!(rw_heritage.iter().all(|h| h.edge_type == "INHERITS"));
        assert!(rw_heritage.iter().all(|h| !h.label_refine));
    }

    // ── T3: Pointer-embedded struct ──────────────────────────────────────────

    #[test]
    fn pointer_struct_embed_strips_pointer() {
        let src = b"package p\n\
            type Base struct{ x int }\n\
            type Child struct {\n\
                *Base\n\
            }";
        let w = run(src);
        assert_eq!(w.heritage.len(), 1, "pointer embed is still heritage");
        assert_eq!(
            w.heritage[0].base_name, "Base",
            "pointer stripped from *Base"
        );
        assert_eq!(w.heritage[0].edge_type, "INHERITS");
    }

    // ── T4: Qualified (package-prefixed) embedded type ───────────────────────

    #[test]
    fn qualified_embed_strips_package_prefix() {
        let src = b"package p\n\
            import \"io\"\n\
            type MyReadWriter struct {\n\
                io.Reader\n\
            }";
        let w = run(src);
        assert_eq!(w.heritage.len(), 1, "qualified embed emits heritage");
        assert_eq!(
            w.heritage[0].base_name, "Reader",
            "package prefix stripped from io.Reader"
        );
        assert_eq!(w.heritage[0].edge_type, "INHERITS");
    }

    // ── T6: Type constraint (union) is NOT heritage ──────────────────────────

    #[test]
    fn type_constraint_union_is_not_heritage() {
        let src = b"package p\n\
            type Number interface {\n\
                int | float64\n\
            }";
        let w = run(src);
        assert!(
            w.heritage.is_empty(),
            "type constraint (union) must not emit heritage"
        );
    }

    // ── T7: Named field is NOT heritage ──────────────────────────────────────

    #[test]
    fn named_field_is_not_heritage() {
        let src = b"package p\n\
            type Foo struct{}\n\
            type Bar struct {\n\
                f Foo\n\
            }";
        let w = run(src);
        assert!(w.heritage.is_empty(), "named field must not emit heritage");
    }

    // ── T8: Determinism with embeds ──────────────────────────────────────────

    #[test]
    fn embed_extraction_is_deterministic() {
        let src = b"package p\n\
            type A struct{}\n\
            type B struct{}\n\
            type C struct { A; B }";
        let a = run(src);
        let b = run(src);
        assert_eq!(
            a.heritage, b.heritage,
            "heritage must be identical across runs"
        );
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
        // Verify source order: A before B
        assert_eq!(a.heritage[0].base_name, "A");
        assert_eq!(a.heritage[1].base_name, "B");
    }
}
