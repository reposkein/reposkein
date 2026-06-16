//! C# definition extraction with stable rs1 ids.
//! class/struct/record→Class, interface→Interface, enum→Enum;
//! methods as Namespace.Type.method; constructors as Type.<init>;
//! properties and fields as Variable. The FROZEN @arity rule is documented in
//! reposkein_core::id.

use reposkein_core::hash::content_hash;
use reposkein_core::heritage::PendingHeritage;
use reposkein_core::model::{Edge, Node};
use reposkein_lang_common::{text, unique};
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
    /// qualified_name → node_id for all types declared in this file.
    declared: HashMap<String, String>,
    pending_heritage: Vec<PendingHeritage>,
}

/// C# `@arity` — FROZEN. See `reposkein_core::id` for the contract.
///
/// Reads the `parameter_list` field on the node. Counts:
/// - Each `parameter` child as exactly 1 (covers regular, ref, out, in params).
/// - If there are named children that are NOT `parameter` nodes (the `params`
///   keyword case — tree-sitter represents `params T[] xs` as loose type+identifier
///   children in the parameter_list rather than a `parameter` node), those
///   collectively count as 1.
///   Generic type parameters (`type_parameter_list`) are NOT counted.
fn arity(node: TsNode) -> usize {
    let Some(params) = node.child_by_field_name("parameters") else {
        return 0;
    };
    let mut c = params.walk();
    let children: Vec<TsNode> = params.named_children(&mut c).collect();
    let param_count = children.iter().filter(|n| n.kind() == "parameter").count();
    // Non-`parameter` named children indicate a `params` array — count as 1.
    let has_params_array = children.iter().any(|n| n.kind() != "parameter");
    param_count + if has_params_array { 1 } else { 0 }
}

/// Extract a simple identifier text from a type reference node that may be a
/// `generic_name` or wrapped — try the node itself first, then the LAST
/// identifier child (so `Ns.Base` → `Base`, not `Ns`).
fn extract_base_name(node: TsNode, src: &[u8]) -> String {
    if node.kind() == "identifier" {
        return text(node, src).to_string();
    }
    // For qualified_name (e.g. `Ns.Base`): use the LAST identifier child so
    // we get the type name, not the namespace prefix.
    let mut c = node.walk();
    let last_ident = node
        .named_children(&mut c)
        .filter(|n| n.kind() == "identifier")
        .last();
    if let Some(child) = last_ident {
        return text(child, src).to_string();
    }
    // Fallback: use full text.
    text(node, src).to_string()
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

/// Preliminary edge type for a heritage entry at push time (before labels are known).
///
/// The definitive refinement happens in `finalize_heritage` using the declared map.
/// Here we apply positional and naming heuristics only:
/// - I[A-Z] naming convention → IMPLEMENTS (C# interface by convention)
/// - First base → INHERITS (C# single class inheritance), rest → IMPLEMENTS.
fn heritage_edge_type(base_name: &str, is_first: bool) -> &'static str {
    if is_iface_name(base_name) {
        return "IMPLEMENTS";
    }
    if is_first {
        "INHERITS"
    } else {
        "IMPLEMENTS"
    }
}

