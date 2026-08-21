import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  detectAgents,
  parseAgentsFlag,
  writeAgentConfigs,
  formatAdapterResult,
  type Exec,
  type ExecResult,
  type AdapterResult,
} from "../src/cli/agentAdapters.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-agents-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** No CLI ever "available" — forces every adapter down its direct-file-write
 *  path, so tests don't depend on what's installed on the machine running
 *  them. */
function noCliExec(overrides: Partial<Record<string, ExecResult>> = {}): Exec {
  return (cmd) => overrides[cmd] ?? { status: 1, stdout: "", stderr: "not found" };
}

describe("parseAgentsFlag", () => {
  it("parses a comma-separated list", () => {
    expect(parseAgentsFlag("claude,cursor")).toEqual(["claude", "cursor"]);
  });
  it("parses space-separated and mixed case", () => {
    expect(parseAgentsFlag("Claude Opencode")).toEqual(["claude", "opencode"]);
  });
  it("drops unknown tokens instead of throwing", () => {
    expect(parseAgentsFlag("claude,bogus,cursor")).toEqual(["claude", "cursor"]);
  });
});

describe("detectAgents", () => {
  it("falls back to ['claude'] (generic .mcp.json) when nothing is detected", () => {
    expect(detectAgents(dir, noCliExec())).toEqual(["claude"]);
  });
  it("detects an existing .mcp.json even without the claude CLI", () => {
    writeFileSync(join(dir, ".mcp.json"), "{}");
    expect(detectAgents(dir, noCliExec())).toContain("claude");
  });
  it("detects opencode.json and .cursor/ independently", () => {
    writeFileSync(join(dir, "opencode.json"), "{}");
    mkdirSync(join(dir, ".cursor"));
    const agents = detectAgents(dir, noCliExec());
    expect(agents).toContain("opencode");
    expect(agents).toContain("cursor");
  });
  it("detects the claude CLI on PATH", () => {
    const exec = noCliExec({ claude: { status: 0, stdout: "1.0.0", stderr: "" } });
    expect(detectAgents(dir, exec)).toContain("claude");
  });
});

describe("writeAgentConfigs — .mcp.json (claude, no CLI)", () => {
  it("creates .mcp.json with mcpServers.reposkein on first run", () => {
    const results = writeAgentConfigs(dir, { agents: ["claude"], exec: noCliExec() });
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.action).toBe("created");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    const doc = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(doc.mcpServers.reposkein.command).toBe("reposkein-mcp");
    expect(doc.mcpServers.reposkein.env.REPOSKEIN_REPO_PATH).toBe(resolve(dir));
  });

  it("is idempotent: a second run reports unchanged and writes nothing new", () => {
    writeAgentConfigs(dir, { agents: ["claude"], exec: noCliExec() });
    const before = readFileSync(join(dir, ".mcp.json"), "utf8");
    const second = writeAgentConfigs(dir, { agents: ["claude"], exec: noCliExec() });
    expect(second[0]!.action).toBe("unchanged");
    expect(second[0]!.backupPath).toBeUndefined();
    expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe(before);
    // No duplicate entries / no stray backup files.
    const filesAfter = readdirSync(dir);
    expect(filesAfter.filter((f: string) => f.startsWith(".mcp.json")).length).toBe(1);
  });

  it("preserves other keys and other mcpServers entries when updating", () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ $schema: "x", mcpServers: { other: { command: "y" } } }, null, 2)
    );
    const before = readFileSync(join(dir, ".mcp.json"), "utf8");
    const results = writeAgentConfigs(dir, { agents: ["claude"], exec: noCliExec() });
    expect(results[0]!.action).toBe("updated");
    expect(results[0]!.backupPath).toBeDefined();
    expect(existsSync(results[0]!.backupPath!)).toBe(true);
    expect(readFileSync(results[0]!.backupPath!, "utf8")).toBe(before);
    const doc = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(doc.$schema).toBe("x");
    expect(doc.mcpServers.other.command).toBe("y");
    expect(doc.mcpServers.reposkein.command).toBe("reposkein-mcp");
  });

  it("dry-run never touches disk", () => {
    const results = writeAgentConfigs(dir, { agents: ["claude"], dryRun: true, exec: noCliExec() });
    expect(results[0]!.action).toBe("dry-run");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  });

  it("dry-run on an already-configured file reports unchanged, not dry-run", () => {
    writeAgentConfigs(dir, { agents: ["claude"], exec: noCliExec() });
    const results = writeAgentConfigs(dir, { agents: ["claude"], dryRun: true, exec: noCliExec() });
    expect(results[0]!.action).toBe("unchanged");
  });

  it("recovers from a corrupt existing .mcp.json instead of crashing", () => {
    writeFileSync(join(dir, ".mcp.json"), "{ not json");
    const results = writeAgentConfigs(dir, { agents: ["claude"], exec: noCliExec() });
    expect(results[0]!.action).toBe("updated");
    const doc = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(doc.mcpServers.reposkein.command).toBe("reposkein-mcp");
  });
});

