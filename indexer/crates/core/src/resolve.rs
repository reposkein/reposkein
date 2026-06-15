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

/// Map from (importing_file_id, local_binding) → (target_path, original_name).
type ImportTargets = HashMap<(String, String), (String, String)>;

const MAX_REEXPORT_DEPTH: usize = 8;

/// Chase a pub-use re-export chain to the original definition.
/// Returns (final_path, final_sym), bounded by MAX_REEXPORT_DEPTH with cycle guard.
fn chase_reexport(
    mut path: String,
    mut sym: String,
    reexports: &BTreeMap<(String, String), (String, String)>,
) -> (String, String) {
    let mut seen = BTreeSet::new();
    for _ in 0..MAX_REEXPORT_DEPTH {
        if !seen.insert((path.clone(), sym.clone())) {
            break; // cycle
        }
        match reexports.get(&(path.clone(), sym.clone())) {
            Some((np, ns)) => {
                path = np.clone();
                sym = ns.clone();
            }
            None => break,
        }
    }
    (path, sym)
}

/// Resolves imports → IMPORTS edges, and returns a map
/// (importing_file_id, local_binding) → (target_path, original_name), for call following.
fn resolve_imports(
    imports: &[RawImport],
    files: &BTreeSet<String>,
    repo: &str,
    by_file_funcs: &BTreeMap<String, Vec<(String, String)>>,
) -> (Vec<Edge>, ImportTargets) {
    // Pass 1: build re-export map from reexport=true imports
    let mut reexports: BTreeMap<(String, String), (String, String)> = BTreeMap::new();
    for imp in imports {
        if !imp.reexport {
            continue;
        }
        let Some(target) = imp.candidate_paths.iter().find(|p| files.contains(*p)) else {
            continue;
        };
        for (local, original) in &imp.symbols {
            if local == "*" || original == "*" {
                continue; // glob re-exports handled by glob expansion only
            }
            reexports.insert(
                (imp.importing_path.clone(), local.clone()),
                (target.clone(), original.clone()),
            );
        }
    }

    // Pass 2: resolve all imports and build edges
    // (from_id, to_id) -> sorted-unique local names (for the edge's symbols property)
    let mut agg: BTreeMap<(String, String), BTreeSet<String>> = BTreeMap::new();
    let mut sym_map: HashMap<(String, String), (String, String)> = HashMap::new();
    for imp in imports {
        let Some(target) = imp.candidate_paths.iter().find(|p| files.contains(*p)) else {
            continue;
        };
        let to_id = id::file_id(repo, target);
        let entry = agg
            .entry((imp.importing_file_id.clone(), to_id.clone()))
            .or_default();

        // Check if this is a glob sentinel (symbols == [("", "*")])
        if imp.symbols == [(String::new(), "*".to_string())] {
            // Expand: add each free fn of the target file as a binding (no reexport chasing for globs)
            if let Some(fns) = by_file_funcs.get(target) {
                for (name, _id) in fns {
                    entry.insert(name.clone());
                    sym_map.insert(
                        (imp.importing_file_id.clone(), name.clone()),
                        (target.clone(), name.clone()),
                    );
                }
            }
        } else {
            for (local, original) in &imp.symbols {
                entry.insert(local.clone());
                // Chase the reexport chain to find the original definition
                let (final_path, final_sym) =
                    chase_reexport(target.clone(), original.clone(), &reexports);
                sym_map.insert(
                    (imp.importing_file_id.clone(), local.clone()),
                    (final_path, final_sym),
                );
            }
        }
    }
    let mut edges = Vec::new();
    for ((from, to), symbols) in agg {
        let mut e = Edge::new(from, "IMPORTS", to);
        if !symbols.is_empty() {
            let arr: Vec<Value> = symbols.into_iter().map(Value::String).collect();
            e.props.insert("symbols".to_string(), Value::Array(arr));
        }
        edges.push(e);
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
    by_file_freefn: &BTreeMap<(String, String), Vec<String>>, // (path,name) -> module-level fn ids only
    by_file_qual: &BTreeMap<(String, String), String>,        // (path,qualified) -> id
    import_targets: &ImportTargets, // (importing_file_id, local) -> (path, original)
    by_id_dir: &BTreeMap<String, String>, // func id -> directory of its file
    caller_file_id: &str,
) -> Vec<(String, &'static str, f64)> {
    // Rung 1: self/cls method call.
    if matches!(
        c.receiver.as_deref(),
        Some("self") | Some("cls") | Some("this")
    ) {
        if let Some((class, _)) = c.caller_qualified.rsplit_once('.') {
            let target_q = format!("{class}.{}", c.callee_name);
            if let Some(id) = by_file_qual.get(&(c.caller_path.clone(), target_q)) {
                return vec![(id.clone(), "exact", 1.0)];
            }
        }
    }
    if c.receiver.is_none() {
        // Rung 2: same-file module-level function (bare name cannot reach a method).
        if let Some(ids) = by_file_freefn.get(&(c.caller_path.clone(), c.callee_name.clone())) {
            return ids.iter().map(|id| (id.clone(), "exact", 1.0)).collect();
        }
        // Rung 3: import-followed module-level function.
        if let Some((target_path, original)) =
            import_targets.get(&(caller_file_id.to_string(), c.callee_name.clone()))
        {
            if let Some(ids) = by_file_freefn.get(&(target_path.clone(), original.clone())) {
                return ids.iter().map(|id| (id.clone(), "exact", 1.0)).collect();
            }
        }
        // Rung 3.5: scope-aware — prefer same-directory candidates before
        // going repo-wide (reduces false repo-wide `ambiguous` fan-out).
        // Only applies when the caller is in a non-root directory (caller_dir
        // non-empty) to avoid spurious matches among root-level files.
        if let Some(ids) = by_name.get(&c.callee_name) {
            if ids.len() > 1 {
                let caller_dir = c.caller_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
                if !caller_dir.is_empty() {
                    let local: Vec<&String> = ids
                        .iter()
                        .filter(|id| by_id_dir.get(*id).map(|d| d.as_str()) == Some(caller_dir))
                        .collect();
                    match local.len() {
                        1 => return vec![(local[0].clone(), "name_match", 0.8)],
                        n if n > 1 => {
                            let conf = round2(0.8 / n as f64);
                            return local
                                .iter()
                                .map(|id| ((*id).clone(), "ambiguous", conf))
                                .collect();
                        }
                        _ => {} // fall through to repo-wide rungs 4/5 (unchanged)
                    }
                }
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

/// Edges (unchanged) — see [`resolve_full`].
pub fn resolve(nodes: &[Node], imports: &[RawImport], calls: &[RawCall], repo: &str) -> Vec<Edge> {
    resolve_full(nodes, imports, calls, repo).0
}

/// Like [`resolve`], but also returns, per caller Function id, the sorted+deduped
/// list of **imported-but-unresolved-in-repo** bare call names (the callee's
/// *original* name, so aliases match the target). This is the committed
/// `external_calls` data a federation-load stitch uses to create cross-repo
/// CALLS edges (design: cross-repo-calls.md, Option A).
pub fn resolve_full(
    nodes: &[Node],
    imports: &[RawImport],
    calls: &[RawCall],
    repo: &str,
) -> (Vec<Edge>, Vec<(String, Vec<String>)>) {
    let files = file_paths(nodes);

    // Build function indexes FIRST (needed for glob expansion in resolve_imports).
    let funcs = functions(nodes);
    let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut by_file_freefn: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let mut by_file_qual: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut by_id_dir: BTreeMap<String, String> = BTreeMap::new();
    // path -> sorted (name, id) of module-level fns defined in that file
    let mut by_file_funcs: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for f in &funcs {
        by_name
            .entry(f.name.clone())
            .or_default()
            .push(f.id.clone());
        if !f.qualified.contains('.') {
            by_file_freefn
                .entry((f.file_path.clone(), f.name.clone()))
                .or_default()
                .push(f.id.clone());
            by_file_funcs
                .entry(f.file_path.clone())
                .or_default()
                .push((f.name.clone(), f.id.clone()));
        }
        by_file_qual.insert((f.file_path.clone(), f.qualified.clone()), f.id.clone());
        let dir = f
            .file_path
            .rsplit_once('/')
            .map(|(d, _)| d)
            .unwrap_or("")
            .to_string();
        by_id_dir.insert(f.id.clone(), dir);
    }
    for v in by_name.values_mut() {
        v.sort();
    }
    for v in by_file_freefn.values_mut() {
        v.sort();
    }
    for v in by_file_funcs.values_mut() {
        v.sort();
    }

    let (mut edges, import_targets) = resolve_imports(imports, &files, repo, &by_file_funcs);

    // ALL imported local→original bindings (incl. cross-repo imports that
    // resolve_imports filtered out, since their target file isn't in-repo).
    let mut imported_originals: HashMap<(String, String), String> = HashMap::new();
    for imp in imports {
        for (local, original) in &imp.symbols {
            imported_originals
                .entry((imp.importing_file_id.clone(), local.clone()))
                .or_insert_with(|| original.clone());
        }
    }

    let mut agg: BTreeMap<(String, String), (u64, &'static str, f64)> = BTreeMap::new();
    // caller_id -> sorted-unique external (imported-but-unresolved) original names.
    let mut external: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for c in calls {
        let caller_file_id = id::file_id(repo, &c.caller_path);
        let resolved = resolve_one(
            c,
            &by_name,
            &by_file_freefn,
            &by_file_qual,
            &import_targets,
            &by_id_dir,
            &caller_file_id,
        );
        if resolved.is_empty() && c.receiver.is_none() {
            // Unresolved bare call: if it names an imported symbol, record the
            // import's ORIGINAL name as a cross-repo candidate.
            if let Some(original) =
                imported_originals.get(&(caller_file_id.clone(), c.callee_name.clone()))
            {
                external
                    .entry(c.caller_id.clone())
                    .or_default()
                    .insert(original.clone());
            }
        }
        for (target, res, conf) in resolved {
            let entry = agg
                .entry((c.caller_id.clone(), target))
                .or_insert((0, res, conf));
            entry.0 += 1;
            // Keep the best (highest-confidence) resolution for the pair; a
            // pair that is ever `exact` must not be downgraded by a later
            // lower-confidence call site. Deterministic (source order stable).
            if conf > entry.2 {
                entry.1 = res;
                entry.2 = conf;
            }
        }
    }
    for ((from, to), (count, res, conf)) in agg {
        let mut e = Edge::new(from, "CALLS", to);
        e.props.insert("resolution".to_string(), json!(res));
        e.props.insert("confidence".to_string(), json!(conf));
        e.props.insert("call_sites".to_string(), json!(count));
        edges.push(e);
    }

    let external_out: Vec<(String, Vec<String>)> = external
        .into_iter()
        .map(|(k, set)| (k, set.into_iter().collect()))
        .collect();
    (edges, external_out)
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
    fn imports_to_same_target_aggregate_into_one_edge() {
        let nodes = vec![file_node("r", "app/svc.py"), file_node("r", "app/base.py")];
        let mk = |sym: &str| RawImport {
            importing_file_id: id::file_id("r", "app/svc.py"),
            importing_path: "app/svc.py".to_string(),
            symbols: vec![(sym.into(), sym.into())],
            candidate_paths: vec!["app/base.py".to_string()],
            reexport: false,
        };
        // Two separate imports from the same module.
        let imports = vec![mk("Base"), mk("helper")];
        let edges = resolve(&nodes, &imports, &[], "r");
        let import_edges: Vec<&Edge> = edges.iter().filter(|e| e.typ == "IMPORTS").collect();
        assert_eq!(import_edges.len(), 1, "one aggregated IMPORTS edge");
        // Symbols are the sorted union.
        assert_eq!(
            import_edges[0].props["symbols"],
            serde_json::json!(["Base", "helper"])
        );
    }

    #[test]
    fn resolves_import_to_existing_file_with_symbols() {
        let nodes = vec![file_node("r", "app/svc.py"), file_node("r", "app/base.py")];
        let imports = vec![RawImport {
            importing_file_id: id::file_id("r", "app/svc.py"),
            importing_path: "app/svc.py".to_string(),
            symbols: vec![("Base".into(), "Base".into())],
            candidate_paths: vec![
                "app/base.py".to_string(),
                "app/base/__init__.py".to_string(),
            ],
            reexport: false,
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
            symbols: vec![("sqrt".into(), "sqrt".into())],
            candidate_paths: vec!["math.py".to_string(), "math/__init__.py".to_string()],
            reexport: false,
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
    fn this_method_call_is_exact() {
        let m_caller = func_node("r", "m.ts", "Svc.run", 0);
        let m_callee = func_node("r", "m.ts", "Svc.go", 0);
        let nodes = vec![m_caller.clone(), m_callee.clone()];
        let calls = vec![call(&m_caller.id, "m.ts", "Svc.run", "go", Some("this"))];
        let edges = resolve(&nodes, &[], &calls, "r");
        let e = edges.iter().find(|e| e.typ == "CALLS").unwrap();
        assert_eq!(e.to, m_callee.id);
        assert_eq!(e.props["resolution"], json!("exact"));
    }

    #[test]
    fn bare_call_does_not_bind_to_same_file_method_as_exact() {
        // Same file has only a METHOD named `helper` (no module-level helper).
        let caller = func_node("r", "m.py", "caller", 0);
        let method = func_node("r", "m.py", "Cls.helper", 1);
        let nodes = vec![caller.clone(), method.clone()];
        let calls = vec![call(&caller.id, "m.py", "caller", "helper", None)];
        let edges = resolve(&nodes, &[], &calls, "r");
        if let Some(e) = edges.iter().find(|e| e.typ == "CALLS") {
            assert_ne!(
                e.props["resolution"],
                json!("exact"),
                "a bare call must not bind to a same-file method as exact"
            );
        }
    }

    #[test]
    fn bare_call_still_exact_for_same_file_free_function() {
        let caller = func_node("r", "m.py", "caller", 0);
        let free = func_node("r", "m.py", "helper", 0); // module-level
        let nodes = vec![caller.clone(), free.clone()];
        let calls = vec![call(&caller.id, "m.py", "caller", "helper", None)];
        let edges = resolve(&nodes, &[], &calls, "r");
        let e = edges.iter().find(|e| e.typ == "CALLS").unwrap();
        assert_eq!(e.to, free.id);
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

    #[test]
    fn aliased_import_resolves_to_original_in_target() {
        let caller = func_node("r", "m.py", "use", 0);
        let target_fn = func_node("r", "util.py", "helper", 0); // original name in target
        let nodes = vec![
            file_node("r", "m.py"),
            file_node("r", "util.py"),
            caller.clone(),
            target_fn.clone(),
        ];
        let imports = vec![RawImport {
            importing_file_id: id::file_id("r", "m.py"),
            importing_path: "m.py".to_string(),
            symbols: vec![("h".to_string(), "helper".to_string())], // imported as `h`
            candidate_paths: vec!["util.py".to_string()],
            reexport: false,
        }];
        // call site uses the alias `h`
        let calls = vec![call(&caller.id, "m.py", "use", "h", None)];
        let edges = resolve(&nodes, &imports, &calls, "r");
        let e = edges.iter().find(|e| e.typ == "CALLS").unwrap();
        assert_eq!(e.to, target_fn.id);
        assert_eq!(e.props["resolution"], json!("exact"));
    }

    #[test]
    fn glob_import_expands_to_target_file_free_fns() {
        // a.rs defines helper + other; b.rs glob-imports a and calls helper().
        let nodes = vec![
            Node::new("rs1:r:func:a.rs#helper@0", "Function")
                .set("name", json!("helper"))
                .set("qualified_name", json!("helper"))
                .set("file_path", json!("a.rs")),
            Node::new("rs1:r:func:a.rs#other@0", "Function")
                .set("name", json!("other"))
                .set("qualified_name", json!("other"))
                .set("file_path", json!("a.rs")),
            Node::new("rs1:r:func:b.rs#run@0", "Function")
                .set("name", json!("run"))
                .set("qualified_name", json!("run"))
                .set("file_path", json!("b.rs")),
            Node::new("rs1:r:file:a.rs", "File").set("path", json!("a.rs")),
        ];
        let imports = vec![RawImport {
            importing_file_id: "rs1:r:file:b.rs".to_string(),
            importing_path: "b.rs".to_string(),
            symbols: vec![(String::new(), "*".to_string())],
            candidate_paths: vec!["a.rs".to_string()],
            reexport: false,
        }];
        let calls = vec![RawCall {
            caller_id: "rs1:r:func:b.rs#run@0".to_string(),
            caller_qualified: "run".to_string(),
            caller_path: "b.rs".to_string(),
            callee_name: "helper".to_string(),
            receiver: None,
        }];
        let edges = resolve(&nodes, &imports, &calls, "r");
        let e = edges
            .iter()
            .find(|e| e.typ == "CALLS" && e.to == "rs1:r:func:a.rs#helper@0")
            .expect("glob-imported helper resolves");
        assert_eq!(
            e.props.get("resolution").and_then(|v| v.as_str()),
            Some("exact")
        );
        assert_eq!(
            e.props.get("confidence").and_then(|v| v.as_f64()),
            Some(1.0)
        );
        // IMPORTS edge b->a present
        assert!(edges
            .iter()
            .any(|e| e.typ == "IMPORTS" && e.to == "rs1:r:file:a.rs"));
    }

    fn fn_node(id: &str, name: &str, path: &str) -> Node {
        Node::new(id, "Function")
            .set("name", json!(name))
            .set("qualified_name", json!(name))
            .set("file_path", json!(path))
    }
    fn reexp(from_path: &str, sym: &str, cand: &str) -> RawImport {
        RawImport {
            importing_file_id: format!("rs1:r:file:{from_path}"),
            importing_path: from_path.into(),
            symbols: vec![(sym.into(), sym.into())],
            candidate_paths: vec![cand.into()],
            reexport: true,
        }
    }

    #[test]
    fn pub_use_chain_resolves_to_original_definition() {
        // b.rs defines Thing(); a.rs `pub use crate::b::Thing`; c.rs `use crate::a::Thing` + calls Thing().
        let mut nodes = vec![
            fn_node("rs1:r:func:b.rs#Thing@0", "Thing", "b.rs"),
            fn_node("rs1:r:func:c.rs#run@0", "run", "c.rs"),
        ];
        nodes.push(Node::new("rs1:r:file:a.rs", "File").set("path", json!("a.rs")));
        nodes.push(Node::new("rs1:r:file:b.rs", "File").set("path", json!("b.rs")));
        let imports = vec![
            reexp("a.rs", "Thing", "b.rs"), // a re-exports from b
            RawImport {
                importing_file_id: "rs1:r:file:c.rs".to_string(),
                importing_path: "c.rs".to_string(),
                symbols: vec![("Thing".into(), "Thing".into())],
                candidate_paths: vec!["a.rs".into()],
                reexport: false,
            }, // c uses from a
        ];
        let calls = vec![RawCall {
            caller_id: "rs1:r:func:c.rs#run@0".to_string(),
            caller_qualified: "run".to_string(),
            caller_path: "c.rs".to_string(),
            callee_name: "Thing".to_string(),
            receiver: None,
        }];
        let edges = resolve(&nodes, &imports, &calls, "r");
        let e = edges
            .iter()
            .find(|e| e.typ == "CALLS" && e.to == "rs1:r:func:b.rs#Thing@0")
            .expect("Thing chased through a's reexport to b");
        assert_eq!(
            e.props.get("resolution").and_then(|v| v.as_str()),
            Some("exact")
        );
    }

    #[test]
    fn pub_use_cycle_terminates() {
        // a re-exports X from b; b re-exports X from a → cycle. Must not loop; resolves to last.
        let nodes = vec![
            Node::new("rs1:r:file:a.rs", "File").set("path", json!("a.rs")),
            Node::new("rs1:r:file:b.rs", "File").set("path", json!("b.rs")),
        ];
        let imports = vec![reexp("a.rs", "X", "b.rs"), reexp("b.rs", "X", "a.rs")];
        // Just assert resolve() returns (does not hang / panic).
        let _ = resolve(&nodes, &imports, &[], "r");
    }

    #[test]
    fn imported_unresolved_call_recorded_as_external() {
        // svc.py imports `helper` from a module NOT in this repo (child.base),
        // so the import is unresolved in-repo; the bare call to helper() then
        // resolves to nothing → recorded as an external call (original name).
        let caller = func_node("r", "svc.py", "run", 0);
        let nodes = vec![file_node("r", "svc.py"), caller.clone()];
        let imports = vec![RawImport {
            importing_file_id: id::file_id("r", "svc.py"),
            importing_path: "svc.py".to_string(),
            symbols: vec![("helper".into(), "helper".into())],
            candidate_paths: vec!["child/base.py".to_string()], // not in `files`
            reexport: false,
        }];
        let calls = vec![call(&caller.id, "svc.py", "run", "helper", None)];
        let (edges, external) = resolve_full(&nodes, &imports, &calls, "r");
        assert!(
            edges.iter().all(|e| e.typ != "CALLS"),
            "no in-repo CALLS edge"
        );
        assert_eq!(
            external,
            vec![(caller.id.clone(), vec!["helper".to_string()])]
        );
    }

    #[test]
    fn aliased_imported_unresolved_call_records_original_name() {
        // `from child.base import helper as h; h()` → record "helper".
        let caller = func_node("r", "svc.py", "run", 0);
        let nodes = vec![file_node("r", "svc.py"), caller.clone()];
        let imports = vec![RawImport {
            importing_file_id: id::file_id("r", "svc.py"),
            importing_path: "svc.py".to_string(),
            symbols: vec![("h".into(), "helper".into())],
            candidate_paths: vec!["child/base.py".to_string()],
            reexport: false,
        }];
        let calls = vec![call(&caller.id, "svc.py", "run", "h", None)];
        let (_e, external) = resolve_full(&nodes, &imports, &calls, "r");
        assert_eq!(
            external,
            vec![(caller.id.clone(), vec!["helper".to_string()])]
        );
    }

    #[test]
    fn non_imported_unresolved_call_is_not_external() {
        // A bare call to a name that is NOT imported (e.g. a builtin) is noise —
        // not recorded.
        let caller = func_node("r", "svc.py", "run", 0);
        let nodes = vec![file_node("r", "svc.py"), caller.clone()];
        let calls = vec![call(&caller.id, "svc.py", "run", "print", None)];
        let (_e, external) = resolve_full(&nodes, &[], &calls, "r");
        assert!(
            external.is_empty(),
            "non-imported unresolved call is not recorded"
        );
    }

    #[test]
    fn in_repo_resolved_imported_call_is_not_external() {
        // helper IS defined in this repo (in base.py) and imported → it resolves
        // in-repo (rung 3), so it is NOT recorded as external.
        let caller = func_node("r", "svc.py", "run", 0);
        let helper = func_node("r", "base.py", "helper", 0);
        let nodes = vec![
            file_node("r", "svc.py"),
            file_node("r", "base.py"),
            caller.clone(),
            helper.clone(),
        ];
        let imports = vec![RawImport {
            importing_file_id: id::file_id("r", "svc.py"),
            importing_path: "svc.py".to_string(),
            symbols: vec![("helper".into(), "helper".into())],
            candidate_paths: vec!["base.py".to_string()], // in-repo
            reexport: false,
        }];
        let calls = vec![call(&caller.id, "svc.py", "run", "helper", None)];
        let (edges, external) = resolve_full(&nodes, &imports, &calls, "r");
        assert!(edges.iter().any(|e| e.typ == "CALLS" && e.to == helper.id));
        assert!(
            external.is_empty(),
            "in-repo-resolved import is not external"
        );
    }

    #[test]
    fn best_resolution_per_pair_is_kept_not_last_write() {
        // caller f() in a.py calls g() twice; g is defined in a.py (same-file
        // exact) AND in b.py (so by_name has 2 → the repo-wide rung would be
        // ambiguous). Same-file rung 2 wins per call; assert the a.py edge is
        // exact with call_sites = 2 (aggregated), never downgraded.
        let nodes = vec![
            Node::new("rs1:r:func:a.py#f@0", "Function")
                .set("name", json!("f"))
                .set("qualified_name", json!("f"))
                .set("file_path", json!("a.py")),
            Node::new("rs1:r:func:a.py#g@0", "Function")
                .set("name", json!("g"))
                .set("qualified_name", json!("g"))
                .set("file_path", json!("a.py")),
            Node::new("rs1:r:func:b.py#g@0", "Function")
                .set("name", json!("g"))
                .set("qualified_name", json!("g"))
                .set("file_path", json!("b.py")),
        ];
        let calls = vec![
            RawCall {
                caller_id: "rs1:r:func:a.py#f@0".into(),
                caller_qualified: "f".into(),
                caller_path: "a.py".into(),
                callee_name: "g".into(),
                receiver: None,
            },
            RawCall {
                caller_id: "rs1:r:func:a.py#f@0".into(),
                caller_qualified: "f".into(),
                caller_path: "a.py".into(),
                callee_name: "g".into(),
                receiver: None,
            },
        ];
        let edges = resolve(&nodes, &[], &calls, "r");
        let e = edges
            .iter()
            .find(|e| e.typ == "CALLS" && e.to == "rs1:r:func:a.py#g@0")
            .expect("a.py#f -> a.py#g CALLS edge");
        assert_eq!(
            e.props.get("resolution").and_then(|v| v.as_str()),
            Some("exact")
        );
        assert_eq!(
            e.props.get("confidence").and_then(|v| v.as_f64()),
            Some(1.0)
        );
        assert_eq!(e.props.get("call_sites").and_then(|v| v.as_u64()), Some(2));
    }

    #[test]
    fn scope_aware_prefers_same_directory_unique() {
        // caller in src/auth/x.rs calls helper(); two helpers exist: one in the
        // caller's dir (src/auth/y.rs) and one elsewhere (src/util/z.rs).
        let nodes = vec![
            Node::new("rs1:r:func:src/auth/x.rs#run@0".to_string(), "Function")
                .set("name", json!("run"))
                .set("qualified_name", json!("run"))
                .set("file_path", json!("src/auth/x.rs")),
            Node::new("rs1:r:func:src/auth/y.rs#helper@0".to_string(), "Function")
                .set("name", json!("helper"))
                .set("qualified_name", json!("helper"))
                .set("file_path", json!("src/auth/y.rs")),
            Node::new("rs1:r:func:src/util/z.rs#helper@0".to_string(), "Function")
                .set("name", json!("helper"))
                .set("qualified_name", json!("helper"))
                .set("file_path", json!("src/util/z.rs")),
        ];
        let calls = vec![RawCall {
            caller_id: "rs1:r:func:src/auth/x.rs#run@0".into(),
            caller_qualified: "run".into(),
            caller_path: "src/auth/x.rs".into(),
            callee_name: "helper".into(),
            receiver: None,
        }];
        let edges = resolve(&nodes, &[], &calls, "r");
        let calls_edges: Vec<&Edge> = edges.iter().filter(|e| e.typ == "CALLS").collect();
        assert_eq!(
            calls_edges.len(),
            1,
            "should resolve to the single same-dir helper"
        );
        let e = calls_edges[0];
        assert_eq!(e.to, "rs1:r:func:src/auth/y.rs#helper@0");
        assert_eq!(
            e.props.get("resolution").and_then(|v| v.as_str()),
            Some("name_match")
        );
        assert_eq!(
            e.props.get("confidence").and_then(|v| v.as_f64()),
            Some(0.8)
        );
    }

    #[test]
    fn scope_aware_falls_through_when_no_same_dir() {
        // caller in src/app/x.rs; both helpers elsewhere → unchanged repo-wide ambiguous.
        let nodes = vec![
            Node::new("rs1:r:func:src/app/x.rs#run@0".to_string(), "Function")
                .set("name", json!("run"))
                .set("qualified_name", json!("run"))
                .set("file_path", json!("src/app/x.rs")),
            Node::new("rs1:r:func:src/a/y.rs#helper@0".to_string(), "Function")
                .set("name", json!("helper"))
                .set("qualified_name", json!("helper"))
                .set("file_path", json!("src/a/y.rs")),
            Node::new("rs1:r:func:src/b/z.rs#helper@0".to_string(), "Function")
                .set("name", json!("helper"))
                .set("qualified_name", json!("helper"))
                .set("file_path", json!("src/b/z.rs")),
        ];
        let calls = vec![RawCall {
            caller_id: "rs1:r:func:src/app/x.rs#run@0".into(),
            caller_qualified: "run".into(),
            caller_path: "src/app/x.rs".into(),
            callee_name: "helper".into(),
            receiver: None,
        }];
        let edges = resolve(&nodes, &[], &calls, "r");
        let amb: Vec<&Edge> = edges
            .iter()
            .filter(|e| {
                e.typ == "CALLS"
                    && e.props.get("resolution").and_then(|v| v.as_str()) == Some("ambiguous")
            })
            .collect();
        assert_eq!(
            amb.len(),
            2,
            "repo-wide ambiguous fan-out unchanged when no same-dir candidate"
        );
    }
}