fn is_iface_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!((chars.next(), chars.next()), (Some('I'), Some(c)) if c.is_ascii_uppercase())
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
            crate::calls::collect_calls(
                body,
                self.source,
                &id,
                qual,
                self.rel_path,
                &mut self.calls,
            );
        }
    }

    fn push_type(&mut self, id: String, label: &str, qual: &str, node: TsNode, parent_id: &str) {
        let id = self.unique(id);
        let simple = qual.rsplit('.').next().unwrap_or(qual);
        self.declared.insert(qual.to_string(), id.clone());
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

    /// Collect pending heritage entries from a `base_list` node.
    /// Each named child of `base_list` is an identifier (simple name) or a
    /// qualified/generic name. The first entry is INHERITS (unless I[A-Z]),
    /// subsequent entries are IMPLEMENTS.
    fn collect_base_list_heritage(&mut self, base_list: TsNode, from_name: &str, scope: &[String]) {
        let mut c = base_list.walk();
        let entries: Vec<TsNode> = base_list.named_children(&mut c).collect();
        for (i, entry) in entries.iter().enumerate() {
            let base_name = extract_base_name(*entry, self.source);
            if base_name.is_empty() {
                continue;
            }
            let edge_type = heritage_edge_type(&base_name, i == 0).to_string();
            self.pending_heritage.push(PendingHeritage {
                decl_scope: scope.to_vec(),
                from_name: from_name.to_string(),
                edge_type,
                base_name,
            });
        }
    }

    /// Main entry point. Handles `compilation_unit` specially to support
    /// `file_scoped_namespace_declaration`.
    pub fn walk(&mut self, node: TsNode, parent_id: &str) {
        if node.kind() == "compilation_unit" {
            self.walk_compilation_unit(node, parent_id);
        } else {
            self.walk_scoped(node, parent_id, &[]);
        }
    }

    /// Walk the `compilation_unit`, detecting `file_scoped_namespace_declaration`
    /// and propagating its namespace as scope to all peer top-level declarations.
    fn walk_compilation_unit(&mut self, node: TsNode, parent_id: &str) {
        let mut cursor = node.walk();
        let children: Vec<TsNode> = node.named_children(&mut cursor).collect();

        // Find a file_scoped_namespace_declaration, if present.
        let file_ns: Option<Vec<String>> = children
            .iter()
            .find(|c| c.kind() == "file_scoped_namespace_declaration")
            .and_then(|fsn| fsn.child_by_field_name("name"))
            .map(|name_node| {
                // Name may be a dotted_name or simple identifier.
                let ns_text = text(name_node, self.source).to_string();
                ns_text
                    .split('.')
                    .map(|s| s.to_string())
                    .collect::<Vec<_>>()
            });

        let scope: Vec<String> = file_ns.unwrap_or_default();

        for child in &children {
            match child.kind() {
                "file_scoped_namespace_declaration" => {
                    // Already handled above — skip.
                }
                "namespace_declaration" => {
                    self.walk_namespace(*child, parent_id, &scope);
                }
                _ => {
                    self.walk_member(*child, parent_id, &scope);
                }
            }
        }
    }

    /// Recurse into a namespace_declaration, extending scope.
    fn walk_namespace(&mut self, node: TsNode, parent_id: &str, outer_scope: &[String]) {
        let name = node
            .child_by_field_name("name")
            .map(|n| text(n, self.source).to_string())
            .unwrap_or_default();
        if name.is_empty() {
            return;
        }
        // Build new scope: outer_scope + dotted segments of name.
        let mut new_scope = outer_scope.to_vec();
        for seg in name.split('.') {
            new_scope.push(seg.to_string());
        }
        if let Some(body) = node.child_by_field_name("body") {
            self.walk_scoped(body, parent_id, &new_scope);
        }
    }

    /// Walk scoped: iterate named children, dispatch by kind.
    fn walk_scoped(&mut self, node: TsNode, parent_id: &str, scope: &[String]) {
        let mut cursor = node.walk();
        let children: Vec<TsNode> = node.named_children(&mut cursor).collect();
        for child in children {
            self.walk_member(child, parent_id, scope);
        }
    }

    /// Dispatch a single member node.
    fn walk_member(&mut self, child: TsNode, parent_id: &str, scope: &[String]) {
        match child.kind() {
            "namespace_declaration" => {
                self.walk_namespace(child, parent_id, scope);
            }
            "class_declaration" | "struct_declaration" | "record_declaration" => {
                let name = child
                    .child_by_field_name("name")
                    .map(|n| text(n, self.source).to_string())
                    .unwrap_or_default();
                if name.is_empty() {
                    return;
                }
                let qual = qualified(scope, &name);
                let id = self.class_id(&qual);
                self.push_type(id, "Class", &qual, child, parent_id);
                // Heritage: find base_list as a named child (NOT a named field).
                let mut cc = child.walk();
                if let Some(base_list) = child
                    .named_children(&mut cc)
                    .find(|n| n.kind() == "base_list")
                {
                    self.collect_base_list_heritage(base_list, &name, scope);
                }
                // Recurse into body.
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
                    return;
                }
                let qual = qualified(scope, &name);
                let id = self.iface_id(&qual);
                self.push_type(id, "Interface", &qual, child, parent_id);
                // Heritage: base_list (interface can extend other interfaces).
                let mut cc = child.walk();
                if let Some(base_list) = child
                    .named_children(&mut cc)
                    .find(|n| n.kind() == "base_list")
                {
                    self.collect_base_list_heritage(base_list, &name, scope);
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
                    return;
                }
                let qual = qualified(scope, &name);
                let id = self.enum_id(&qual);
                self.push_type(id, "Enum", &qual, child, parent_id);
                // Note: enum members are not extracted in v1.
            }
            "method_declaration" => {
                let name = child
                    .child_by_field_name("name")
                    .map(|n| text(n, self.source).to_string())
                    .unwrap_or_default();
                if name.is_empty() {
                    return;
                }
                let qual = qualified(scope, &name);
                self.push_function(child, &qual, parent_id);
            }
            "constructor_declaration" => {
                let qual = qualified(scope, "<init>");
                self.push_function(child, &qual, parent_id);
            }
            "property_declaration" => {
                let name = child
                    .child_by_field_name("name")
                    .map(|n| text(n, self.source).to_string())
                    .unwrap_or_default();
                if name.is_empty() {
                    return;
                }
                let qual = qualified(scope, &name);
                let id = self.var_id(&qual);
                let id = self.unique(id);
                self.nodes.push(
                    Node::new(id.clone(), "Variable")
                        .set("name", json!(name))
                        .set("qualified_name", json!(qual))
                        .set("file_path", json!(self.rel_path))
                        .set("kind", json!("property")),
                );
                self.edges
                    .push(Edge::new(parent_id.to_string(), "DEFINES", id));
            }
            "field_declaration" => {
                // field_declaration → variable_declaration → variable_declarator*
                let mut fdc = child.walk();
                for vd in child.named_children(&mut fdc) {
                    if vd.kind() != "variable_declaration" {
                        continue;
                    }
                    let mut vdc = vd.walk();
                    for decl in vd.named_children(&mut vdc) {
                        if decl.kind() != "variable_declarator" {
                            continue;
                        }
                        // The first named child of variable_declarator is the identifier.
                        let name = if let Some(n) = decl.child_by_field_name("name") {
                            text(n, self.source).to_string()
                        } else {
                            let mut dc = decl.walk();
                            let found = decl
                                .named_children(&mut dc)
                                .find(|n| n.kind() == "identifier")
                                .map(|n| text(n, self.source).to_string());
                            found.unwrap_or_default()
                        };
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
                                .set("kind", json!("field")),
                        );
                        self.edges
                            .push(Edge::new(parent_id.to_string(), "DEFINES", id));
                    }
                }
            }
            _ => {} // using_directive, extern_alias, etc. — skip
        }
    }

    /// Resolves deferred heritage edges using label-based refinement.
    ///
    /// Before calling `heritage::resolve`, we refine the `edge_type` of each
    /// `PendingHeritage` entry by checking if the resolved target is an Interface
    /// node in `declared` (we track label alongside id in a separate map).
    pub fn finalize_heritage(&mut self) {
        // Build a label map: id → label.
        let id_to_label: HashMap<String, String> = self
            .nodes
            .iter()
            .filter_map(|n| n.labels.first().map(|l| (n.id.clone(), l.clone())))
            .collect();

        // Refine edge_type using resolved label.
        // `heritage::resolve` will find id via scope resolution; replicate that
        // logic here to refine edge_type before calling resolve.
        let declared = &self.declared;
        for p in &mut self.pending_heritage {
            // Resolve target name.
            for i in (0..=p.decl_scope.len()).rev() {
                let candidate = if i == 0 {
                    p.base_name.clone()
                } else {
                    format!("{}.{}", p.decl_scope[..i].join("."), p.base_name)
                };
                if let Some(id) = declared.get(&candidate) {
                    if let Some(label) = id_to_label.get(id) {
                        p.edge_type = match label.as_str() {
                            "Interface" => "IMPLEMENTS".to_string(),
                            "Class" => "INHERITS".to_string(),
                            _ => p.edge_type.clone(),
                        };
                    }
                    break;
                }
            }
        }

        let e = reposkein_core::heritage::resolve(&self.pending_heritage, &self.declared);
        self.edges.extend(e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn run(src: &[u8]) -> Walk<'_> {
        let t = parse(src).unwrap();
        let mut w = Walk::new("r", "N/Svc.cs", src);
        w.walk(t.root_node(), "rs1:r:file:N/Svc.cs");
        w.finalize_heritage();
        w
    }

    #[test]
    fn arity_frozen() {
        let w = run(b"namespace N { class Svc {\n void m0(){}\n void m1(int a){}\n void m2(int a, string b){}\n void mp(params int[] xs){}\n void mr(ref int a, out int b){}\n void mg<T>(T a){}\n } }");
        let ids: Vec<&str> = w
            .nodes
            .iter()
            .filter(|n| n.labels == ["Function"])
            .map(|n| n.id.as_str())
            .collect();
        assert!(ids.contains(&"rs1:r:func:N/Svc.cs#N.Svc.m0@0"));
        assert!(ids.contains(&"rs1:r:func:N/Svc.cs#N.Svc.m1@1"));
        assert!(ids.contains(&"rs1:r:func:N/Svc.cs#N.Svc.m2@2"));
        assert!(ids.contains(&"rs1:r:func:N/Svc.cs#N.Svc.mp@1")); // params = 1
        assert!(ids.contains(&"rs1:r:func:N/Svc.cs#N.Svc.mr@2")); // ref/out each = 1
        assert!(ids.contains(&"rs1:r:func:N/Svc.cs#N.Svc.mg@1")); // generics excluded
    }

    #[test]
    fn types_methods_ctor_props_heritage() {
        let w = run(b"namespace N { interface IGreeter {} class Base {} class Svc : Base, IGreeter {\n public Svc(){}\n public int X { get; set; }\n int y;\n void Run(){}\n } }");
        let ids: Vec<&str> = w.nodes.iter().map(|n| n.id.as_str()).collect();
        assert!(ids.contains(&"rs1:r:class:N/Svc.cs#N.Svc"));
        assert!(ids.contains(&"rs1:r:iface:N/Svc.cs#N.IGreeter"));
        assert!(ids.contains(&"rs1:r:func:N/Svc.cs#N.Svc.<init>@0"));
        assert!(ids.contains(&"rs1:r:func:N/Svc.cs#N.Svc.Run@0"));
        assert!(w.nodes.iter().any(|n| n.labels == ["Variable"]
            && n.props.get("name").and_then(|v| v.as_str()) == Some("X")
            && n.props.get("kind").and_then(|v| v.as_str()) == Some("property")));
        assert!(w
            .edges
            .iter()
            .any(|e| e.typ == "INHERITS" && e.to == "rs1:r:class:N/Svc.cs#N.Base"));
        assert!(w
            .edges
            .iter()
            .any(|e| e.typ == "IMPLEMENTS" && e.to == "rs1:r:iface:N/Svc.cs#N.IGreeter"));
    }

    #[test]
    fn file_scoped_namespace_and_determinism() {
        let a = run(b"namespace N;\nclass C { void m(){} }");
        let b = run(b"namespace N;\nclass C { void m(){} }");
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
        assert!(a
            .nodes
            .iter()
            .any(|n| n.id == "rs1:r:func:N/Svc.cs#N.C.m@0"));
    }

    /// Regression: for `class C : N.Base`, the base-name extraction must use
    /// the LAST segment of the qualified name (`Base`), not the first (`N`).
    /// Without the fix the heritage edge is dropped (N is not a declared type);
    /// with the fix `base_name = "Base"` resolves to the in-file class and the
    /// INHERITS edge is emitted.
    #[test]
    fn qualified_base_name_uses_last_segment() {
        // namespace N { class Base {} class C : N.Base {} }
        // Both Base and C are in namespace N, so heritage::resolve will find
        // N.Base in the declared map when base_name == "Base" (last segment).
        let w = run(b"namespace N { class Base {} class C : N.Base {} }");
        // With the fix: INHERITS edge from C → Base must exist.
        assert!(
            w.edges
                .iter()
                .any(|e| e.typ == "INHERITS" && e.to == "rs1:r:class:N/Svc.cs#N.Base"),
            "C must inherit from N.Base (resolved via last segment of qualified name)"
        );
        // Sanity: no edge must target a node with id containing just the namespace prefix "N"
        // as the type (which would be the pre-fix bug: base_name = "N").
        let has_ns_target = w
            .edges
            .iter()
            .any(|e| (e.typ == "INHERITS" || e.typ == "IMPLEMENTS") && e.to.ends_with("#N"));
        assert!(
            !has_ns_target,
            "heritage edge must not target the namespace segment"
        );
    }
}
