import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";

export type Tier = "read" | "write" | "dangerous";

export interface Config {
  /** Upstream MCP server to wrap (stdio). */
  upstream: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
  };
  /** SQLite file for the append-only record. */
  dbPath: string;
  /** Who is granting permission. Defaults to the OS user. */
  actor: string;
  /**
   * Per-tool overrides. Keys are exact tool names or glob-like patterns
   * ("create_*", "*_branch"). Values are tiers.
   */
  rules: Record<string, Tier>;
  /**
   * What to do when the client cannot show a confirmation dialog
   * (no elicitation support). Per tier.
   */
  whenNoDialog: Record<Tier, "allow" | "deny">;
  /** Which tiers require a confirmation at all. */
  confirm: Record<Tier, boolean>;
}

export const DEFAULT_CONFIG_PATH = resolve(
  process.env.MCP_CONSENT_CONFIG ?? resolve(process.cwd(), "consent.config.json")
);

const defaults: Omit<Config, "upstream"> = {
  dbPath: resolve(os.homedir(), ".mcp-consent", "consent.sqlite"),
  actor: process.env.MCP_CONSENT_ACTOR ?? os.userInfo().username,
  rules: {},
  whenNoDialog: { read: "allow", write: "allow", dangerous: "deny" },
  confirm: { read: false, write: true, dangerous: true },
};

export function loadConfig(path: string = DEFAULT_CONFIG_PATH): Config {
  if (!existsSync(path)) {
    throw new Error(
      `Config not found: ${path}\n` +
        `Create it (see consent.config.example.json) or set MCP_CONSENT_CONFIG.`
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  if (!raw.upstream?.command) {
    throw new Error(`Config ${path}: "upstream.command" is required`);
  }
  return {
    upstream: raw.upstream,
    dbPath: raw.dbPath ? resolve(raw.dbPath.replace(/^~/, os.homedir())) : defaults.dbPath,
    actor: raw.actor ?? defaults.actor,
    rules: { ...raw.rules },
    whenNoDialog: { ...defaults.whenNoDialog, ...raw.whenNoDialog },
    confirm: { ...defaults.confirm, ...raw.confirm },
  };
}
