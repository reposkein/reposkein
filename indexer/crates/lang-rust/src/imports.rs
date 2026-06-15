//! Rust `use` → RawImport with candidate target file paths (design §2.x).
//! Mirrors lang-python/src/imports.rs: emits speculative candidate_paths and
//! lets the resolver pick the first that is a real File node.

use reposkein_core::extractor::RawImport;
use tree_sitter::Node as TsNode;

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

/// Flatten a `scoped_identifier` into its ordered segment strings.
/// e.g. `crate::a::b` → ["crate", "a", "b"]
fn flatten_scoped_id(node: TsNode, source: &[u8]) -> Vec<String> {
    let mut segs: Vec<String> = Vec::new();
    collect_segments(node, source, &mut segs);
    segs
}

fn collect_segments(node: TsNode, source: &[u8], out: &mut Vec<String>) {
    match node.kind() {
        "scoped_identifier" => {
            if let Some(path) = node.child_by_field_name("path") {
                collect_segments(path, source, out);
            }
            if let Some(name) = node.child_by_field_name("name") {
                out.push(text(name, source).to_string());
            }
        }
        "identifier" | "crate" | "super" | "self" => {
            out.push(text(node, source).to_string());
        }
        _ => {}
    }
}

/// Derive `current_mod_dir` from an importing path.
/// If the file is mod.rs/lib.rs/main.rs → dirname.
/// Otherwise → dirname + "/" + filestem (the module's own submodule dir).
fn current_mod_dir(importing_path: &str) -> String {
    let (dir, filename) = match importing_path.rsplit_once('/') {
        Some((d, f)) => (d.to_string(), f.to_string()),
        None => (String::new(), importing_path.to_string()),
    };
    let stem = filename
        .strip_suffix(".rs")
        .unwrap_or(&filename)
        .to_string();
    if matches!(stem.as_str(), "mod" | "lib" | "main") {
        dir
    } else if dir.is_empty() {
        stem
    } else {
        format!("{dir}/{stem}")
    }
}

/// Derive `parent_mod_dir` for `super::` resolution.
fn parent_mod_dir(importing_path: &str) -> String {
    let cur = current_mod_dir(importing_path);
    match cur.rsplit_once('/') {
        Some((parent, _)) => parent.to_string(),
        None => String::new(),
    }
}

/// The crate root directory for `crate::` resolution: the nearest ancestor
/// directory ending at a `src` path segment. Handles cargo workspaces where
/// crates live under e.g. `indexer/crates/core/src/`. Falls back to "src".
fn crate_root_dir(importing_path: &str) -> String {
    let segs: Vec<&str> = importing_path.split('/').collect();
    match segs.iter().rposition(|s| *s == "src") {
        Some(i) => segs[..=i].join("/"),
        None => "src".to_string(),
    }
}

/// Compute candidate file paths for a use path given root token, inner segs,
/// and the importing file path.
///
/// `root`: "crate" | "super" | "self" | bare-ident (treated as crate-relative + repo-root)
/// `segs`: the inner module path segments BETWEEN root token and the terminal item
fn module_candidates(importing_path: &str, root: &str, segs: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    match root {
        "crate" => {
            let root = crate_root_dir(importing_path);
            if segs.is_empty() {
                // item is defined in crate root
                out.push(format!("{root}/lib.rs"));
                out.push(format!("{root}/main.rs"));
                out.push("lib.rs".to_string());
                out.push("main.rs".to_string());
            } else {
                let inner = segs.join("/");
                out.push(format!("{root}/{inner}.rs"));
                out.push(format!("{root}/{inner}/mod.rs"));
                out.push(format!("{inner}.rs"));
                out.push(format!("{inner}/mod.rs"));
            }
        }
        "self" => {
            let base = current_mod_dir(importing_path);
            if segs.is_empty() {
                // `use self::item` — item lives in THIS file
                out.push(importing_path.to_string());
            } else {
                let inner = segs.join("/");
                let stem = if base.is_empty() {
                    inner.clone()
                } else {
                    format!("{base}/{inner}")
                };
                out.push(format!("{stem}.rs"));
                out.push(format!("{stem}/mod.rs"));
            }
        }
        "super" => {
            let base = parent_mod_dir(importing_path);
            if segs.is_empty() {
                // `super::item` — item lives in the parent module file
                if base.is_empty() {
                    out.push("lib.rs".to_string());
                    out.push("main.rs".to_string());
                    out.push("mod.rs".to_string());
                } else {
                    out.push(format!("{base}.rs"));
                    out.push(format!("{base}/mod.rs"));
                }
            } else {
                let inner = segs.join("/");
                let stem = if base.is_empty() {
                    inner.clone()
                } else {
                    format!("{base}/{inner}")
                };
                out.push(format!("{stem}.rs"));
                out.push(format!("{stem}/mod.rs"));
            }
        }
        _ => {
            // Bare root: crate-relative AND literal from repo root.
            // segs INCLUDES the bare root segment at position 0.
            if !segs.is_empty() {
                let root = crate_root_dir(importing_path);
                let inner = segs.join("/");
                out.push(format!("{root}/{inner}.rs"));
                out.push(format!("{root}/{inner}/mod.rs"));
                out.push(format!("{inner}.rs"));
                out.push(format!("{inner}/mod.rs"));
            }
        }
    }
    // Order-preserving dedup.
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|p| seen.insert(p.clone()));
    out
}

