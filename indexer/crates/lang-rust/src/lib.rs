//! Rust definition extractor (Tree-sitter): Function/Class(struct)/Interface
//! (trait)/Enum/Variable nodes and DEFINES/IMPLEMENTS edges.

use tree_sitter::{Parser, Tree};

pub mod calls;
pub mod defs;
pub mod imports;

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
        w.lower_heritage();
        let imports =
            imports::extract_imports(tree.root_node(), ctx.source, ctx.file_id, ctx.rel_path);
        ExtractOutput {
            nodes: w.nodes,
            edges: w.edges,
            calls: w.calls,
            imports,
            heritage: w.heritage,
            module_aliases: vec![],
            constructions: w.constructions,
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
    fn extractor_surfaces_calls() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let src = b"fn helper() -> u32 { 1 }\nstruct S;\nimpl S { fn run(&self) -> u32 { self.go() } fn go(&self) -> u32 { helper() } }";
        let ctx = FileContext {
            repo: "r",
            rel_path: "m.rs",
            file_id: "rs1:r:file:m.rs",
            source: src,
        };
        let out = RustExtractor.extract(&ctx);
        assert!(out
            .calls
            .iter()
            .any(|c| c.callee_name == "go" && c.receiver.as_deref() == Some("self")));
        assert!(out.calls.iter().any(|c| c.callee_name == "helper"));
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

    #[test]
    fn extract_surfaces_use_imports() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let ctx = FileContext {
            repo: "r",
            rel_path: "src/b.rs",
            file_id: "rs1:r:file:src/b.rs",
            source: b"use crate::a::helper;\npub fn run() { helper(); }\n",
        };
        let out = RustExtractor.extract(&ctx);
        assert!(
            out.imports
                .iter()
                .any(|i| i.candidate_paths.contains(&"src/a.rs".to_string())
                    && i.symbols.iter().any(|(l, _)| l == "helper")),
            "use crate::a::helper must yield a RawImport to src/a.rs"
        );
        assert!(out.calls.iter().any(|c| c.callee_name == "helper"));
    }

    #[test]
    fn foo_new_emits_construction_in_extract_output() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let src =
            b"struct Foo; impl Foo { fn new() -> Foo { Foo } } fn caller() { let x = Foo::new(); }";
        let ctx = FileContext {
            repo: "r",
            rel_path: "m.rs",
            file_id: "rs1:r:file:m.rs",
            source: src,
        };
        let out = RustExtractor.extract(&ctx);
        assert!(
            out.constructions.iter().any(|c| c.class_name == "Foo"),
            "Foo::new() must produce RawConstruction{{class_name:\"Foo\"}}"
        );
    }

    #[test]
    fn foo_new_construction_extraction_is_deterministic() {
        use reposkein_core::extractor::{Extractor, FileContext};
        let src =
            b"struct A; impl A { fn new() -> A { A } } fn run() { let _ = A::new(); }";
        let ctx = FileContext {
            repo: "r",
            rel_path: "m.rs",
            file_id: "rs1:r:file:m.rs",
            source: src,
        };
        let a = RustExtractor.extract(&ctx);
        let b = RustExtractor.extract(&ctx);
        assert_eq!(
            a.constructions, b.constructions,
            "constructions must be identical across extractions"
        );
    }

    #[test]
    fn foo_new_calls_and_instantiates_are_both_emitted() {
        // After resolution: Foo::new() → CALLS edge to Foo.new method (if in-repo) AND
        // INSTANTIATES edge to Foo class.
        use reposkein_core::extractor::{Extractor, FileContext};
        use reposkein_core::resolve::resolve_full;
        let src =
            b"struct Foo; impl Foo { fn new() -> Foo { Foo } } fn caller() { let x = Foo::new(); }";
        let ctx = FileContext {
            repo: "r",
            rel_path: "m.rs",
            file_id: "rs1:r:file:m.rs",
            source: src,
        };
        let out = RustExtractor.extract(&ctx);
        let (edges, _, _) = resolve_full(
            &out.nodes,
            &out.imports,
            &out.calls,
            &out.heritage,
            &out.module_aliases,
            &out.constructions,
            "r",
        );
        let has_instantiates = edges.iter().any(|e| e.typ == "INSTANTIATES");
        assert!(has_instantiates, "Foo::new() must resolve to INSTANTIATES edge");
        // CALLS edge to Foo.new() method should also exist (complementary).
        let has_calls_to_new = edges.iter().any(|e| e.typ == "CALLS");
        assert!(
            has_calls_to_new,
            "Foo::new() must also produce CALLS edge to new method"
        );
    }
}
