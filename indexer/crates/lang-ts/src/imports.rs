//! TypeScript import extraction → RawImport with candidate target file paths.
//! Only relative specifiers are resolved; bare specifiers (e.g. "react") are
//! external and skipped.

use reposkein_core::extractor::RawImport;
use tree_sitter::Node as TsNode;

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

/// Normalizes a relative module specifier against the importing file's dir.
/// Returns the base path (no extension), or None for bare/external specifiers.
fn resolve_relative(importing_path: &str, specifier: &str) -> Option<String> {
    if !(specifier.starts_with("./") || specifier.starts_with("../") || specifier.starts_with('/'))
    {
        return None; // external/bare specifier
    }
    let mut parts: Vec<&str> = importing_path.split('/').collect();
    parts.pop(); // drop filename → dir parts
    for seg in specifier.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let base = parts.join("/");
    // Strip an explicit module extension from the specifier (NodeNext: "./x.js").
    for ext in [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] {
        if let Some(stripped) = base.strip_suffix(ext) {
            return Some(stripped.to_string());
        }
    }
    Some(base)
}

fn candidates(base: &str) -> Vec<String> {
    vec![
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}.js"),
        format!("{base}.jsx"),
        format!("{base}/index.ts"),
        format!("{base}/index.tsx"),
        format!("{base}/index.js"),
        format!("{base}/index.jsx"),
    ]
}

/// Imported symbol names from an import_clause (named + default + namespace).
/// Returns (local_binding, original_name) pairs; equal when not aliased.
fn clause_symbols(clause: TsNode, source: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut c = clause.walk();
    for child in clause.named_children(&mut c) {
        match child.kind() {
            "identifier" => {
                let s = text(child, source).to_string();
                out.push((s.clone(), s));
            } // default import
            "namespace_import" => {
                let mut nc = child.walk();
                for n in child.named_children(&mut nc) {
                    if n.kind() == "identifier" {
                        let s = text(n, source).to_string();
                        out.push((s.clone(), s));
                    }
                }
            }
            "named_imports" => {
                let mut nc = child.walk();
                for spec in child.named_children(&mut nc) {
                    if spec.kind() == "import_specifier" {
                        if let Some(name) = spec.child_by_field_name("name") {
                            let original = text(name, source).to_string();
                            let local = spec
                                .child_by_field_name("alias")
                                .map(|a| text(a, source).to_string())
                                .unwrap_or_else(|| original.clone());
                            out.push((local, original));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
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
        if child.kind() != "import_statement" {
            continue;
        }
        let Some(src_node) = child.child_by_field_name("source") else {
            continue;
        };
        // source is a string; its named child is the string_fragment.
        let specifier = src_node
            .named_child(0)
            .map(|f| text(f, source).to_string())
            .unwrap_or_default();
        let Some(base) = resolve_relative(importing_path, &specifier) else {
            continue; // external — no edge
        };
        let symbols = child
            .named_children(&mut child.walk())
            .find(|n| n.kind() == "import_clause")
            .map(|clause| clause_symbols(clause, source))
            .unwrap_or_default();
        out.push(RawImport {
            importing_file_id: importing_file_id.to_string(),
            importing_path: importing_path.to_string(),
            symbols,
            candidate_paths: candidates(&base),
            reexport: false,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn imports_of(src: &[u8], path: &str) -> Vec<RawImport> {
        let tree = parse(src, false).unwrap();
        extract_imports(tree.root_node(), src, "fid", path)
    }

    #[test]
    fn resolves_relative_named_and_skips_external() {
        let src = b"import { Base } from \"./base\";\nimport React from \"react\";\nimport { x } from \"../lib/util\";\n";
        let imps = imports_of(src, "src/svc.ts");
        // "./base" → src/base.*, "react" skipped, "../lib/util" → lib/util.*
        assert_eq!(imps.len(), 2);
        assert_eq!(imps[0].candidate_paths[0], "src/base.ts");
        assert!(imps[0]
            .candidate_paths
            .contains(&"src/base/index.ts".to_string()));
        assert_eq!(imps[0].symbols, vec![("Base".into(), "Base".into())]);
        assert_eq!(imps[1].candidate_paths[0], "lib/util.ts");
        assert_eq!(imps[1].symbols, vec![("x".into(), "x".into())]);
    }

    #[test]
    fn aliased_named_import_records_local_and_original() {
        let imps = imports_of(b"import { helper as h } from \"./util\";\n", "src/app.ts");
        assert_eq!(
            imps[0].symbols,
            vec![("h".to_string(), "helper".to_string())]
        );
    }

    #[test]
    fn resolves_js_candidates_and_strips_explicit_extension() {
        // NodeNext-style explicit .js specifier + a plain relative import.
        let src = b"import { a } from \"./util.js\";\nimport { b } from \"./helpers\";\n";
        let imps = imports_of(src, "src/app.ts");
        // "./util.js" → base src/util → candidates include src/util.ts AND src/util.js
        assert!(imps[0].candidate_paths.contains(&"src/util.ts".to_string()));
        assert!(imps[0].candidate_paths.contains(&"src/util.js".to_string()));
        // "./helpers" → src/helpers.* incl. .js and index variants
        assert!(imps[1]
            .candidate_paths
            .contains(&"src/helpers.js".to_string()));
        assert!(imps[1]
            .candidate_paths
            .contains(&"src/helpers/index.ts".to_string()));
    }
}