/// A parsed leaf from a use tree.
/// (root_token, inner_segments, original_item, local_binding)
/// `inner_segments`: the module path between root_token and the item (exclusive of both)
/// `original_item`: the name in the source
/// `local_binding`: the `as` alias, or same as original_item
type UseLeaf = (String, Vec<String>, String, String);

/// Parse a use_declaration's argument subtree into leaves.
/// `prefix_segs`: accumulated path segments so far, INCLUDING the root token at index 0.
/// When prefix_segs is empty we are at the top level.
fn parse_use_tree_with_prefix(
    node: TsNode,
    source: &[u8],
    prefix_segs: &[String],
    out: &mut Vec<UseLeaf>,
) {
    match node.kind() {
        "scoped_use_list" => {
            // path field = the path prefix; list field = the use_list with items.
            let new_prefix = if let Some(path) = node.child_by_field_name("path") {
                let segs = flatten_scoped_id(path, source);
                let mut p = prefix_segs.to_vec();
                p.extend(segs);
                p
            } else {
                prefix_segs.to_vec()
            };
            if let Some(list) = node.child_by_field_name("list") {
                parse_use_tree_with_prefix(list, source, &new_prefix, out);
            }
        }
        "use_list" => {
            let mut cursor = node.walk();
            for child in node.named_children(&mut cursor) {
                parse_use_tree_with_prefix(child, source, prefix_segs, out);
            }
        }
        "use_as_clause" => {
            // path field = the item (possibly with path), alias field = the alias name
            let alias = node
                .child_by_field_name("alias")
                .map(|n| text(n, source).to_string())
                .unwrap_or_default();
            if alias == "_" {
                return;
            }
            if let Some(path_node) = node.child_by_field_name("path") {
                // path_node gives us the full path to the item (root + inner + item)
                let segs = flatten_scoped_id(path_node, source);
                if segs.is_empty() {
                    return;
                }
                // If we already have a prefix, merge; otherwise use segs directly.
                let full: Vec<String> = if prefix_segs.is_empty() {
                    segs
                } else {
                    let mut p = prefix_segs.to_vec();
                    p.extend(segs);
                    p
                };
                emit_leaf(&full, &alias, out);
            }
        }
        "scoped_identifier" => {
            let segs = flatten_scoped_id(node, source);
            let full: Vec<String> = if prefix_segs.is_empty() {
                segs
            } else {
                let mut p = prefix_segs.to_vec();
                p.extend(segs);
                p
            };
            if full.is_empty() {
                return;
            }
            let item = full.last().unwrap().clone();
            emit_leaf(&full, &item, out);
        }
        "identifier" => {
            let name = text(node, source).to_string();
            let full: Vec<String> = if prefix_segs.is_empty() {
                vec![name.clone()]
            } else {
                let mut p = prefix_segs.to_vec();
                p.push(name.clone());
                p
            };
            emit_leaf(&full, &name, out);
        }
        "crate" | "super" | "self" => {
            // Standalone `use crate;` etc — unusual; treat root as item.
            let name = text(node, source).to_string();
            out.push((name.clone(), Vec::new(), name.clone(), name));
        }
        "use_wildcard" => {
            // Skip globs entirely.
        }
        _ => {}
    }
}

/// Given a full segment vec [root, seg1, ..., segN, item] and the local binding,
/// emit a UseLeaf.
fn emit_leaf(full: &[String], local: &str, out: &mut Vec<UseLeaf>) {
    if full.is_empty() {
        return;
    }
    let root = full[0].clone();
    let item = full.last().unwrap().clone();
    // inner segs = everything between root (index 0) and item (last)
    let inner: Vec<String> = if full.len() >= 2 {
        full[1..full.len() - 1].to_vec()
    } else {
        Vec::new()
    };
    // For bare (non-crate/super/self) root, inner segs INCLUDE the root for the path algorithm.
    // The module_candidates function expects segs to include the bare root for `Bare` case.
    let (resolved_root, resolved_segs) = if matches!(root.as_str(), "crate" | "super" | "self") {
        (root, inner)
    } else {
        // Bare root: segs = [root, seg1..segN] (all segments except the terminal item)
        let mut segs = vec![root.clone()];
        segs.extend(inner);
        (root, segs)
    };

    out.push((
        resolved_root,
        resolved_segs,
        item.clone(),
        local.to_string(),
    ));
}

