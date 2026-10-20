import type { Tier } from "./config.js";

/**
 * Built-in classification for the official GitHub MCP server's tools.
 * Anything not listed falls through to the heuristics below, and
 * user config overrides both.
 */
const GITHUB_DANGEROUS = new Set([
  "merge_pull_request",
  "delete_branch",
  "delete_file",
  "delete_repository",
  "push_files",
  "create_release",
  "update_release",
  "delete_release",
  "add_collaborator",
  "remove_collaborator",
  "dismiss_pull_request_review",
  "transfer_repository",
  "delete_workflow_run",
  "delete_workflow_run_logs",
  "run_workflow",
  "rerun_workflow_run",
  "rerun_failed_jobs",
  "cancel_workflow_run",
  "update_repository",
]);

const GITHUB_WRITE_PREFIXES = [
  "create_",
  "update_",
  "add_",
  "submit_",
  "request_",
  "fork_",
  "assign_",
  "mark_",
  "manage_",
  "push_",
  "star_",
  "unstar_",
  "close_",
  "reopen_",
];

const READ_PREFIXES = ["get_", "list_", "search_", "read_", "fetch_", "download_", "view_", "describe_"];

export interface Classification {
  tier: Tier;
  /** Which rule produced the tier, for the record. */
  rule: string;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export function classify(toolName: string, userRules: Record<string, Tier>): Classification {
  // 1. exact user rule
  if (userRules[toolName]) return { tier: userRules[toolName], rule: `config:${toolName}` };

  // 2. pattern user rule (first match in config order)
  for (const [pattern, tier] of Object.entries(userRules)) {
    if (pattern.includes("*") || pattern.includes("?")) {
      if (globToRegex(pattern).test(toolName)) return { tier, rule: `config:${pattern}` };
    }
  }

  // 3. built-in GitHub knowledge
  if (GITHUB_DANGEROUS.has(toolName)) return { tier: "dangerous", rule: "builtin:github-dangerous" };

  // 4. name heuristics
  if (READ_PREFIXES.some((p) => toolName.startsWith(p))) return { tier: "read", rule: "heuristic:read-prefix" };
  if (/delete|remove|destroy|force|purge/i.test(toolName)) return { tier: "dangerous", rule: "heuristic:destructive-word" };
  if (GITHUB_WRITE_PREFIXES.some((p) => toolName.startsWith(p))) return { tier: "write", rule: "heuristic:write-prefix" };

  // 5. unknown → treat as write so it at least gets a confirmation
  return { tier: "write", rule: "default:unknown" };
}

/** Pull an "owner/repo" out of tool arguments if the GitHub server style is used. */
export function extractRepo(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const owner = a.owner ?? a.org ?? a.organization;
  const repo = a.repo ?? a.repository;
  if (typeof owner === "string" && typeof repo === "string") return `${owner}/${repo}`;
  if (typeof repo === "string" && repo.includes("/")) return repo;
  return null;
}
