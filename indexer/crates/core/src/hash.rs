//! Content hashing. BLAKE3 over raw file bytes (PRD §3.6).
//! Line-ending/span normalization is deferred to the AST extraction plan;
//! M0 hashes raw bytes, which is fully deterministic.

/// Lowercase hex BLAKE3 digest of the given bytes.
pub fn content_hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_known() {
        // BLAKE3 of the empty input is a fixed, documented constant.
        assert_eq!(
            content_hash(b""),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
        // Same input → same hash; different input → different hash.
        assert_eq!(content_hash(b"hello"), content_hash(b"hello"));
        assert_ne!(content_hash(b"hello"), content_hash(b"world"));
    }
}
