//! Java definition + call + import extractor (Tree-sitter).
use tree_sitter::{Parser, Tree};

pub mod calls;
pub mod defs;
pub mod imports;

use reposkein_core::extractor::{ExtractOutput, Extractor, FileContext};

pub struct JavaExtractor;

impl Extractor for JavaExtractor {
    fn language(&self) -> &'static str {
        "java"
    }
    fn extract(&self, ctx: &FileContext) -> ExtractOutput {
        let Some(tree) = parse(ctx.source) else {
            return ExtractOutput::default();
        };
        let mut w = defs::Walk::new(ctx.repo, ctx.rel_path, ctx.source);
        w.walk(tree.root_node(), ctx.file_id);
        w.finalize_heritage();
        let imports =
            imports::extract_imports(tree.root_node(), ctx.source, ctx.file_id, ctx.rel_path);
        ExtractOutput {
            nodes: w.nodes,
            edges: w.edges,
            calls: w.calls,
            imports,
        }
    }
}

pub fn parse(source: &[u8]) -> Option<Tree> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_java::LANGUAGE.into())
        .ok()?;
    parser.parse(source, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reposkein_core::extractor::{Extractor, FileContext};

    #[test]
    fn parses_java() {
        let src = b"package p;\nclass A {}\n";
        let tree = parse(src).unwrap();
        assert_eq!(tree.root_node().kind(), "program");
    }

    #[test]
    fn extraction_is_deterministic() {
        let src = b"package p;\nclass Svc { void run(int a) {} }\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "p/Svc.java",
            file_id: "rs1:r:file:p/Svc.java",
            source: src,
        };
        let a = JavaExtractor.extract(&ctx);
        let b = JavaExtractor.extract(&ctx);
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
        assert_eq!(a.calls, b.calls);
        assert_eq!(a.imports, b.imports);
    }
}