pub fn extract_imports(
    root: TsNode,
    source: &[u8],
    importing_file_id: &str,
    importing_path: &str,
) -> Vec<RawImport> {
    let mut out = Vec::new();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        if child.kind() == "use_declaration" {
            if let Some(arg) = child.child_by_field_name("argument") {
                let mut leaves: Vec<UseLeaf> = Vec::new();
                parse_use_tree_with_prefix(arg, source, &[], &mut leaves);
                for (root_tok, segs, item, local) in leaves {
                    if local == "_" {
                        continue;
                    }
                    let candidate_paths = module_candidates(importing_path, &root_tok, &segs);
                    if candidate_paths.is_empty() {
                        continue;
                    }
                    out.push(RawImport {
                        importing_file_id: importing_file_id.to_string(),
                        importing_path: importing_path.to_string(),
                        symbols: vec![(local, item)],
                        candidate_paths,
                    });
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn imps(src: &[u8], path: &str) -> Vec<RawImport> {
        let tree = parse(src).unwrap();
        extract_imports(tree.root_node(), src, "fid", path)
    }

    #[test]
    fn crate_path_to_item() {
        let v = imps(b"use crate::a::b::Item;\n", "src/svc.rs");
        assert_eq!(v.len(), 1);
        assert!(v[0].candidate_paths.contains(&"src/a/b.rs".to_string()));
        assert!(v[0].candidate_paths.contains(&"src/a/b/mod.rs".to_string()));
        assert_eq!(v[0].symbols, vec![("Item".to_string(), "Item".to_string())]);
    }

    #[test]
    fn crate_single_segment() {
        let v = imps(b"use crate::a::Item;\n", "src/svc.rs");
        assert!(v[0].candidate_paths.contains(&"src/a.rs".to_string()));
        assert!(v[0].candidate_paths.contains(&"src/a/mod.rs".to_string()));
    }

    #[test]
    fn super_item_targets_parent_module_file() {
        let v = imps(b"use super::x;\n", "src/auth/session.rs");
        assert!(v[0].candidate_paths.contains(&"src/auth.rs".to_string()));
        assert!(v[0]
            .candidate_paths
            .contains(&"src/auth/mod.rs".to_string()));
        assert_eq!(v[0].symbols, vec![("x".to_string(), "x".to_string())]);
    }

    #[test]
    fn self_item_targets_current_file() {
        let v = imps(b"use self::y;\n", "src/auth/session.rs");
        assert!(v[0]
            .candidate_paths
            .contains(&"src/auth/session.rs".to_string()));
        assert_eq!(v[0].symbols, vec![("y".to_string(), "y".to_string())]);
    }

    #[test]
    fn group_and_alias() {
        let v = imps(b"use crate::a::b::{c, d as e};\n", "src/svc.rs");
        // one RawImport per leaf, sharing candidate_paths
        let syms: Vec<&(String, String)> = v.iter().flat_map(|i| i.symbols.iter()).collect();
        assert!(syms.iter().any(|(l, o)| l == "c" && o == "c"));
        assert!(syms.iter().any(|(l, o)| l == "e" && o == "d")); // (local, original)
        for i in &v {
            assert!(i.candidate_paths.contains(&"src/a/b.rs".to_string()));
        }
    }

    #[test]
    fn top_level_alias() {
        let v = imps(b"use crate::a::helper as h;\n", "src/svc.rs");
        assert_eq!(v[0].symbols, vec![("h".to_string(), "helper".to_string())]);
    }

    #[test]
    fn glob_is_skipped() {
        assert!(imps(b"use crate::a::*;\n", "src/svc.rs").is_empty());
    }

    #[test]
    fn crate_root_detected_in_cargo_workspace() {
        // Crates under e.g. indexer/crates/core/src/ — crate root is the
        // nearest ancestor src/, not the literal repo-root "src".
        let v = imps(b"use crate::a::helper;\n", "indexer/crates/core/src/b.rs");
        assert!(v[0]
            .candidate_paths
            .contains(&"indexer/crates/core/src/a.rs".to_string()));
        assert!(v[0]
            .candidate_paths
            .contains(&"indexer/crates/core/src/a/mod.rs".to_string()));
    }

    #[test]
    fn bare_path_emits_src_and_root_candidates() {
        let v = imps(b"use a::b::Item;\n", "src/svc.rs");
        let c = &v[0].candidate_paths;
        assert!(c.contains(&"src/a/b.rs".to_string()));
        assert!(c.contains(&"a/b.rs".to_string()));
    }

    #[test]
    fn deterministic() {
        let a = imps(
            b"use crate::a::b::{c, d};\nuse super::x;\n",
            "src/auth/session.rs",
        );
        let b = imps(
            b"use crate::a::b::{c, d};\nuse super::x;\n",
            "src/auth/session.rs",
        );
        assert_eq!(a, b);
    }
}
