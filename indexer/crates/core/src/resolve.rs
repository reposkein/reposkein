//! Cross-file resolution: turns RawImport/RawCall facts into IMPORTS/CALLS
//! edges. Language-agnostic — operates on Function names and File paths.

use crate::extractor::{RawCall, RawImport};
use crate::id;
use crate::model::{Edge, Node};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};

/// A lightweight view of the Function nodes needed for resolution.
struct FuncView {
    id: String,
    name: String,
    qualified: String,
    file_path: String,
}

fn prop_str(node: &Node, key: &str) -> String {
    match node.props.get(key) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn functions(nodes: &[Node]) -> Vec<FuncView> {
    nodes
        .iter()
        .filter(|n| n.labels == ["Function"])
        .map(|n| FuncView {
            id: n.id.clone(),
            name: prop_str(n, "name"),
            qualified: prop_str(n, "qualified_name"),
            file_path: prop_str(n, "file_path"),
        })
        .collect()
}

fn file_paths(nodes: &[Node]) -> BTreeSet<String> {
    nodes
        .iter()
        .filter(|n| n.labels == ["File"])
        .map(|n| prop_str(n, "path"))
        .collect()
}

/// Resolves imports → IMPORTS edges, and returns a map
/// (importing_file_id, symbol) → resolved target file path, for call following.
fn resolve_imports(
    imports: &[RawImport],
    files: &BTreeSet<String>,
    repo: &str,
) -> (Vec<Edge>, HashMap<(String, String), String>) {
    let mut edges = Vec::new();
    let mut sym_map: HashMap<(String, String), String> = HashMap::new();
    for imp in imports {
        let Some(target) = imp.candidate_paths.iter().find(|p| files.contains(*p)) else {
            continue; // external / stdlib / unresolved
        };
        let mut edge = Edge::new(
            imp.importing_file_id.clone(),
            "IMPORTS",
            id::file_id(repo, target),
        );
        if !imp.symbols.is_empty() {
            let arr: Vec<Value> = imp.symbols.iter().cloned().map(Value::String).collect();
            edge.props.insert("symbols".to_string(), Value::Array(arr));
        }
        edges.push(edge);
        for sym in &imp.symbols {
            sym_map.insert(
                (imp.importing_file_id.clone(), sym.clone()),
                target.clone(),
            );
        }
    }
    (edges, sym_map)
}

/// Public entry point (CALLS added in the next task).
pub fn resolve(nodes: &[Node], imports: &[RawImport], _calls: &[RawCall], repo: &str) -> Vec<Edge> {
    let files = file_paths(nodes);
    let (import_edges, _sym_map) = resolve_imports(imports, &files, repo);
    let _ = functions(nodes); // used in the next task
    import_edges
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Node;
    use serde_json::json;

    fn file_node(repo: &str, path: &str) -> Node {
        Node::new(id::file_id(repo, path), "File").set("path", json!(path))
    }

    #[test]
    fn resolves_import_to_existing_file_with_symbols() {
        let nodes = vec![
            file_node("r", "app/svc.py"),
            file_node("r", "app/base.py"),
        ];
        let imports = vec![RawImport {
            importing_file_id: id::file_id("r", "app/svc.py"),
            importing_path: "app/svc.py".to_string(),
            symbols: vec!["Base".to_string()],
            candidate_paths: vec!["app/base.py".to_string(), "app/base/__init__.py".to_string()],
        }];
        let edges = resolve(&nodes, &imports, &[], "r");
        let e = edges.iter().find(|e| e.typ == "IMPORTS").expect("IMPORTS edge");
        assert_eq!(e.from, id::file_id("r", "app/svc.py"));
        assert_eq!(e.to, id::file_id("r", "app/base.py"));
        assert_eq!(e.props["symbols"], json!(["Base"]));
    }

    #[test]
    fn skips_unresolvable_import() {
        let nodes = vec![file_node("r", "app/svc.py")];
        let imports = vec![RawImport {
            importing_file_id: id::file_id("r", "app/svc.py"),
            importing_path: "app/svc.py".to_string(),
            symbols: vec!["sqrt".to_string()],
            candidate_paths: vec!["math.py".to_string(), "math/__init__.py".to_string()],
        }];
        let edges = resolve(&nodes, &imports, &[], "r");
        assert!(edges.iter().all(|e| e.typ != "IMPORTS"));
    }
}
