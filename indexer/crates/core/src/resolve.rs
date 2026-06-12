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
            sym_map.insert((imp.importing_file_id.clone(), sym.clone()), target.clone());
        }
    }
    (edges, sym_map)
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// Resolves one call into zero or more (target_id, resolution, confidence).
fn resolve_one(
    c: &RawCall,
    by_name: &BTreeMap<String, Vec<String>>, // name -> sorted func ids
    by_file_name: &BTreeMap<(String, String), Vec<String>>, // (path,name) -> ids
    by_file_qual: &BTreeMap<(String, String), String>, // (path,qualified) -> id
    import_targets: &HashMap<(String, String), String>, // (importing_file_id, sym) -> path
    caller_file_id: &str,
) -> Vec<(String, &'static str, f64)> {
    // Rung 1: self/cls method call.
    if matches!(c.receiver.as_deref(), Some("self") | Some("cls")) {
        if let Some((class, _)) = c.caller_qualified.rsplit_once('.') {
            let target_q = format!("{class}.{}", c.callee_name);
            if let Some(id) = by_file_qual.get(&(c.caller_path.clone(), target_q)) {
                return vec![(id.clone(), "exact", 1.0)];
            }
        }
    }
    if c.receiver.is_none() {
        // Rung 2: same-file function.
        if let Some(ids) = by_file_name.get(&(c.caller_path.clone(), c.callee_name.clone())) {
            return ids.iter().map(|id| (id.clone(), "exact", 1.0)).collect();
        }
        // Rung 3: import-followed.
        if let Some(target_path) =
            import_targets.get(&(caller_file_id.to_string(), c.callee_name.clone()))
        {
            if let Some(ids) = by_file_name.get(&(target_path.clone(), c.callee_name.clone())) {
                return ids.iter().map(|id| (id.clone(), "exact", 1.0)).collect();
            }
        }
        // Rungs 4/5: repo-wide name match.
        if let Some(ids) = by_name.get(&c.callee_name) {
            return if ids.len() == 1 {
                vec![(ids[0].clone(), "name_match", 0.7)]
            } else {
                let conf = round2(1.0 / ids.len() as f64);
                ids.iter()
                    .map(|id| (id.clone(), "ambiguous", conf))
                    .collect()
            };
        }
        return Vec::new();
    }
    // Rungs 6/7: attribute call (obj.callee), no type info.
    if let Some(ids) = by_name.get(&c.callee_name) {
        return if ids.len() == 1 {
            vec![(ids[0].clone(), "name_match", 0.5)]
        } else {
            let conf = round2(1.0 / ids.len() as f64);
            ids.iter()
                .map(|id| (id.clone(), "ambiguous", conf))
                .collect()
        };
    }
    Vec::new()
}

