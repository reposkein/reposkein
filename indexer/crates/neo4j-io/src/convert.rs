//! Conversions between serde_json::Value (our prop model) and neo4rs BoltType.
//! Property type fidelity here is what makes the byte-identical round-trip hold.

use neo4rs::{BoltList, BoltType};
use serde_json::Value;

pub fn json_to_bolt(v: &Value) -> BoltType {
    match v {
        Value::String(s) => BoltType::from(s.clone()),
        Value::Bool(b) => BoltType::from(*b),
        Value::Number(n) if n.is_i64() => BoltType::from(n.as_i64().unwrap()),
        Value::Number(n) => BoltType::from(n.as_f64().unwrap_or(0.0)),
        Value::Array(a) => {
            let mut l = BoltList::new();
            for e in a {
                l.push(json_to_bolt(e));
            }
            BoltType::List(l)
        }
        _ => BoltType::from(String::new()),
    }
}

pub fn bolt_to_json(b: &BoltType) -> Value {
    match b {
        BoltType::String(s) => Value::String(s.value.clone()),
        BoltType::Boolean(x) => Value::Bool(x.value),
        BoltType::Integer(i) => Value::from(i.value),
        BoltType::Float(f) => Value::from(f.value),
        BoltType::List(l) => Value::Array(l.value.iter().map(bolt_to_json).collect()),
        _ => Value::Null,
    }
}
