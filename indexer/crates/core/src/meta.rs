//! `.reposkein/meta.json` — committed schema metadata + canonical repo_id.
//! Deterministic (sorted keys, no timestamps) per §6.1/§6.2.

use serde_json::{Map, Value};

pub const SCHEMA_VERSION: u64 = 1;
pub const ID_SCHEME: &str = "rs1";
pub const INDEXER_VERSION_MIN: &str = "0.0.0";

/// Canonical meta.json content for a repo_id (keys sorted → deterministic).
pub fn meta_json(repo_id: &str) -> String {
    let mut m: Map<String, Value> = Map::new();
    m.insert("id_scheme".into(), Value::String(ID_SCHEME.to_string()));
    m.insert(
        "indexer_version_min".into(),
        Value::String(INDEXER_VERSION_MIN.to_string()),
    );
    m.insert("repo_id".into(), Value::String(repo_id.to_string()));
    m.insert("schema_version".into(), Value::from(SCHEMA_VERSION));
    // serde_json::Map is a BTreeMap (no preserve_order) → sorted keys.
    format!("{}\n", serde_json::to_string(&Value::Object(m)).unwrap())
}

/// Extracts repo_id from meta.json text, if present.
pub fn repo_id_from_meta(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    v.get("repo_id")?.as_str().map(|s| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_json_is_canonical_and_roundtrips() {
        let s = meta_json("abc123");
        assert_eq!(
            s,
            "{\"id_scheme\":\"rs1\",\"indexer_version_min\":\"0.0.0\",\"repo_id\":\"abc123\",\"schema_version\":1}\n"
        );
        assert_eq!(repo_id_from_meta(&s).as_deref(), Some("abc123"));
    }
}
