//! Python import extraction → RawImport with candidate target file paths.

use reposkein_core::extractor::RawImport;
use tree_sitter::Node as TsNode;

fn text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

/// `["a","b","c"]` → `["a/b/c.py", "a/b/c/__init__.py"]`. Empty parts → empty.
fn candidates(parts: &[String]) -> Vec<String> {
    if parts.is_empty() {
        return Vec::new();
    }
    let base = parts.join("/");
    vec![format!("{base}.py"), format!("{base}/__init__.py")]
}

/// Directory segments of a repo-relative file path: "app/svc.py" → ["app"].
fn dir_parts(rel_path: &str) -> Vec<String> {
    let mut parts: Vec<String> = rel_path.split('/').map(|s| s.to_string()).collect();
    parts.pop(); // drop filename
    parts
}

/// Collects the identifier segments of a `dotted_name` node.
fn dotted_parts(node: TsNode, source: &[u8]) -> Vec<String> {
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .filter(|c| c.kind() == "identifier")
        .map(|c| text(c, source).to_string())
        .collect()
}

/// Extracts all imports in a module subtree, given the importing file context.
pub fn extract_imports(
    root: TsNode,
    source: &[u8],
    importing_file_id: &str,
    importing_path: &str,
) -> Vec<RawImport> {
    let mut out = Vec::new();
    let mut cursor = root.walk();
    for child in root.named_children(&mut cursor) {
        match child.kind() {
            "import_statement" => {
                // `import a.b.c` / `import a.b.c as d` — one or more names.
                let mut nc = child.walk();
                for name in child.named_children(&mut nc) {
                    let dotted = if name.kind() == "aliased_import" {
                        name.child_by_field_name("name")
                    } else if name.kind() == "dotted_name" {
                        Some(name)
                    } else {
                        None
                    };
                    if let Some(d) = dotted {
                        let parts = dotted_parts(d, source);
                        out.push(RawImport {
                            importing_file_id: importing_file_id.to_string(),
                            importing_path: importing_path.to_string(),
                            symbols: Vec::new(),
                            candidate_paths: candidates(&parts),
                        });
                    }
                }
            }
            "import_from_statement" => {
                let module = child.child_by_field_name("module_name");
                // Resolve the module to base path parts (absolute or relative).
                let base_parts: Vec<String> = match module {
                    Some(m) if m.kind() == "dotted_name" => dotted_parts(m, source),
                    Some(m) if m.kind() == "relative_import" => {
                        // level = number of dots in import_prefix
                        let mut level = 0usize;
                        let mut mod_parts: Vec<String> = Vec::new();
                        let mut mc = m.walk();
                        for part in m.named_children(&mut mc) {
                            match part.kind() {
                                "import_prefix" => {
                                    level = text(part, source).chars().filter(|c| *c == '.').count();
                                }
                                "dotted_name" => mod_parts = dotted_parts(part, source),
                                _ => {}
                            }
                        }
                        let mut base = dir_parts(importing_path);
                        for _ in 0..level.saturating_sub(1) {
                            base.pop();
                        }
                        base.extend(mod_parts);
                        base
                    }
                    _ => Vec::new(),
                };
                // Imported symbol names.
                let mut symbols = Vec::new();
                let mut nc = child.walk();
                for name in child.named_children(&mut nc) {
                    if Some(name) == module {
                        continue;
                    }
                    match name.kind() {
                        "dotted_name" => {
                            if let Some(first) =
                                dotted_parts(name, source).into_iter().next()
                            {
                                symbols.push(first);
                            }
                        }
                        "aliased_import" => {
                            if let Some(n) = name.child_by_field_name("name") {
                                if let Some(first) = dotted_parts(n, source).into_iter().next() {
                                    symbols.push(first);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                out.push(RawImport {
                    importing_file_id: importing_file_id.to_string(),
                    importing_path: importing_path.to_string(),
                    symbols,
                    candidate_paths: candidates(&base_parts),
                });
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn imports_of(src: &[u8], path: &str) -> Vec<RawImport> {
        let tree = parse(src).unwrap();
        extract_imports(tree.root_node(), src, "fid", path)
    }

    #[test]
    fn absolute_and_relative_imports() {
        let src = b"import a.b.c\nfrom x.y import z\nfrom .base import Base\nfrom ..pkg import thing\n";
        let imps = imports_of(src, "app/svc.py");

        // import a.b.c
        assert_eq!(imps[0].candidate_paths, vec!["a/b/c.py", "a/b/c/__init__.py"]);
        assert!(imps[0].symbols.is_empty());

        // from x.y import z
        assert_eq!(imps[1].candidate_paths, vec!["x/y.py", "x/y/__init__.py"]);
        assert_eq!(imps[1].symbols, vec!["z"]);

        // from .base import Base  (level 1: package = app/)
        assert_eq!(imps[2].candidate_paths, vec!["app/base.py", "app/base/__init__.py"]);
        assert_eq!(imps[2].symbols, vec!["Base"]);

        // from ..pkg import thing (level 2 from app/svc.py: drop "app", → pkg)
        assert_eq!(imps[3].candidate_paths, vec!["pkg.py", "pkg/__init__.py"]);
        assert_eq!(imps[3].symbols, vec!["thing"]);
    }
}
