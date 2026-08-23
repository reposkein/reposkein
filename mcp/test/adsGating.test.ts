import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AD_ELIGIBLE_TOOLS, resolveAdsVerdict, SLOT_TIMEOUT_MS } from "../src/ads/config.js";
import { isSupporter } from "../src/ads/supporter.js";
import { readConfigBool } from "../src/store/teamConfig.js";

/** A repo whose `.reposkein/config.toml` holds `body`. */
function repoWithConfig(body: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "reposkein-ads-cfg-"));
  mkdirSync(join(dir, ".reposkein"), { recursive: true });
  if (body !== null) writeFileSync(join(dir, ".reposkein", "config.toml"), body);
  return dir;
}

const CREDS = { LULU_ADS_PUBLISHER_ID: "pub_test", LULU_ADS_API_KEY: "lk_test" };

describe("ads gating chain — off by default", () => {
  it("is off with no env and no config (the state of every install)", () => {
    const verdict = resolveAdsVerdict({ env: {}, repoPath: undefined });
    expect(verdict).toEqual({ enabled: false, reason: "not_opted_in" });
  });

  it("is off with credentials present but no opt-in", () => {
    expect(resolveAdsVerdict({ env: { ...CREDS } })).toEqual({
      enabled: false,
      reason: "not_opted_in",
    });
  });

  it("is off when opted in but credentials are absent", () => {
    expect(resolveAdsVerdict({ env: { REPOSKEIN_ADS: "on" } })).toEqual({
      enabled: false,
      reason: "no_credentials",
    });
  });

  it("is off when only one of the two credentials is present", () => {
    expect(
      resolveAdsVerdict({ env: { REPOSKEIN_ADS: "on", LULU_ADS_PUBLISHER_ID: "pub_x" } }).enabled
    ).toBe(false);
    expect(
      resolveAdsVerdict({ env: { REPOSKEIN_ADS: "on", LULU_ADS_API_KEY: "lk_x" } }).enabled
    ).toBe(false);
  });

  it("treats whitespace-only credentials as absent", () => {
    const verdict = resolveAdsVerdict({
      env: { REPOSKEIN_ADS: "on", LULU_ADS_PUBLISHER_ID: "  ", LULU_ADS_API_KEY: "\t" },
    });
    expect(verdict).toEqual({ enabled: false, reason: "no_credentials" });
  });

  it("enables only with opt-in AND both credentials", () => {
    const verdict = resolveAdsVerdict({ env: { REPOSKEIN_ADS: "on", ...CREDS } });
    expect(verdict.enabled).toBe(true);
    if (verdict.enabled) {
      expect(verdict.clickHosts).toEqual(["ads.getlulu.dev"]);
      expect(verdict.baseUrl).toBe("https://ads.getlulu.dev");
    }
  });
});

