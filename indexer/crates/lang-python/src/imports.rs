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

const IMPORT_CONTAINERS: &[&str] = &[
    "if_statement",
    "elif_clause",
    "else_clause",
    "try_statement",
    "except_clause",
    "except_group_clause",
    "finally_clause",
    "with_statement",
    "for_statement",
    "while_statement",
    "match_statement",
    "case_clause",
    "block",
];

fn push_import(
    child: TsNode,
    source: &[u8],
    importing_file_id: &str,
    importing_path: &str,
    out: &mut Vec<RawImport>,
) {
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
            // Imported symbol names as (local_binding, original_name) pairs.
            let mut symbols: Vec<(String, String)> = Vec::new();
            let mut nc = child.walk();
            for name in child.named_children(&mut nc) {
                if Some(name) == module {
                    continue;
                }
                match name.kind() {
                    "dotted_name" => {
                        if let Some(first) = dotted_parts(name, source).into_iter().next() {
                            symbols.push((first.clone(), first));
                        }
                    }
                    "aliased_import" => {
                        let original = name
                            .child_by_field_name("name")
                            .and_then(|n| dotted_parts(n, source).into_iter().next())
                            .unwrap_or_default();
                        let local = name
                            .child_by_field_name("alias")
                            .map(|a| text(a, source).to_string())
                            .unwrap_or_else(|| original.clone());
                        if !original.is_empty() {
                            symbols.push((local, original));
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

fn collect_imports(
    node: TsNode,
    source: &[u8],
    importing_file_id: &str,
    importing_path: &str,
    out: &mut Vec<RawImport>,
) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "import_statement" | "import_from_statement" => {
                push_import(child, source, importing_file_id, importing_path, out);
            }
            k if IMPORT_CONTAINERS.contains(&k) => {
                collect_imports(child, source, importing_file_id, importing_path, out);
            }
            _ => {} // do not descend into function/class bodies (local imports excluded)
        }
    }
}

/// Extracts all imports in a module subtree, given the importing file context.
pub fn extract_imports(
    root: TsNode,
    source: &[u8],
    importing_file_id: &str,
    importing_path: &str,
) -> Vec<RawImport> {
    let mut out = Vec::new();
    collect_imports(root, source, importing_file_id, importing_path, &mut out);
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
    fn finds_imports_in_try_and_if_blocks() {
        let src = b"try:\n    from app.fast import go\nexcept ImportError:\n    from app.slow import go\n\nif TYPE_CHECKING:\n    from app.types import T\n";
        let imps = imports_of(src, "app/svc.py");
        let locals: Vec<&str> = imps
            .iter()
            .flat_map(|i| i.symbols.iter().map(|(local, _)| local.as_str()))
            .collect();
        assert!(locals.contains(&"go"), "import in try-block found");
        assert!(locals.contains(&"T"), "import in if-block found");
    }

    #[test]
    fn absolute_and_relative_imports() {
        let src =
            b"import a.b.c\nfrom x.y import z\nfrom .base import Base\nfrom ..pkg import thing\n";
        let imps = imports_of(src, "app/svc.py");

        // import a.b.c
        assert_eq!(
            imps[0].candidate_paths,
            vec!["a/b/c.py", "a/b/c/__init__.py"]
        );
        assert!(imps[0].symbols.is_empty());

        // from x.y import z
        assert_eq!(imps[1].candidate_paths, vec!["x/y.py", "x/y/__init__.py"]);
        assert_eq!(imps[1].symbols, vec![("z".into(), "z".into())]);

        // from .base import Base  (level 1: package = app/)
        assert_eq!(
            imps[2].candidate_paths,
            vec!["app/base.py", "app/base/__init__.py"]
        );
        assert_eq!(imps[2].symbols, vec![("Base".into(), "Base".into())]);

        // from ..pkg import thing (level 2 from app/svc.py: drop "app", → pkg)
        assert_eq!(imps[3].candidate_paths, vec!["pkg.py", "pkg/__init__.py"]);
        assert_eq!(imps[3].symbols, vec![("thing".into(), "thing".into())]);
    }

    #[test]
    fn aliased_import_records_local_and_original() {
        let imps = imports_of(b"from app.util import helper as h\n", "app/svc.py");
        assert_eq!(imps[0].symbols, vec![("h".to_string(), "helper".to_string())]);
    }
}
