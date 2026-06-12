//! Rust definition extractor (Tree-sitter): Function/Class(struct)/Interface
//! (trait)/Enum/Variable nodes and DEFINES/IMPLEMENTS edges.

use tree_sitter::{Parser, Tree};

pub mod defs;

use reposkein_core::extractor::{ExtractOutput, Extractor, FileContext};

pub struct RustExtractor;

impl Extractor for RustExtractor {
    fn language(&self) -> &'static str {
        "rust"
    }
    fn extract(&self, ctx: &FileContext) -> ExtractOutput {
        let Some(tree) = parse(ctx.source) else {
            return ExtractOutput::default();
        };
        let mut w = defs::Walk::new(ctx.repo, ctx.rel_path, ctx.source);
        w.walk(tree.root_node(), ctx.file_id);
        ExtractOutput {
            nodes: w.nodes,
            edges: w.edges,
            ..Default::default()
        }
    }
}

pub fn parse(source: &[u8]) -> Option<Tree> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_rust::LANGUAGE.into())
        .ok()?;
    parser.parse(source, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rust() {
        let src = b"fn f() {}\n";
        let tree = parse(src).unwrap();
        assert_eq!(tree.root_node().kind(), "source_file");
        assert_eq!(
            tree.root_node().named_child(0).unwrap().kind(),
            "function_item"
        );
    }

    #[test]
    fn extraction_is_deterministic() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let src = b"struct A;\nimpl A { fn m(&self) {} }\nfn f() {}\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "m.rs",
            file_id: "rs1:r:file:m.rs",
            source: src,
        };
        let a = RustExtractor.extract(&ctx);
        let b = RustExtractor.extract(&ctx);
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
    }
}
