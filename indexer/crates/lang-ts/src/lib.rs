//! TypeScript/TSX definition extractor (Tree-sitter). Produces Class/Function/
//! Interface/Enum/Variable nodes and DEFINES/INHERITS/IMPLEMENTS edges.

use tree_sitter::{Parser, Tree};

pub mod defs;

/// Returns true when the path should be parsed with the TSX (JSX-aware) grammar.
pub fn is_tsx_path(rel_path: &str) -> bool {
    rel_path.ends_with(".tsx") || rel_path.ends_with(".jsx")
}

/// Parses TS/TSX source. `tsx` selects the JSX-aware grammar; the plain TS
/// grammar must be used for `.ts` so type assertions (`<T>x`) aren't read as JSX.
pub fn parse(source: &[u8], tsx: bool) -> Option<Tree> {
    let lang = if tsx {
        tree_sitter_typescript::LANGUAGE_TSX
    } else {
        tree_sitter_typescript::LANGUAGE_TYPESCRIPT
    };
    let mut parser = Parser::new();
    parser.set_language(&lang.into()).ok()?;
    parser.parse(source, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_typescript() {
        let src = b"function f(): void {}\n";
        let tree = parse(src, false).unwrap();
        assert_eq!(tree.root_node().kind(), "program");
        let f = tree.root_node().named_child(0).unwrap();
        assert_eq!(f.kind(), "function_declaration");
    }

    #[test]
    fn ts_grammar_handles_type_assertions_tsx_would_misparse() {
        // `<Foo>bar` is a type assertion in .ts (clean) but JSX in .tsx (error).
        let src = b"const x = <Foo>bar;\n";
        assert!(!parse(src, false).unwrap().root_node().has_error());
        assert!(parse(src, true).unwrap().root_node().has_error());
    }
}
