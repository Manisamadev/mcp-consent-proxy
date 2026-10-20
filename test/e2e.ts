// End-to-end: fake client → proxy → fake-github. Dialogs are answered by a script.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";

const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "consent-e2e-"));
const dbPath = join(dir, "consent.sqlite");
const cfgPath = join(dir, "consent.config.json");
writeFileSync(cfgPath, JSON.stringify({
  upstream: { command: "npx", args: ["tsx", resolve(root, "test/fake-github.ts")] },
  dbPath,
  actor: "alice",
}));

// What the "user" will click, in order.
const answers: string[] = ["allow_once", "deny", "allow_repo", "allow_session"];
const asked: string[] = [];

const client = new Client({ name: "fake-agent", version: "1.0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async (req) => {
  asked.push(req.params.message.split("\n")[0]);
  const a = answers.shift();
  if (!a) throw new Error("test asked for more decisions than scripted");
  return { action: "accept", content: { decision: a } };
});

await client.connect(new StdioClientTransport({
  command: "npx",
  args: ["tsx", resolve(root, "src/proxy.ts")],
  env: { ...process.env, MCP_CONSENT_CONFIG: cfgPath } as Record<string, string>,
  stderr: "pipe",
}));

const call = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: { type: string; text?: string }[] }>;
const text = (r: { content: { text?: string }[] }) => r.content[0]?.text ?? "";
const R = { owner: "octo", repo: "demo" };

// 1. tool list passes through
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["create_issue", "get_file_contents", "merge_pull_request"]);

// 2. read → no dialog
let r = await call("get_file_contents", { ...R, path: "README.md" });
assert.equal(text(r), "contents of README.md");
assert.equal(asked.length, 0);

// 3. write → dialog, allow once
r = await call("create_issue", { ...R, title: "first" });
assert.equal(text(r), "created issue #42: first");
assert.equal(asked.length, 1);

// 4. same write again → asked again (once means once), deny
r = await call("create_issue", { ...R, title: "second" });
assert.equal(r.isError, true);
assert.match(text(r), /Blocked by consent proxy/);
assert.equal(asked.length, 2);

// 5. allow for repo → third call needs no dialog
r = await call("create_issue", { ...R, title: "third" });
assert.equal(asked.length, 3);
r = await call("create_issue", { ...R, title: "fourth" });
assert.equal(text(r), "created issue #42: fourth");
assert.equal(asked.length, 3, "repo grant should have been reused");

// 6. different repo → asked again
r = await call("create_issue", { owner: "octo", repo: "other", title: "fifth" });
assert.equal(asked.length, 4);

// 7. dangerous tool with no scripted answer: dialog throws → proxy denies safely
r = await call("merge_pull_request", { ...R, pull_number: 7 });
assert.equal(r.isError, true);

await client.close();

// 8. the record
const store = new Store(dbPath);
const recs = store.listRecords({ limit: 100 }).reverse();
assert.equal(recs.length, 7);
assert.deepEqual(recs.map((x) => `${x.tool}:${x.tier}:${x.decision}:${x.source}`), [
  "get_file_contents:read:allow:rule",
  "create_issue:write:allow:dialog",
  "create_issue:write:deny:dialog",
  "create_issue:write:allow:dialog",
  "create_issue:write:allow:grant",
  "create_issue:write:allow:dialog",
  "merge_pull_request:dangerous:deny:dialog",
]);
assert.equal(recs.every((x) => x.actor === "alice" && x.agent === "fake-agent@1.0"), true);
const grants = store.listGrants();
assert.deepEqual(grants.map((g) => `${g.scope}:${g.repo ?? "-"}`).sort(), ["repo:octo/demo", "session:-"]);
assert.deepEqual(store.verify(), { ok: true, count: 7 });
store.close();

rmSync(dir, { recursive: true, force: true });
console.log("e2e OK — 7 records, 2 grants, hash chain verified");
process.exit(0);
