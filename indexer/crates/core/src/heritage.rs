//! Heritage resolution helpers shared by the language extractors.
//! `PendingHeritage` accumulates during the per-file walk; `lower` converts it
//! to `RawHeritage` facts (from-side resolved in-file, base left for repo-wide
//! resolution by `core::resolve::resolve_heritage`).

use crate::extractor::RawHeritage;
use std::collections::HashMap;

/// A heritage relationship awaiting resolution. `from_name` (the declaring or
/// impl-ing type) and `base_name` are both resolved within `decl_scope` (the
/// enclosing scope where the relationship is written).
#[derive(Debug, Clone, PartialEq)]
pub struct PendingHeritage {
    pub decl_scope: Vec<String>,
    pub from_name: String,
    pub edge_type: String,
    pub base_name: String,
}

/// Resolves `name` referenced within `scope` to a declared qualified name,
/// trying `scope.name`, dropping one scope level at a time, down to bare `name`.
fn resolve_name<'a>(
    declared: &'a HashMap<String, String>,
    scope: &[String],
    name: &str,
) -> Option<&'a String> {
    for i in (0..=scope.len()).rev() {
        let candidate = if i == 0 {
            name.to_string()
        } else {
            format!("{}.{}", scope[..i].join("."), name)
        };
        if let Some(id) = declared.get(&candidate) {
            return Some(id);
        }
    }
    None
}

/// Lowers pending heritage into `RawHeritage` facts for the cross-file resolver
/// (`core::resolve::resolve_heritage`). The **from-side** is resolved here,
/// against the file-local `declared` map (identical gating to the old in-file
/// resolver: an unresolved from-side emits nothing). The **base** is left as a
/// name for repo-wide resolution. Input order is preserved.
pub fn lower(
    pending: &[PendingHeritage],
    declared: &HashMap<String, String>,
    from_path: &str,
    from_file_id: &str,
    label_refine: bool,
) -> Vec<RawHeritage> {
    let mut out = Vec::new();
    for p in pending {
        let Some(from_id) = resolve_name(declared, &p.decl_scope, &p.from_name) else {
            continue;
        };
        out.push(RawHeritage {
            from_id: from_id.clone(),
            from_path: from_path.to_string(),
            from_file_id: from_file_id.to_string(),
            edge_type: p.edge_type.clone(),
            base_name: p.base_name.clone(),
            label_refine,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn lowers_when_from_side_resolves() {
        let d = declared(&[("B", "rs1:r:class:m.py#B")]);
        let p = vec![PendingHeritage {
            decl_scope: vec![],
            from_name: "B".into(),
            edge_type: "INHERITS".into(),
            base_name: "A".into(),
        }];
        let raw = lower(&p, &d, "m.py", "rs1:r:file:m.py", false);
        assert_eq!(raw.len(), 1);
        assert_eq!(raw[0].from_id, "rs1:r:class:m.py#B");
        assert_eq!(raw[0].base_name, "A");
        assert_eq!(raw[0].edge_type, "INHERITS");
        assert!(!raw[0].label_refine);
    }

    #[test]
    fn skips_when_from_side_does_not_resolve() {
        // Rust `impl Trait for ExternalType` — the from-type is not local.
        let d = declared(&[("Greeter", "rs1:r:iface:m.rs#Greeter")]);
        let p = vec![PendingHeritage {
            decl_scope: vec![],
            from_name: "ExternalType".into(),
            edge_type: "IMPLEMENTS".into(),
            base_name: "Greeter".into(),
        }];
        assert!(lower(&p, &d, "m.rs", "rs1:r:file:m.rs", false).is_empty());
    }

    #[test]
    fn lowers_nested_from_side_via_scope() {
        // class Outer: class B(A) → from `B` resolves to Outer.B via scope.
        let d = declared(&[("Outer.B", "rs1:r:class:m.py#Outer.B")]);
        let p = vec![PendingHeritage {
            decl_scope: vec!["Outer".into()],
            from_name: "B".into(),
            edge_type: "INHERITS".into(),
            base_name: "A".into(),
        }];
        let raw = lower(&p, &d, "m.py", "rs1:r:file:m.py", false);
        assert_eq!(raw.len(), 1);
        assert_eq!(raw[0].from_id, "rs1:r:class:m.py#Outer.B");
    }

    #[test]
    fn label_refine_flag_carried() {
        let d = declared(&[("C", "rs1:r:class:m.cs#N.C")]);
        let p = vec![PendingHeritage {
            decl_scope: vec![],
            from_name: "C".into(),
            edge_type: "INHERITS".into(),
            base_name: "IFoo".into(),
        }];
        let raw = lower(&p, &d, "N/C.cs", "rs1:r:file:N/C.cs", true);
        assert!(raw[0].label_refine);
    }
}
