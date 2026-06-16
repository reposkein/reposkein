//! C# definition + call extractor (Tree-sitter).
use tree_sitter::{Parser, Tree};

pub mod calls;
pub mod defs;

use reposkein_core::extractor::{ExtractOutput, Extractor, FileContext};

pub struct CsharpExtractor;

impl Extractor for CsharpExtractor {
    fn language(&self) -> &'static str {
        "csharp"
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
    parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
        .ok()?;
    parser.parse(source, None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reposkein_core::extractor::{Extractor, FileContext};

    #[test]
    fn parses_csharp() {
        let src = b"namespace N { class C {} }";
        let tree = parse(src).unwrap();
        assert_eq!(tree.root_node().kind(), "compilation_unit");
    }

    #[test]
    fn imports_always_empty_v1() {
        let src = b"using System;\nnamespace N { class C { void M() { Console.WriteLine(); } } }";
        let ctx = FileContext {
            repo: "r",
            rel_path: "src/N/C.cs",
            file_id: "rs1:r:file:src/N/C.cs",
            source: src,
        };
        let out = CsharpExtractor.extract(&ctx);
        assert!(out.imports.is_empty(), "v1: imports must be vec![]");
    }

    #[test]
    fn extraction_is_deterministic() {
        let src =
            b"namespace N { class MyClass { public void MyMethod(int x) { var y = x + 1; } } }";
        let ctx = FileContext {
            repo: "r",
            rel_path: "src/N/MyClass.cs",
            file_id: "rs1:r:file:src/N/MyClass.cs",
            source: src,
        };
        let a = CsharpExtractor.extract(&ctx);
        let b = CsharpExtractor.extract(&ctx);
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
        assert_eq!(a.calls, b.calls);
        assert_eq!(a.imports, b.imports);
    }
}