describe("ads gating chain — the kill switch outranks everything", () => {
  it("REPOSKEIN_ADS=off beats credentials", () => {
    expect(resolveAdsVerdict({ env: { REPOSKEIN_ADS: "off", ...CREDS } })).toEqual({
      enabled: false,
      reason: "kill_switch",
    });
  });

  it("REPOSKEIN_ADS=off beats a repo that committed [ads] enabled = true", () => {
    const dir = repoWithConfig("[ads]\nenabled = true\n");
    try {
      const verdict = resolveAdsVerdict({
        env: { REPOSKEIN_ADS: "off", ...CREDS },
        repoPath: dir,
      });
      expect(verdict).toEqual({ enabled: false, reason: "kill_switch" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts OFF/0/false spellings", () => {
    for (const value of ["off", "OFF", "Off", "0", "false"]) {
      expect(resolveAdsVerdict({ env: { REPOSKEIN_ADS: value, ...CREDS } })).toEqual({
        enabled: false,
        reason: "kill_switch",
      });
    }
  });
});

describe("ads gating chain — config.toml declares, the environment confirms", () => {
  it("[ads] enabled = true alone does NOT opt in (config travels with a clone)", () => {
    const dir = repoWithConfig("[team]\npages_url = \"https://x.example\"\n\n[ads]\nenabled = true\n");
    try {
      expect(readConfigBool(dir, "ads", "enabled")).toBe(true);
      expect(resolveAdsVerdict({ env: { ...CREDS }, repoPath: dir })).toEqual({
        enabled: false,
        reason: "config_not_confirmed",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[ads] enabled = true plus REPOSKEIN_ADS=on opts in", () => {
    const dir = repoWithConfig("[ads]\nenabled = true\n");
    try {
      expect(
        resolveAdsVerdict({ env: { REPOSKEIN_ADS: "on", ...CREDS }, repoPath: dir }).enabled
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads a quoted "true" the same way the indexer\'s scanner does', () => {
    const dir = repoWithConfig('[ads]\nenabled = "true"\n');
    try {
      expect(readConfigBool(dir, "ads", "enabled")).toBe(true);
      // Still not enough on its own — the env must confirm.
      expect(resolveAdsVerdict({ env: { ...CREDS }, repoPath: dir }).enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes a repo that asked from a repo that never asked", () => {
    const asked = repoWithConfig("[ads]\nenabled = true\n");
    const silent = repoWithConfig("[ads]\nenabled = false\n");
    try {
      expect(resolveAdsVerdict({ env: { ...CREDS }, repoPath: asked }).enabled).toBe(false);
      expect(resolveAdsVerdict({ env: { ...CREDS }, repoPath: asked })).toMatchObject({
        reason: "config_not_confirmed",
      });
      expect(resolveAdsVerdict({ env: { ...CREDS }, repoPath: silent })).toEqual({
        enabled: false,
        reason: "not_opted_in",
      });
    } finally {
      rmSync(asked, { recursive: true, force: true });
      rmSync(silent, { recursive: true, force: true });
    }
  });

  it("a key in another section does not opt in", () => {
    const dir = repoWithConfig("[hooks]\nenabled = true\n");
    try {
      expect(resolveAdsVerdict({ env: { ...CREDS }, repoPath: dir }).enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing config.toml does not opt in", () => {
    const dir = repoWithConfig(null);
    try {
      expect(resolveAdsVerdict({ env: { ...CREDS }, repoPath: dir })).toEqual({
        enabled: false,
        reason: "not_opted_in",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the kill switch still outranks a confirmed opt-in", () => {
    const dir = repoWithConfig("[ads]\nenabled = true\n");
    try {
      expect(
        resolveAdsVerdict({ env: { REPOSKEIN_ADS: "off", ...CREDS }, repoPath: dir })
      ).toEqual({ enabled: false, reason: "kill_switch" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ads gating chain — supporter and base URL", () => {
  it("a supporter never gets a slot, even fully opted in with credentials", () => {
    const verdict = resolveAdsVerdict({
      env: { REPOSKEIN_ADS: "on", ...CREDS },
      isSupporter: () => true,
    });
    expect(verdict).toEqual({ enabled: false, reason: "supporter" });
  });

  it("reports non-supporter when there is no entitlement file (REP-29)", () => {
    // Pointed at a path that certainly holds no token, so the assertion is
    // about the code rather than about whatever is in the developer's home
    // directory. The token format, grace window, and forgery rejection are
    // covered in supporterToken/supporterEntitlement.
    const empty = mkdtempSync(join(tmpdir(), "reposkein-no-entitlement-"));
    expect(isSupporter({ REPOSKEIN_SUPPORTER_FILE: join(empty, "supporter.jwt") })).toBe(false);
  });

  it("derives the click-host allowlist from the base URL actually in use", () => {
    const verdict = resolveAdsVerdict({
      env: { REPOSKEIN_ADS: "on", ...CREDS, LULU_ADS_BASE_URL: "https://ads.example.test/" },
    });
    expect(verdict.enabled).toBe(true);
    if (verdict.enabled) {
      expect(verdict.clickHosts).toEqual(["ads.example.test"]);
      expect(verdict.baseUrl).toBe("https://ads.example.test");
    }
  });

  it("refuses a plaintext remote base URL", () => {
    expect(
      resolveAdsVerdict({
        env: { REPOSKEIN_ADS: "on", ...CREDS, LULU_ADS_BASE_URL: "http://ads.example.test" },
      })
    ).toEqual({ enabled: false, reason: "bad_base_url" });
  });

  it("refuses an unparseable base URL", () => {
    expect(
      resolveAdsVerdict({ env: { REPOSKEIN_ADS: "on", ...CREDS, LULU_ADS_BASE_URL: "not a url" } })
    ).toEqual({ enabled: false, reason: "bad_base_url" });
  });
});

describe("ads placement policy", () => {
  it("only get_context_profile is eligible", () => {
    expect([...AD_ELIGIBLE_TOOLS]).toEqual(["get_context_profile"]);
  });

  it("semantic_find is never eligible (governing ADR, ruling 2: retrieval stays clean)", () => {
    expect(AD_ELIGIBLE_TOOLS).not.toContain("semantic_find");
  });

  it("no mutating tool is eligible", () => {
    for (const tool of [
      "write_semantic_summary",
      "record_decision",
      "set_decision_status",
      "reaffirm_decision",
      "reanchor_decision",
      "reindex_file",
      "init_cpg_skeleton",
    ]) {
      expect(AD_ELIGIBLE_TOOLS).not.toContain(tool);
    }
  });

  it("the slot budget stays well under a second", () => {
    expect(SLOT_TIMEOUT_MS).toBeLessThanOrEqual(800);
  });
});
