import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTeamPagesUrl } from "../src/store/teamConfig.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rs-teamcfg-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function writeConfig(toml: string): void {
  mkdirSync(join(dir, ".reposkein"), { recursive: true });
  writeFileSync(join(dir, ".reposkein", "config.toml"), toml);
}

describe("readTeamPagesUrl", () => {
  it("returns null when config.toml doesn't exist", () => {
    expect(readTeamPagesUrl(dir)).toBeNull();
  });

  it("returns null when there's no [team] section", () => {
    writeConfig('schema_version = 1\n[languages]\nenabled = ["python"]\n');
    expect(readTeamPagesUrl(dir)).toBeNull();
  });

  it("returns null when [team] exists but pages_url is absent", () => {
    writeConfig("[team]\nname = \"platform\"\n");
    expect(readTeamPagesUrl(dir)).toBeNull();
  });

  it("reads pages_url from [team]", () => {
    writeConfig('[team]\npages_url = "https://reposkein.github.io/example"\n');
    expect(readTeamPagesUrl(dir)).toBe("https://reposkein.github.io/example");
  });

  it("handles single-quoted values and a trailing comment", () => {
    writeConfig("[team]\npages_url = 'https://example.com/repo' # published via CI\n");
    expect(readTeamPagesUrl(dir)).toBe("https://example.com/repo");
  });

  it("ignores pages_url outside the [team] section", () => {
    writeConfig('pages_url = "https://not-team.example"\n[team]\n');
    expect(readTeamPagesUrl(dir)).toBeNull();
  });

  it("only reads within [team] even when other sections follow", () => {
    writeConfig(
      '[team]\npages_url = "https://reposkein.github.io/example"\n\n[neo4j]\nuri = "neo4j://localhost:7687"\n'
    );
    expect(readTeamPagesUrl(dir)).toBe("https://reposkein.github.io/example");
  });

  it("stops applying [team] once a later section starts", () => {
    writeConfig('[team]\nname = "x"\n\n[other]\npages_url = "https://leaked.example"\n');
    expect(readTeamPagesUrl(dir)).toBeNull();
  });
});
