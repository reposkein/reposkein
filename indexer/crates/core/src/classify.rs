//! Heuristic extension→language and path→role classification (PRD §5.1).
//! These are deliberately simple for M0 and will be refined later.

/// Maps a lowercase file extension (no leading dot) to a language label.
pub fn language_for(ext: &str) -> &'static str {
    match ext {
        "py" => "python",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "rs" => "rust",
        "go" => "go",
        "java" => "java",
        "cs" => "csharp",
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
    let basename = p.rsplit('/').next().unwrap_or(&p);
    let orig_basename = rel_path.rsplit('/').next().unwrap_or(rel_path);
    let in_test_dir = p
        .split('/')
        .any(|seg| seg == "test" || seg == "tests" || seg.ends_with(".tests"));
    let test_file = basename.starts_with("test_")
        || basename.contains("_test.")
        || basename.contains(".test.")
        || basename.contains(".spec.")
        || orig_basename.ends_with("Test.java")   // FooTest.java (case-sensitive, not Contest.java)
        || orig_basename.ends_with("Tests.java")  // FooTests.java
        || orig_basename.ends_with("Tests.cs") // C# convention (harmless)
        || basename.contains(".tests."); // C# Foo.Tests.cs convention
    if in_test_dir || test_file {
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
        assert_eq!(language_for("go"), "go");
        assert_eq!(language_for("java"), "java");
        assert_eq!(language_for("cs"), "csharp");
        assert_eq!(language_for("xyz"), "unknown");
    }

    #[test]
    fn role_mapping() {
        assert_eq!(role_for("src/auth/session.py", "py"), "doing");
        assert_eq!(role_for("tests/test_session.py", "py"), "testing");
        // "session_test.rs" basename contains "_test." → testing.
        assert_eq!(role_for("src/auth/session_test.rs", "rs"), "testing");
        assert_eq!(role_for("README.md", "md"), "docs");
        assert_eq!(role_for("Cargo.toml", "toml"), "config");
        // NOT a test despite containing the substring "test_".
        assert_eq!(role_for("src/contest_results.py", "py"), "doing");
        // basename test_ prefix → testing; directory segment "tests" → testing.
        assert_eq!(role_for("src/test_utils.py", "py"), "testing");
        assert_eq!(role_for("pkg/tests/helpers.py", "py"), "testing");
        assert_eq!(role_for("pkg/svc_test.go", "go"), "testing");
        // Java: PascalCase *Test.java / *Tests.java → testing (case-sensitive check).
        assert_eq!(
            role_for("src/main/java/com/acme/FooTest.java", "java"),
            "testing"
        );
        assert_eq!(
            role_for("src/test/java/com/acme/Bar.java", "java"),
            "testing"
        ); // test dir
        assert_eq!(
            role_for("src/main/java/com/acme/Service.java", "java"),
            "doing"
        );
        assert_eq!(
            role_for("src/main/java/com/acme/Contest.java", "java"),
            "doing"
        ); // NOT testing
           // C#: .Tests/ project directory → testing.
        assert_eq!(role_for("src/MyLib.Tests/FooTests.cs", "cs"), "testing");
        // C#: plain source file → doing.
        assert_eq!(role_for("src/Contoso/Widget.cs", "cs"), "doing");
    }
}
