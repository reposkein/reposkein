//! Rust definition extractor (Tree-sitter): Function/Class(struct)/Interface
//! (trait)/Enum/Variable nodes and DEFINES/IMPLEMENTS edges.

use tree_sitter::{Parser, Tree};

pub mod defs;

pub fn parse(source: &[u8]) -> Option<Tree> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_rust::LANGUAGE.into()).ok()?;
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
        assert_eq!(tree.root_node().named_child(0).unwrap().kind(), "function_item");
    }
}
