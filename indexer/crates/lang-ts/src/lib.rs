//! TypeScript/TSX definition extractor (Tree-sitter). Produces Class/Function/
//! Interface/Enum/Variable nodes and DEFINES/INHERITS/IMPLEMENTS edges.

use tree_sitter::{Parser, Tree};

pub mod calls;
pub mod defs;
pub mod imports;

use reposkein_core::extractor::{ExtractOutput, Extractor, FileContext};

/// Shared TS/JS extraction: grammar chosen by extension (.jsx/.tsx → TSX,
/// else the TS grammar which also parses plain JS). Same defs/imports/calls.
pub fn extract_module(ctx: &FileContext) -> ExtractOutput {
    let Some(tree) = parse(ctx.source, is_tsx_path(ctx.rel_path)) else {
        return ExtractOutput::default();
    };
    let root = tree.root_node();
    let imports = imports::extract_imports(root, ctx.source, ctx.file_id, ctx.rel_path);
    let mut w = defs::Walk::new(ctx.repo, ctx.rel_path, ctx.source);
    w.walk(root, &[], ctx.file_id, defs::ScopeKind::Module);
    w.lower_heritage();
    ExtractOutput {
        nodes: w.nodes,
        edges: w.edges,
        imports,
        calls: w.calls,
        heritage: w.heritage,
        module_aliases: vec![],
        constructions: w.constructions,
    }
}

pub struct TypeScriptExtractor;

impl Extractor for TypeScriptExtractor {
    fn language(&self) -> &'static str {
        "typescript"
    }
    fn extract(&self, ctx: &FileContext) -> ExtractOutput {
        extract_module(ctx)
    }
}

pub struct JavaScriptExtractor;

impl Extractor for JavaScriptExtractor {
    fn language(&self) -> &'static str {
        "javascript"
    }
    fn extract(&self, ctx: &FileContext) -> ExtractOutput {
        extract_module(ctx)
    }
}

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
    fn extraction_is_deterministic() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let src = b"class A { m(x) {} }\nfunction f() {}\nconst g = () => 1;\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "m.ts",
            file_id: "rs1:r:file:m.ts",
            source: src,
        };
        let a = TypeScriptExtractor.extract(&ctx);
        let b = TypeScriptExtractor.extract(&ctx);
        assert_eq!(a.nodes, b.nodes);
        assert_eq!(a.edges, b.edges);
    }

    #[test]
    fn parses_typescript() {
        let src = b"function f(): void {}\n";
        let tree = parse(src, false).unwrap();
        assert_eq!(tree.root_node().kind(), "program");
        let f = tree.root_node().named_child(0).unwrap();
        assert_eq!(f.kind(), "function_declaration");
    }

    #[test]
    fn extractor_surfaces_imports_and_calls() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let src = b"import { helper } from \"./util\";\nfunction run() { return helper(); }\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "src/svc.ts",
            file_id: "rs1:r:file:src/svc.ts",
            source: src,
        };
        let out = TypeScriptExtractor.extract(&ctx);
        assert_eq!(out.imports.len(), 1);
        assert_eq!(
            out.imports[0].symbols,
            vec![("helper".to_string(), "helper".to_string())]
        );
        assert!(out.calls.iter().any(|c| c.callee_name == "helper"));
    }

    #[test]
    fn ts_grammar_handles_type_assertions_tsx_would_misparse() {
        // `<Foo>bar` is a type assertion in .ts (clean) but JSX in .tsx (error).
        let src = b"const x = <Foo>bar;\n";
        assert!(!parse(src, false).unwrap().root_node().has_error());
        assert!(parse(src, true).unwrap().root_node().has_error());
    }

    #[test]
    fn javascript_extractor_handles_js() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let src = b"export function f(a) { return a; }\nclass C { m() {} }\n";
        let ctx = FileContext {
            repo: "r",
            rel_path: "m.js",
            file_id: "rs1:r:file:m.js",
            source: src,
        };
        let out = JavaScriptExtractor.extract(&ctx);
        assert_eq!(JavaScriptExtractor.language(), "javascript");
        assert!(out.nodes.iter().any(|n| n.id == "rs1:r:func:m.js#f@1"));
        assert!(out.nodes.iter().any(|n| n.id == "rs1:r:class:m.js#C"));
        assert!(out.nodes.iter().any(|n| n.id == "rs1:r:func:m.js#C.m@0"));
    }
}
