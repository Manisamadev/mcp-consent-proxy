#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type CallToolResult,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { loadConfig, type Config, type Tier } from "./config.js";
import { classify, extractRepo } from "./rules.js";
import { Store, type Scope, type Decision, type Source } from "./store.js";

const log = (...a: unknown[]) => console.error("[consent-proxy]", ...a);

type DialogChoice = "allow_once" | "allow_session" | "allow_repo" | "allow_always" | "deny";

async function askUser(
  server: Server,
  p: { tool: string; tier: Tier; repo: string | null; args: unknown; agent: string }
): Promise<DialogChoice | "cancel"> {
  const argPreview = JSON.stringify(p.args ?? {}, null, 0);
  const shown = argPreview.length > 400 ? argPreview.slice(0, 400) + "…" : argPreview;
  const options: { const: DialogChoice; title: string }[] = [
    { const: "allow_once", title: "Allow this once" },
    { const: "allow_session", title: "Allow for this session" },
  ];
  if (p.repo) options.push({ const: "allow_repo", title: `Allow always for ${p.repo}` });
  if (p.tier !== "dangerous") options.push({ const: "allow_always", title: "Allow always (any repo)" });
  options.push({ const: "deny", title: "Deny" });

  const res = await server.elicitInput({
    mode: "form",
    message:
      `Agent "${p.agent}" wants to call ${p.tool}` +
      (p.repo ? ` on ${p.repo}` : "") +
      ` [${p.tier.toUpperCase()}]\n\nArguments: ${shown}`,
    requestedSchema: {
      type: "object",
      properties: {
        decision: { type: "string", title: "Decision", oneOf: options },
      },
      required: ["decision"],
    },
  });
  if (res.action === "accept") return (res.content?.decision as DialogChoice) ?? "deny";
  if (res.action === "decline") return "deny";
  return "cancel";
}

async function main() {
  const config: Config = loadConfig();
  const store = new Store(config.dbPath);
  const sessionId = randomUUID();

  // ---- upstream -------------------------------------------------------
  const upstream = new Client({ name: "mcp-consent-proxy", version: "0.1.0" });
  await upstream.connect(
    new StdioClientTransport({
      command: config.upstream.command,
      args: config.upstream.args ?? [],
      env: { ...process.env, ...config.upstream.env } as globalThis.Record<string, string>,
      stderr: "inherit",
    })
  );
  const upCaps = upstream.getServerCapabilities() ?? {};
  const upInfo = upstream.getServerVersion();
  log(`upstream connected: ${upInfo?.name ?? "?"} ${upInfo?.version ?? ""}`);

  // Only advertise what the upstream actually has.
  const caps: ServerCapabilities = {};
  if (upCaps.tools) caps.tools = {};
  if (upCaps.resources) caps.resources = {};
  if (upCaps.prompts) caps.prompts = {};

  // ---- downstream -----------------------------------------------------
  const server = new Server(
    { name: `${upInfo?.name ?? "upstream"} (consent)`, version: "0.1.0" },
    { capabilities: caps }
  );

  const agentName = () => {
    const c = server.getClientVersion();
    return c ? `${c.name}@${c.version}` : "unknown-client";
  };
  const canAsk = () => Boolean(server.getClientCapabilities()?.elicitation);

  // pass-through
  server.setRequestHandler(ListToolsRequestSchema, async (req) => upstream.listTools(req.params));
  if (upCaps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req) => upstream.listResources(req.params));
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => upstream.readResource(req.params));
  }
  if (upCaps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (req) => upstream.listPrompts(req.params));
    server.setRequestHandler(GetPromptRequestSchema, async (req) => upstream.getPrompt(req.params));
  }

  // the part that matters
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = req.params.name;
    const args = req.params.arguments ?? {};
    const { tier, rule } = classify(tool, config.rules);
    const repo = extractRepo(args);
    const agent = agentName();
    const actor = config.actor;

    let decision: Decision;
    let scope: Scope | null = null;
    let source: Source;
    let grantId: string | null = null;

    if (!config.confirm[tier]) {
      decision = "allow"; source = "rule";
    } else {
      const grant = store.findGrant({ actor, agent, tool, repo, session_id: sessionId });
      if (grant) {
        decision = "allow"; source = "grant"; scope = grant.scope; grantId = grant.id;
      } else if (!canAsk()) {
        decision = config.whenNoDialog[tier]; source = "no-dialog-default";
        log(`client cannot show dialogs; ${tier} tool ${tool} → ${decision} (whenNoDialog)`);
      } else {
        source = "dialog";
        let choice: DialogChoice | "cancel";
        try {
          choice = await askUser(server, { tool, tier, repo, args, agent });
        } catch (e) {
          log("dialog failed:", e);
          choice = "deny";
        }
        if (choice === "deny" || choice === "cancel") {
          decision = "deny"; scope = "once";
        } else {
          decision = "allow";
          scope = choice === "allow_once" ? "once" : choice === "allow_session" ? "session" : choice === "allow_repo" ? "repo" : "always";
          if (scope !== "once") {
            const g = store.addGrant({ actor, agent, tool, repo: scope === "repo" ? repo : null, scope, session_id: scope === "session" ? sessionId : null });
            grantId = g.id;
          }
        }
      }
    }

    const base = { session_id: sessionId, actor, agent, tool, repo, args: JSON.stringify(args), tier, rule, decision, scope, source, grant_id: grantId };

    if (decision === "deny") {
      store.append({ ...base, outcome: "blocked", error: null });
      return {
        isError: true,
        content: [{ type: "text", text: `Blocked by consent proxy: ${actor} did not allow "${tool}"${repo ? ` on ${repo}` : ""}.` }],
      };
    }

    try {
      const result = await upstream.callTool({ name: tool, arguments: args });
      store.append({ ...base, outcome: result.isError ? "error" : "ok", error: null });
      return result as CallToolResult;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      store.append({ ...base, outcome: "error", error: msg });
      throw e;
    }
  });

  const shutdown = async () => {
    try { await upstream.close(); } catch {}
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // When the agent disconnects, take the upstream down with us.
  server.onclose = () => { void shutdown(); };
  upstream.onclose = () => { log("upstream closed"); void shutdown(); };
  // The SDK's stdio transport does not watch for EOF on stdin, so do it here.
  process.stdin.on("end", () => { log("client disconnected"); void shutdown(); });
  process.stdin.on("close", () => { void shutdown(); });

  await server.connect(new StdioServerTransport());
  log(`ready. session=${sessionId} actor=${config.actor} db=${config.dbPath}`);
}

main().catch((e) => {
  log("fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
