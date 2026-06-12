//! Stable ID construction per PRD §5.3. IDs never contain line numbers.

/// `rs1:<repo_id>:repo:<root_path>`
pub fn repo_id(repo: &str, root_path: &str) -> String {
    format!("rs1:{repo}:repo:{root_path}")
}

/// `rs1:<repo_id>:dir:<path>`
pub fn dir_id(repo: &str, path: &str) -> String {
    format!("rs1:{repo}:dir:{path}")
}

/// `rs1:<repo_id>:file:<path>`
pub fn file_id(repo: &str, path: &str) -> String {
    format!("rs1:{repo}:file:{path}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_follow_rs1_scheme() {
        assert_eq!(repo_id("9f3a", "."), "rs1:9f3a:repo:.");
        assert_eq!(dir_id("9f3a", "src/auth"), "rs1:9f3a:dir:src/auth");
        assert_eq!(
            file_id("9f3a", "src/auth/session.py"),
            "rs1:9f3a:file:src/auth/session.py"
        );
    }
}
