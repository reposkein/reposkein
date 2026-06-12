//! Python definition extractor (Tree-sitter). Produces Class/Function/Variable
//! nodes and DEFINES/INHERITS edges. Pure static analysis — deterministic.

pub mod defs;

use tree_sitter::{Node as TsNode, Parser, Tree};

/// Parses Python source into a Tree-sitter CST. Returns None on parser-setup
/// failure (should not happen with a pinned grammar).
pub fn parse(source: &[u8]) -> Option<Tree> {
    let mut parser = Parser::new();
    parser
        .set_language(&tree_sitter_python::LANGUAGE.into())
        .ok()?;
    parser.parse(source, None)
}

/// Returns the text of a node as a string slice of `source`.
fn node_text<'a>(node: TsNode, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or("")
}

use reposkein_core::extractor::{ExtractOutput, Extractor, FileContext};

pub struct PythonExtractor;

impl Extractor for PythonExtractor {
    fn language(&self) -> &'static str {
        "python"
    }

    fn extract(&self, ctx: &FileContext) -> ExtractOutput {
        let Some(tree) = parse(ctx.source) else {
            return ExtractOutput::default();
        };
        let mut w = defs::Walk::new(ctx.repo, ctx.rel_path, ctx.file_id, ctx.source);
        w.walk(
            tree.root_node(),
            &[],
            ctx.file_id,
            defs::ScopeKind::Module,
        );
        ExtractOutput {
            nodes: w.nodes,
            edges: w.edges,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_python_module() {
        let src = b"def foo():\n    pass\n";
        let tree = parse(src).expect("parse");
        assert_eq!(tree.root_node().kind(), "module");
        let func = tree.root_node().named_child(0).unwrap();
        assert_eq!(func.kind(), "function_definition");
        assert_eq!(
            node_text(func.child_by_field_name("name").unwrap(), src),
            "foo"
        );
    }

    #[test]
    fn extractor_trait_produces_function_node() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let src = b"def foo():\n    pass\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "m.py",
            file_id: "rs1:r:file:m.py",
            source: src,
        };
        let out = PythonExtractor.extract(&ctx);
        assert!(out.nodes.iter().any(|n| n.id == "rs1:r:func:m.py#foo@0"));
        assert_eq!(PythonExtractor.language(), "python");
    }
}