describe("writeAgentConfigs — opencode.json", () => {
  it("uses the `mcp` (not mcpServers) key with type/command/environment/enabled", () => {
    const results = writeAgentConfigs(dir, { agents: ["opencode"], exec: noCliExec() });
    expect(results[0]!.action).toBe("created");
    const doc = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
    expect(doc.mcpServers).toBeUndefined();
    expect(doc.mcp.reposkein).toEqual({
      type: "local",
      command: ["reposkein-mcp"],
      environment: { REPOSKEIN_REPO_PATH: resolve(dir) },
      enabled: true,
    });
  });
});

describe("writeAgentConfigs — .cursor/mcp.json", () => {
  it("writes under .cursor/ with mcpServers, creating the directory", () => {
    const results = writeAgentConfigs(dir, { agents: ["cursor"], exec: noCliExec() });
    expect(results[0]!.action).toBe("created");
    expect(results[0]!.path).toBe(join(dir, ".cursor", "mcp.json"));
    const doc = JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8"));
    expect(doc.mcpServers.reposkein.command).toBe("reposkein-mcp");
  });
});

describe("writeAgentConfigs — claude CLI path", () => {
  it("prefers `claude mcp add` when the CLI is available, and is idempotent via `claude mcp get`", () => {
    const calls: string[][] = [];
    let entryExists = false;
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "claude") return { status: 1, stdout: "", stderr: "not found" };
      if (args[0] === "--version") return { status: 0, stdout: "1.0.0", stderr: "" };
      if (args[0] === "mcp" && args[1] === "get") return { status: entryExists ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "mcp" && args[1] === "add") { entryExists = true; return { status: 0, stdout: "", stderr: "" }; }
      return { status: 1, stdout: "", stderr: "" };
    };
    const first = writeAgentConfigs(dir, { agents: ["claude"], exec });
    expect(first[0]!.action).toBe("created");
    expect(calls.some((c) => c[0] === "claude" && c[1] === "mcp" && c[2] === "add")).toBe(true);
    // No file written directly — the CLI is the one writing .mcp.json.
    expect(existsSync(join(dir, ".mcp.json"))).toBe(false);

    const second = writeAgentConfigs(dir, { agents: ["claude"], exec });
    expect(second[0]!.action).toBe("unchanged");
  });

  it("dry-run prints the planned command and never invokes `mcp add`", () => {
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "claude") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "--version") return { status: 0, stdout: "1.0.0", stderr: "" };
      if (args[0] === "mcp" && args[1] === "get") return { status: 1, stdout: "", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    };
    const results = writeAgentConfigs(dir, { agents: ["claude"], dryRun: true, exec });
    expect(results[0]!.action).toBe("dry-run");
    expect(results[0]!.message).toContain("claude mcp add");
    expect(calls.some((c) => c[1] === "mcp" && c[2] === "add")).toBe(false);
  });

  it("surfaces a non-zero `claude mcp add` exit as an error result, not a throw", () => {
    const exec: Exec = (cmd, args) => {
      if (cmd !== "claude") return { status: 1, stdout: "", stderr: "" };
      if (args[0] === "--version") return { status: 0, stdout: "1.0.0", stderr: "" };
      if (args[0] === "mcp" && args[1] === "get") return { status: 1, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "boom" };
    };
    const results = writeAgentConfigs(dir, { agents: ["claude"], exec });
    expect(results[0]!.action).toBe("error");
    expect(results[0]!.message).toContain("boom");
  });
});

describe("writeAgentConfigs — multi-agent + full idempotence sweep", () => {
  it("running all three agents twice in a row yields unchanged the second time, no duplicate files", () => {
    const first = writeAgentConfigs(dir, { agents: ["claude", "opencode", "cursor"], exec: noCliExec() });
    expect(first.every((r) => r.action === "created")).toBe(true);
    const second = writeAgentConfigs(dir, { agents: ["claude", "opencode", "cursor"], exec: noCliExec() });
    expect(second.every((r) => r.action === "unchanged")).toBe(true);
  });
});

describe("formatAdapterResult", () => {
  it("renders a readable one-liner including the backup path when present", () => {
    const r: AdapterResult = { agent: "claude", path: "/x/.mcp.json", action: "updated", backupPath: "/x/.mcp.json.abc.bak", message: "updated .mcp.json" };
    const line = formatAdapterResult(r);
    expect(line).toContain("[claude]");
    expect(line).toContain("updated .mcp.json");
    expect(line).toContain("/x/.mcp.json.abc.bak");
  });
});
