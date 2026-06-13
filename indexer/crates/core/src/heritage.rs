//! Intra-file heritage (INHERITS/IMPLEMENTS) resolution shared by the language
//! extractors. Base/trait names are written bare or scope-relative; this maps
//! each endpoint to a declared type's node id by trying scope-prefixed
//! candidates (most→least specific), so nested and cross-scope references
//! resolve instead of dangling. An edge is emitted only when BOTH endpoints are
//! declared in-file (external bases are simply not linked — the same observable
//! result as the old dangling-then-dropped behavior).

use crate::model::Edge;
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

/// Resolves pending heritage into edges (input order preserved). Emits an edge
/// only when both endpoints resolve to declared in-file types.
pub fn resolve(pending: &[PendingHeritage], declared: &HashMap<String, String>) -> Vec<Edge> {
    let mut out = Vec::new();
    for p in pending {
        let (Some(from_id), Some(to_id)) = (
            resolve_name(declared, &p.decl_scope, &p.from_name),
            resolve_name(declared, &p.decl_scope, &p.base_name),
        ) else {
            continue;
        };
        out.push(Edge::new(
            from_id.clone(),
            p.edge_type.clone(),
            to_id.clone(),
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declared(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn resolves_top_level_inherits() {
        let d = declared(&[("A", "idA"), ("B", "idB")]);
        let p = vec![PendingHeritage {
            decl_scope: vec![],
            from_name: "B".into(),
            edge_type: "INHERITS".into(),
            base_name: "A".into(),
        }];
        let e = resolve(&p, &d);
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].from.as_str(), e[0].typ.as_str(), e[0].to.as_str()), ("idB", "INHERITS", "idA"));
    }

    #[test]
    fn resolves_nested_sibling_inherits() {
        // class Outer: class A; class B(A)  → both qualified under Outer.
        let d = declared(&[("Outer.A", "idA"), ("Outer.B", "idB")]);
        let p = vec![PendingHeritage {
            decl_scope: vec!["Outer".into()],
            from_name: "B".into(),
            edge_type: "INHERITS".into(),
            base_name: "A".into(),
        }];
        let e = resolve(&p, &d);
        assert_eq!(e.len(), 1, "nested base resolves via scope candidate");
        assert_eq!((e[0].from.as_str(), e[0].to.as_str()), ("idB", "idA"));
    }

    #[test]
    fn resolves_cross_scope_impl() {
        // impl Greeter for Service inside `mod m`; Greeter is top-level.
        let d = declared(&[("Greeter", "idG"), ("m.Service", "idS")]);
        let p = vec![PendingHeritage {
            decl_scope: vec!["m".into()],
            from_name: "Service".into(),
            edge_type: "IMPLEMENTS".into(),
            base_name: "Greeter".into(),
        }];
        let e = resolve(&p, &d);
        assert_eq!(e.len(), 1);
        assert_eq!((e[0].from.as_str(), e[0].typ.as_str(), e[0].to.as_str()), ("idS", "IMPLEMENTS", "idG"));
    }

    #[test]
    fn external_base_yields_no_edge() {
        let d = declared(&[("B", "idB")]);
        let p = vec![PendingHeritage {
            decl_scope: vec![],
            from_name: "B".into(),
            edge_type: "INHERITS".into(),
            base_name: "ImportedExternal".into(),
        }];
        assert!(resolve(&p, &d).is_empty());
    }
}
