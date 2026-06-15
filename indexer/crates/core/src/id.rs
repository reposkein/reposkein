//! Stable ID construction per PRD §5.3. IDs never contain line numbers.
//!
//! # Frozen `@arity` contract (function IDs)
//!
//! Function ids end in `#<qualified_name>@<arity>`. `@arity` disambiguates
//! same-named functions; it is part of the stable `rs1:` scheme, so the
//! per-language counting rule is **frozen** — changing it silently rewrites
//! every function id and orphans every summary. The rules (each in that
//! language crate's `arity`/`param_arity` fn, with a freezing test):
//!
//! - **Python** (`lang-python`): every named child of the `parameters` node
//!   except comments — i.e. includes `self`/`cls`, `*args`, `**kwargs`, and
//!   typed/defaulted params. `def m(self, a, b=1)` → 3.
//! - **TypeScript/JS** (`lang-ts`): named children whose node kind ends in
//!   `parameter` (required/optional/rest); type-only nodes don't count.
//!   `function f(a: number, b?: string)` → 2.
//! - **Rust** (`lang-rust`): named children of kind `parameter` or
//!   `self_parameter`. `fn m(&self, a: i32)` → 2.
//! - **Go** (`lang-go`): number of parameter *names* across all
//!   `parameter_declaration` and `variadic_parameter_declaration` children of
//!   the `parameters` list; a zero-name (type-only) declaration counts as 1;
//!   receiver, result, and generic type parameters are excluded.
//!   `func f(a, b int)` → 2; `func f(int, string)` → 2; `func (s *S) M(a int)` → 1.
//!
//! These intentionally differ per language; do not "normalize" them.

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
