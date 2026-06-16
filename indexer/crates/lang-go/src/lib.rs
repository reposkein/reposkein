//! Go definition + call extractor (Tree-sitter).
use tree_sitter::{Parser, Tree};

pub mod calls;
pub mod defs;

use reposkein_core::extractor::{ExtractOutput, Extractor, FileContext};

pub struct GoExtractor;

impl Extractor for GoExtractor {
    fn language(&self) -> &'static str {
        "go"
    }
    fn extract(&self, ctx: &FileContext) -> ExtractOutput {
        let Some(tree) = parse(ctx.source) else {
            return ExtractOutput::default();
        };
        let mut w = defs::Walk::new(ctx.repo, ctx.rel_path, ctx.source);
        w.walk(tree.root_node(), ctx.file_id);
        w.lower_heritage();
        ExtractOutput {
            nodes: w.nodes,
            edges: w.edges,
            calls: w.calls,
            imports: vec![],
            heritage: w.heritage,
            module_aliases: vec![],
            constructions: w.constructions,
        }
    }
}

pub fn parse(source: &[u8]) -> Option<Tree> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_go::LANGUAGE.into()).ok()?;
    parser.parse(source, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reposkein_core::extractor::{Extractor, FileContext};

    #[test]
    fn parses_go() {
        let src = b"package p\nfunc f() {}\n";
        let tree = parse(src).unwrap();
        assert_eq!(tree.root_node().kind(), "source_file");
    }

    #[test]
    fn extraction_is_deterministic() {
        let src = b"package p\ntype S struct{}\nfunc (s *S) M(a, b int) {}\nfunc Free() {}\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "pkg/m.go",
            file_id: "rs1:r:file:pkg/m.go",
            source: src,
        };
        let a = GoExtractor.extract(&ctx);
        let b = GoExtractor.extract(&ctx);
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
        assert_eq!(a.calls, b.calls);
        assert_eq!(a.imports, b.imports);
    }

    #[test]
    fn extractor_surfaces_calls() {
        let src = b"package p\nfunc helper() {}\nfunc run() { helper() }\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "pkg/m.go",
            file_id: "rs1:r:file:pkg/m.go",
            source: src,
        };
        let out = GoExtractor.extract(&ctx);
        assert!(out.calls.iter().any(|c| c.callee_name == "helper"));
    }

    #[test]
    fn imports_always_empty_v1() {
        let src = b"package p\nimport \"fmt\"\nfunc f() { fmt.Println() }\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "pkg/m.go",
            file_id: "rs1:r:file:pkg/m.go",
            source: src,
        };
        let out = GoExtractor.extract(&ctx);
        assert!(out.imports.is_empty(), "v1: imports must be vec![]");
    }
}

#[cfg(test)]
mod resolve_tests {
    use super::*;
    use reposkein_core::extractor::FileContext;
    use reposkein_core::resolve::resolve;

    #[test]
    fn intra_package_bare_call_resolves() {
        // pkg/a.go defines Helper; pkg/b.go's Run calls Helper() bare (same package).
        let a_ctx = FileContext {
            repo: "r",
            rel_path: "pkg/a.go",
            file_id: "rs1:r:file:pkg/a.go",
            source: b"package p\nfunc Helper() {}\n",
        };
        let b_ctx = FileContext {
            repo: "r",
            rel_path: "pkg/b.go",
            file_id: "rs1:r:file:pkg/b.go",
            source: b"package p\nfunc Run() { Helper() }\n",
        };
        let a = GoExtractor.extract(&a_ctx);
        let b = GoExtractor.extract(&b_ctx);
        let mut nodes = a.nodes.clone();
        nodes.extend(b.nodes.clone());
        let mut calls = a.calls.clone();
        calls.extend(b.calls.clone());
        let edges = resolve(&nodes, &[], &calls, "r");
        let e = edges
            .iter()
            .find(|e| e.typ == "CALLS" && e.to == "rs1:r:func:pkg/a.go#Helper@0")
            .expect("Run -> Helper CALLS edge");
        // Helper is unique repo-wide → name_match 0.7 (rungs 4/5); if duplicated,
        // the same-dir rung 3.5 would pick the pkg/ one at 0.8. Either is a real edge.
        let res = e.props.get("resolution").and_then(|v| v.as_str());
        assert!(
            res == Some("name_match") || res == Some("exact"),
            "got {res:?}"
        );
    }
}
