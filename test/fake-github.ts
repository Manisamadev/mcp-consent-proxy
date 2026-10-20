// A stand-in for the GitHub MCP server: three tools, one per tier.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const s = new McpServer({ name: "fake-github", version: "0.0.1" });

s.registerTool("get_file_contents", { inputSchema: { owner: z.string(), repo: z.string(), path: z.string() } },
  async ({ path }) => ({ content: [{ type: "text", text: `contents of ${path}` }] }));

s.registerTool("create_issue", { inputSchema: { owner: z.string(), repo: z.string(), title: z.string() } },
  async ({ title }) => ({ content: [{ type: "text", text: `created issue #42: ${title}` }] }));

s.registerTool("merge_pull_request", { inputSchema: { owner: z.string(), repo: z.string(), pull_number: z.number() } },
  async ({ pull_number }) => ({ content: [{ type: "text", text: `merged PR #${pull_number}` }] }));

await s.connect(new StdioServerTransport());
