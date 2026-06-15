//! Java import extraction: import_declaration → RawImport with source-root
//! heuristic candidate paths.

use reposkein_core::extractor::RawImport;
use tree_sitter::Node as TsNode;

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

/// Source-root heuristic: find the last occurrence of src/main/java or
/// src/test/java in the path; return everything up to and including that
/// triple. Falls back to last bare "java" segment, then empty string.
fn source_root_dir(importing_path: &str) -> String {
    let segs: Vec<&str> = importing_path.split('/').collect();
    let n = segs.len();
    // Look for last src/main/java or src/test/java triple
    for i in (2..n).rev() {
        if segs[i] == "java"
            && (segs[i - 1] == "main" || segs[i - 1] == "test")
            && segs[i - 2] == "src"
        {
            return segs[..=i].join("/");
        }
    }
    // Fall back to last bare "java" segment
    for i in (0..n).rev() {
        if segs[i] == "java" {
            return segs[..=i].join("/");
        }
    }
    String::new()
}

/// Swap main↔test in a source root path.
fn swap_main_test(root: &str) -> Option<String> {
    if root.contains("/main/java") {
        Some(root.replace("/main/java", "/test/java"))
    } else if root.contains("/test/java") {
        Some(root.replace("/test/java", "/main/java"))
    } else {
        None
    }
}

/// Flatten a scoped_identifier or identifier into a dot-joined string.
fn flatten_fqn(node: TsNode, source: &[u8]) -> String {
    let mut segs = Vec::new();
    collect_fqn_segs(node, source, &mut segs);
    segs.join(".")
}

fn collect_fqn_segs(node: TsNode, source: &[u8], out: &mut Vec<String>) {
    match node.kind() {
        "scoped_identifier" => {
            if let Some(scope) = node.child_by_field_name("scope") {
                collect_fqn_segs(scope, source, out);
            }
            if let Some(name) = node.child_by_field_name("name") {
                out.push(text(name, source).to_string());
            }
        }
        "identifier" => {
            out.push(text(node, source).to_string());
        }
        _ => {
            // Try named children for other node kinds
            let mut c = node.walk();
            for child in node.named_children(&mut c) {
                collect_fqn_segs(child, source, out);
            }
        }
    }
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
        if child.kind() != "import_declaration" {
            continue;
        }

        // Check for static import or wildcard by scanning all (including anonymous) children
        let mut is_static = false;
        let mut has_asterisk = false;
        let mut fqn_node: Option<TsNode> = None;

        let mut cc = child.walk();
        for grandchild in child.children(&mut cc) {
            match grandchild.kind() {
                "static" => is_static = true,
                "asterisk" | "*" => has_asterisk = true,
                "scoped_identifier" | "identifier" if fqn_node.is_none() => {
                    fqn_node = Some(grandchild);
                }
                _ => {}
            }
        }

        // Also check text for wildcard pattern (safest: * may be unnamed)
        if text(child, source).contains(".*") {
            has_asterisk = true;
        }

        if is_static || has_asterisk {
            continue; // skip static and wildcard imports in v1
        }

        let Some(fqn_node) = fqn_node else { continue };
        let fqn = flatten_fqn(fqn_node, source);
        if fqn.is_empty() {
            continue;
        }

        // The last segment is the class name (local binding == original name)
        let segs: Vec<&str> = fqn.split('.').collect();
        let cls = segs.last().unwrap().to_string();
        let pkg_path = segs[..segs.len() - 1].join("/");

        let candidate_file = if pkg_path.is_empty() {
            format!("{cls}.java")
        } else {
            format!("{pkg_path}/{cls}.java")
        };

        let src_root = source_root_dir(importing_path);
        let mut candidates = Vec::new();

        // 1. Source-root-relative
        if !src_root.is_empty() {
            candidates.push(format!("{src_root}/{candidate_file}"));
            // 2. test↔main swap
            if let Some(swapped) = swap_main_test(&src_root) {
                candidates.push(format!("{swapped}/{candidate_file}"));
            }
        }
        // 3. Repo-root-relative (empty prefix)
        candidates.push(candidate_file);

        // Dedup preserving order
        let mut seen = std::collections::BTreeSet::new();
        candidates.retain(|p| seen.insert(p.clone()));

        out.push(RawImport {
            importing_file_id: importing_file_id.to_string(),
            importing_path: importing_path.to_string(),
            symbols: vec![(cls.clone(), cls)],
            candidate_paths: candidates,
        });
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
    fn import_simple_class() {
        let v = imps(
            b"package x;\nimport a.b.C;\nclass Svc {}\n",
            "proj/src/main/java/x/Svc.java",
        );
        assert_eq!(v.len(), 1);
        assert!(
            v[0].candidate_paths
                .contains(&"proj/src/main/java/a/b/C.java".to_string()),
            "source-root candidate missing: {:?}",
            v[0].candidate_paths
        );
        assert!(
            v[0].candidate_paths.contains(&"a/b/C.java".to_string()),
            "repo-root candidate missing: {:?}",
            v[0].candidate_paths
        );
        assert_eq!(v[0].symbols, vec![("C".to_string(), "C".to_string())]);
    }

    #[test]
    fn wildcard_skipped() {
        let v = imps(b"import a.b.*;\n", "src/main/java/x/Svc.java");
        assert!(v.is_empty());
    }

    #[test]
    fn static_import_skipped() {
        let v = imps(b"import static a.b.C.m;\n", "src/main/java/x/Svc.java");
        assert!(v.is_empty());
    }

    #[test]
    fn test_to_main_swap() {
        let v = imps(b"import a.b.C;\n", "proj/src/test/java/x/SvcTest.java");
        assert!(
            v[0].candidate_paths
                .contains(&"proj/src/test/java/a/b/C.java".to_string()),
            "test candidate missing: {:?}",
            v[0].candidate_paths
        );
        assert!(
            v[0].candidate_paths
                .contains(&"proj/src/main/java/a/b/C.java".to_string()),
            "main swap candidate missing: {:?}",
            v[0].candidate_paths
        );
    }

    #[test]
    fn deterministic() {
        let a = imps(
            b"import a.b.C;\nimport d.e.F;\n",
            "src/main/java/x/Svc.java",
        );
        let b = imps(
            b"import a.b.C;\nimport d.e.F;\n",
            "src/main/java/x/Svc.java",
        );
        assert_eq!(a, b);
    }
}
