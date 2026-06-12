//! Heuristic extension→language and path→role classification (PRD §5.1).
//! These are deliberately simple for M0 and will be refined later.

/// Maps a lowercase file extension (no leading dot) to a language label.
pub fn language_for(ext: &str) -> &'static str {
    match ext {
        "py" => "python",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        _ => "unknown",
    }
}

/// Classifies a file by role: "testing" | "docs" | "config" | "doing".
/// `rel_path` is the repo-relative, forward-slash path; `ext` is the
/// lowercase extension (no leading dot).
pub fn role_for(rel_path: &str, ext: &str) -> &'static str {
    let p = rel_path.to_ascii_lowercase();
    let is_test = p.contains("/tests/")
        || p.contains("/test/")
        || p.starts_with("tests/")
        || p.starts_with("test/")
        || p.contains("test_")
        || p.contains("_test.")
        || p.contains(".test.")
        || p.contains(".spec.");
    if is_test {
        return "testing";
    }
    match ext {
        "md" | "markdown" | "rst" | "txt" => "docs",
        "toml" | "json" | "yaml" | "yml" | "ini" | "cfg" | "lock" => "config",
        _ => "doing",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_mapping() {
        assert_eq!(language_for("py"), "python");
        assert_eq!(language_for("tsx"), "typescript");
        assert_eq!(language_for("rs"), "rust");
        assert_eq!(language_for("xyz"), "unknown");
    }

    #[test]
    fn role_mapping() {
        assert_eq!(role_for("src/auth/session.py", "py"), "doing");
        assert_eq!(role_for("tests/test_session.py", "py"), "testing");
        // "session_test.rs" contains the "_test." substring → testing.
        assert_eq!(role_for("src/auth/session_test.rs", "rs"), "testing");
        assert_eq!(role_for("README.md", "md"), "docs");
        assert_eq!(role_for("Cargo.toml", "toml"), "config");
    }
}
