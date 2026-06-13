/** Removes Cypher comments and string/backtick literals so keyword scanning
 *  only sees structural tokens. */
function stripLiteralsAndComments(query: string): string {
  let out = "";
  let i = 0;
  const n = query.length;
  while (i < n) {
    const c = query[i]!;
    const next = query[i + 1];
    // line comment //...
    if (c === "/" && next === "/") {
      while (i < n && query[i] !== "\n") i++;
      continue;
    }
    // block comment /* ... */
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(query[i] === "*" && query[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // string / identifier literals: ' " `
    if (c === "'" || c === '"' || c === "`") {
      const quote = c;
      i++;
      while (i < n) {
        if (query[i] === "\\") {
          i += 2;
          continue;
        }
        if (query[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      out += " "; // replace the whole literal with a space
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const WRITE_CLAUSES = [
  "CREATE",
  "MERGE",
  "DELETE",
  "SET",
  "REMOVE",
  "DROP",
  "FOREACH",
];

/** Throws if `query` is not a read-only Cypher statement (PRD §3.7 layer 2).
 *  Note: the Neo4j READ-mode session is the real enforcement; this is a
 *  fast-fail layer that gives the agent a clear error to self-correct. */
export function assertReadOnly(query: string): void {
  const stripped = stripLiteralsAndComments(query);

  // No statement stacking.
  if (stripped.includes(";")) {
    throw new Error("read-only guard: multiple statements are not allowed");
  }
  // LOAD CSV.
  if (/\bLOAD\s+CSV\b/i.test(stripped)) {
    throw new Error("read-only guard: LOAD CSV is not allowed");
  }
  // Named procedure calls: default-deny. Only a small read-only allowlist is
  // permitted; everything else (incl. unknown/third-party write procs) is
  // rejected. `CALL { ... }` subqueries have no procedure name so they pass
  // here and are scanned for write clauses below. The Neo4j READ session is
  // the authoritative backstop; this is PRD §3.7 layer 2 as default-deny.
  const PROC_ALLOWLIST =
    /^(db\.labels|db\.relationshipTypes|db\.propertyKeys|db\.schema(\.|$)|apoc\.(path|coll|text|map|convert|meta)\.)/i;
  const procRe = /\bCALL\s+([A-Za-z_][\w.]*)/gi;
  let pm: RegExpExecArray | null;
  while ((pm = procRe.exec(stripped)) !== null) {
    const proc = pm[1]!;
    if (!PROC_ALLOWLIST.test(proc)) {
      throw new Error(
        `read-only guard: procedure '${proc}' is not on the read-only allowlist`
      );
    }
  }
  // Write clauses as whole words.
  for (const kw of WRITE_CLAUSES) {
    const re = new RegExp(`\\b${kw}\\b`, "i");
    if (re.test(stripped)) {
      throw new Error(`read-only guard: write clause '${kw}' is not allowed`);
    }
  }
}