pub fn resolve(nodes: &[Node], imports: &[RawImport], calls: &[RawCall], repo: &str) -> Vec<Edge> {
    let files = file_paths(nodes);
    let (mut edges, import_targets) = resolve_imports(imports, &files, repo);

    let funcs = functions(nodes);
    let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut by_file_name: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let mut by_file_qual: BTreeMap<(String, String), String> = BTreeMap::new();
    for f in &funcs {
        by_name
            .entry(f.name.clone())
            .or_default()
            .push(f.id.clone());
        by_file_name
            .entry((f.file_path.clone(), f.name.clone()))
            .or_default()
            .push(f.id.clone());
        by_file_qual.insert((f.file_path.clone(), f.qualified.clone()), f.id.clone());
    }
    for v in by_name.values_mut() {
        v.sort();
    }
    for v in by_file_name.values_mut() {
        v.sort();
    }

    // Aggregate call sites: (caller_id, target_id) -> (count, resolution, confidence).
    let mut agg: BTreeMap<(String, String), (u64, &'static str, f64)> = BTreeMap::new();
    for c in calls {
        let caller_file_id = id::file_id(repo, &c.caller_path);
        let resolved = resolve_one(
            c,
            &by_name,
            &by_file_name,
            &by_file_qual,
            &import_targets,
            &caller_file_id,
        );
        for (target, res, conf) in resolved {
            let entry = agg
                .entry((c.caller_id.clone(), target))
                .or_insert((0, res, conf));
            entry.0 += 1;
            entry.1 = res;
            entry.2 = conf;
        }
    }
    for ((from, to), (count, res, conf)) in agg {
        let mut e = Edge::new(from, "CALLS", to);
        e.props.insert("resolution".to_string(), json!(res));
        e.props.insert("confidence".to_string(), json!(conf));
        e.props.insert("call_sites".to_string(), json!(count));
        edges.push(e);
    }
    edges
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
        let nodes = vec![file_node("r", "app/svc.py"), file_node("r", "app/base.py")];
        let imports = vec![RawImport {
            importing_file_id: id::file_id("r", "app/svc.py"),
            importing_path: "app/svc.py".to_string(),
            symbols: vec!["Base".to_string()],
            candidate_paths: vec![
                "app/base.py".to_string(),
                "app/base/__init__.py".to_string(),
            ],
        }];
        let edges = resolve(&nodes, &imports, &[], "r");
        let e = edges
            .iter()
            .find(|e| e.typ == "IMPORTS")
            .expect("IMPORTS edge");
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

    fn func_node(repo: &str, path: &str, qualified: &str, arity: u32) -> Node {
        let id = format!("rs1:{repo}:func:{path}#{qualified}@{arity}");
        let name = qualified.rsplit('.').next().unwrap().to_string();
        Node::new(id, "Function")
            .set("name", json!(name))
            .set("qualified_name", json!(qualified))
            .set("file_path", json!(path))
    }

    fn call(
        caller_id: &str,
        caller_path: &str,
        caller_q: &str,
        callee: &str,
        recv: Option<&str>,
    ) -> RawCall {
        RawCall {
            caller_id: caller_id.to_string(),
            caller_path: caller_path.to_string(),
            caller_qualified: caller_q.to_string(),
            callee_name: callee.to_string(),
            receiver: recv.map(|s| s.to_string()),
        }
    }

    #[test]
    fn same_file_call_is_exact() {
        let f_caller = func_node("r", "m.py", "a", 0);
        let f_callee = func_node("r", "m.py", "helper", 0);
        let nodes = vec![f_caller.clone(), f_callee.clone()];
        let calls = vec![call(&f_caller.id, "m.py", "a", "helper", None)];
        let edges = resolve(&nodes, &[], &calls, "r");
        let e = edges.iter().find(|e| e.typ == "CALLS").unwrap();
        assert_eq!(e.from, f_caller.id);
        assert_eq!(e.to, f_callee.id);
        assert_eq!(e.props["resolution"], json!("exact"));
        assert_eq!(e.props["confidence"], json!(1.0));
        assert_eq!(e.props["call_sites"], json!(1));
    }

    #[test]
    fn ambiguous_name_fans_out_with_split_confidence() {
        let caller = func_node("r", "m.py", "a", 0);
        let t1 = func_node("r", "x.py", "run", 0);
        let t2 = func_node("r", "y.py", "run", 0);
        let nodes = vec![caller.clone(), t1.clone(), t2.clone()];
        // bare call to `run`, defined twice elsewhere → ambiguous, 1/2 each.
        let calls = vec![call(&caller.id, "m.py", "a", "run", None)];
        let edges = resolve(&nodes, &[], &calls, "r");
        let calls_edges: Vec<&Edge> = edges.iter().filter(|e| e.typ == "CALLS").collect();
        assert_eq!(calls_edges.len(), 2);
        for e in calls_edges {
            assert_eq!(e.props["resolution"], json!("ambiguous"));
            assert_eq!(e.props["confidence"], json!(0.5));
        }
    }

    #[test]
    fn self_method_call_is_exact() {
        let m_caller = func_node("r", "m.py", "Svc.run", 1);
        let m_callee = func_node("r", "m.py", "Svc.help", 1);
        let nodes = vec![m_caller.clone(), m_callee.clone()];
        let calls = vec![call(&m_caller.id, "m.py", "Svc.run", "help", Some("self"))];
        let edges = resolve(&nodes, &[], &calls, "r");
        let e = edges.iter().find(|e| e.typ == "CALLS").unwrap();
        assert_eq!(e.to, m_callee.id);
        assert_eq!(e.props["resolution"], json!("exact"));
    }

    #[test]
    fn resolution_is_deterministic() {
        let caller = func_node("r", "m.py", "a", 0);
        let t1 = func_node("r", "x.py", "run", 0);
        let t2 = func_node("r", "y.py", "run", 0);
        let nodes = vec![caller.clone(), t1, t2];
        let calls = vec![
            call(&caller.id, "m.py", "a", "run", None),
            call(&caller.id, "m.py", "a", "run", None),
        ];
        let a = resolve(&nodes, &[], &calls, "r");
        let b = resolve(&nodes, &[], &calls, "r");
        assert_eq!(a, b);
    }
}
