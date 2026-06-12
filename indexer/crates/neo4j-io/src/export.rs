//! Read a repo's graph back from Neo4j into the core Graph model. Strips the
//! DB-only `repo_id` (and the separately-carried `id`) so the re-serialized
//! JSONL is byte-identical to what the indexer produced.
