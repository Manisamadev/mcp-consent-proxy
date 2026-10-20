#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { Store, type Decision } from "./store.js";

const USAGE = `mcp-consent — browse the consent record

  mcp-consent history [--limit N] [--tool NAME] [--denied|--allowed] [--since ISO] [--json]
  mcp-consent grants  [--all] [--json]
  mcp-consent revoke  <grant-id>
  mcp-consent verify

Config is read from ./consent.config.json or $MCP_CONSENT_CONFIG.
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const has = (args: string[], name: string) => args.includes(name);

function pad(s: string | null | undefined, n: number) {
  const v = (s ?? "").toString();
  return v.length > n ? v.slice(0, n - 1) + "…" : v.padEnd(n);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") { process.stdout.write(USAGE); return; }

  const config = loadConfig();
  const store = new Store(config.dbPath);
  const json = has(rest, "--json");

  try {
    switch (cmd) {
      case "history": {
        const decision: Decision | undefined = has(rest, "--denied") ? "deny" : has(rest, "--allowed") ? "allow" : undefined;
        const rows = store.listRecords({
          limit: Number(flag(rest, "--limit") ?? 50),
          tool: flag(rest, "--tool"),
          decision,
          since: flag(rest, "--since"),
        });
        if (json) { console.log(JSON.stringify(rows, null, 2)); break; }
        if (rows.length === 0) { console.log("(no records)"); break; }
        console.log(
          pad("when", 20), pad("actor", 10), pad("agent", 22), pad("tool", 26), pad("repo", 24),
          pad("tier", 9), pad("decision", 8), pad("via", 18), "outcome"
        );
        for (const r of rows.reverse()) {
          const via = r.source === "grant" ? `grant:${r.scope}` : r.source === "dialog" ? `dialog:${r.scope}` : r.source;
          console.log(
            pad(r.ts.replace("T", " ").slice(0, 19), 20), pad(r.actor, 10), pad(r.agent, 22), pad(r.tool, 26),
            pad(r.repo, 24), pad(r.tier, 9), pad(r.decision, 8), pad(via, 18), r.outcome
          );
        }
        break;
      }
      case "grants": {
        const rows = store.listGrants(has(rest, "--all"));
        if (json) { console.log(JSON.stringify(rows, null, 2)); break; }
        if (rows.length === 0) { console.log("(no grants)"); break; }
        console.log(pad("id", 38), pad("when", 20), pad("actor", 10), pad("agent", 22), pad("tool", 26), pad("scope", 8), pad("repo", 24), "revoked");
        for (const g of rows) {
          console.log(pad(g.id, 38), pad(g.ts.replace("T", " ").slice(0, 19), 20), pad(g.actor, 10), pad(g.agent, 22), pad(g.tool, 26), pad(g.scope, 8), pad(g.repo, 24), g.revoked_at ?? "-");
        }
        break;
      }
      case "revoke": {
        const id = rest[0];
        if (!id) { console.error("revoke: grant id required"); process.exit(2); }
        console.log(store.revokeGrant(id) ? `revoked ${id}` : `no active grant with id ${id}`);
        break;
      }
      case "verify": {
        const v = store.verify();
        if (v.ok) console.log(`chain OK — ${v.count} records, no tampering detected`);
        else { console.log(`chain BROKEN at seq ${v.at} (record ${v.id})`); process.exit(1); }
        break;
      }
      default:
        process.stderr.write(USAGE);
        process.exit(2);
    }
  } finally {
    store.close();
  }
}

main();
