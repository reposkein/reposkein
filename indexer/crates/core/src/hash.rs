//! Content hashing. BLAKE3 over line-ending-normalized bytes (PRD §3.6).
//! CRLF and lone CR are normalized to LF before hashing so the same logical
//! content hashes identically across CRLF/LF checkouts (cross-platform stable).

/// Lowercase hex BLAKE3 digest with line endings normalized to `\n`, so the
/// same logical content hashes identically across CRLF/LF checkouts (PRD §3.6).
pub fn content_hash(bytes: &[u8]) -> String {
    // Fast path: no carriage returns → hash as-is.
    if !bytes.contains(&b'\r') {
        return blake3::hash(bytes).to_hex().to_string();
    }
    let mut normalized = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' {
            normalized.push(b'\n');
            // collapse \r\n into a single \n
            if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                i += 1;
            }
        } else {
            normalized.push(bytes[i]);
        }
        i += 1;
    }
    blake3::hash(&normalized).to_hex().to_string()
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

    #[test]
    fn crlf_and_lf_hash_identically() {
        assert_eq!(content_hash(b"a\r\nb\r\n"), content_hash(b"a\nb\n"));
        // A lone \r (old-mac) also normalizes.
        assert_eq!(content_hash(b"a\rb"), content_hash(b"a\nb"));
    }
}
