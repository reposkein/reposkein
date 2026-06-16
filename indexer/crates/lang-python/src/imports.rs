//! Python import extraction → RawImport with candidate target file paths.

use reposkein_core::extractor::{RawImport, RawModuleAlias};
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
    out_aliases: &mut Vec<RawModuleAlias>,
) {
    match child.kind() {
        "import_statement" => {
            // `import a.b.c` / `import a.b.c as d` — one or more names.
            let mut nc = child.walk();
            for name in child.named_children(&mut nc) {
                if name.kind() == "aliased_import" {
                    // `import foo as f` or `import a.b.c as x`
                    // Emit both a RawImport (for the IMPORTS edge) and a
                    // RawModuleAlias (for module-alias call resolution rung 1.5).
                    if let Some(d) = name.child_by_field_name("name") {
                        let parts = dotted_parts(d, source);
                        let cand = candidates(&parts);
                        out.push(RawImport {
                            importing_file_id: importing_file_id.to_string(),
                            importing_path: importing_path.to_string(),
                            symbols: Vec::new(),
                            candidate_paths: cand.clone(),
                            reexport: false,
                        });
                        // The alias is the local name bound in this namespace.
                        let alias = name
                            .child_by_field_name("alias")
                            .map(|a| text(a, source).to_string())
                            .unwrap_or_default();
                        if !alias.is_empty() {
                            out_aliases.push(RawModuleAlias {
                                importing_file_id: importing_file_id.to_string(),
                                importing_path: importing_path.to_string(),
                                local_alias: alias,
                                candidate_paths: cand,
                            });
                        }
                    }
                } else if name.kind() == "dotted_name" {
                    // `import foo` or `import a.b.c` (no `as`).
                    // For `import foo`, Python binds "foo" → emit a RawModuleAlias.
                    // For `import a.b.c` (multi-segment, no `as`), Python only binds
                    // the top-level name "a", NOT "c" — do NOT emit a RawModuleAlias
                    // (to avoid false aliases). The caller must write `import a.b.c as x`.
                    let parts = dotted_parts(name, source);
                    let cand = candidates(&parts);
                    out.push(RawImport {
                        importing_file_id: importing_file_id.to_string(),
                        importing_path: importing_path.to_string(),
                        symbols: Vec::new(),
                        candidate_paths: cand.clone(),
                        reexport: false,
                    });
                    // Only single-segment bare imports (e.g. `import foo`) bind
                    // the module name directly.
                    if parts.len() == 1 {
                        out_aliases.push(RawModuleAlias {
                            importing_file_id: importing_file_id.to_string(),
                            importing_path: importing_path.to_string(),
                            local_alias: parts[0].clone(),
                            candidate_paths: cand,
                        });
                    }
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
                reexport: false,
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
    out_aliases: &mut Vec<RawModuleAlias>,
) {
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "import_statement" | "import_from_statement" => {
                push_import(
                    child,
                    source,
                    importing_file_id,
                    importing_path,
                    out,
                    out_aliases,
                );
            }
            k if IMPORT_CONTAINERS.contains(&k) => {
                collect_imports(
                    child,
                    source,
                    importing_file_id,
                    importing_path,
                    out,
                    out_aliases,
                );
            }
            _ => {} // do not descend into function/class bodies (local imports excluded)
        }
    }
}

/// Extracts all imports in a module subtree, given the importing file context.
/// Returns `(imports, module_aliases)`.
pub fn extract_imports(
    root: TsNode,
    source: &[u8],
    importing_file_id: &str,
    importing_path: &str,
) -> (Vec<RawImport>, Vec<RawModuleAlias>) {
    let mut out = Vec::new();
    let mut out_aliases = Vec::new();
    collect_imports(
        root,
        source,
        importing_file_id,
        importing_path,
        &mut out,
        &mut out_aliases,
    );
    (out, out_aliases)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn imports_of(src: &[u8], path: &str) -> Vec<RawImport> {
        let tree = parse(src).unwrap();
        extract_imports(tree.root_node(), src, "fid", path).0
    }

    fn aliases_of(src: &[u8], path: &str) -> Vec<RawModuleAlias> {
        let tree = parse(src).unwrap();
        extract_imports(tree.root_node(), src, "fid", path).1
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
        assert_eq!(
            imps[0].symbols,
            vec![("h".to_string(), "helper".to_string())]
        );
    }

    // --- Module alias tests (design §10, extractor test plan) ---

    #[test]
    fn alias_import_emits_module_alias() {
        // `import foo as f` → RawModuleAlias { local_alias:"f", candidate_paths:["foo.py","foo/__init__.py"] }
        let aliases = aliases_of(b"import foo as f\n", "svc.py");
        assert_eq!(aliases.len(), 1, "one alias emitted");
        assert_eq!(aliases[0].local_alias, "f");
        assert_eq!(
            aliases[0].candidate_paths,
            vec!["foo.py", "foo/__init__.py"]
        );
    }

    #[test]
    fn bare_import_emits_module_alias() {
        // `import foo` → RawModuleAlias { local_alias:"foo", candidate_paths:["foo.py","foo/__init__.py"] }
        let aliases = aliases_of(b"import foo\n", "svc.py");
        assert_eq!(aliases.len(), 1, "one alias emitted for bare import");
        assert_eq!(aliases[0].local_alias, "foo");
        assert_eq!(
            aliases[0].candidate_paths,
            vec!["foo.py", "foo/__init__.py"]
        );
    }

    #[test]
    fn dotted_alias_emits_last_alias() {
        // `import a.b.c as x` → RawModuleAlias { local_alias:"x", candidate_paths:["a/b/c.py","a/b/c/__init__.py"] }
        let aliases = aliases_of(b"import a.b.c as x\n", "svc.py");
        assert_eq!(aliases.len(), 1, "one alias for dotted aliased import");
        assert_eq!(aliases[0].local_alias, "x");
        assert_eq!(
            aliases[0].candidate_paths,
            vec!["a/b/c.py", "a/b/c/__init__.py"]
        );
    }

    #[test]
    fn bare_dotted_no_alias() {
        // `import a.b.c` (no `as`) → NO RawModuleAlias
        // Python only binds "a" (not "c") in the namespace; we cannot track
        // `c` as a valid single-identifier alias.
        let aliases = aliases_of(b"import a.b.c\n", "svc.py");
        assert!(
            aliases.is_empty(),
            "bare dotted import without alias must emit no RawModuleAlias"
        );
    }

    #[test]
    fn from_import_no_module_alias() {
        // `from pkg import mod` → No RawModuleAlias (symbol import, not module alias)
        let aliases = aliases_of(b"from pkg import mod\n", "svc.py");
        assert!(
            aliases.is_empty(),
            "from-import must not emit RawModuleAlias"
        );
    }
}
