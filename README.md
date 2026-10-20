# mcp-consent-proxy

An MCP proxy that sits between an agent and the GitHub MCP server, asks
"may this agent do this?" before write operations, and keeps an append-only,
hash-chained record of **who allowed what to which agent**.

```
agent (Claude, Cursor, …) ──▶ mcp-consent-proxy ──▶ github-mcp-server ──▶ GitHub
                                   │
                                   ├─ classify tool  (read / write / dangerous)
                                   ├─ ask the user   (MCP elicitation dialog)
                                   └─ record          (SQLite, append-only)
```

Neither the agent nor the GitHub server is modified. From the agent's side the
proxy *is* the GitHub server.

## How a call is decided

| tier | default | examples |
|---|---|---|
| `read` | pass through, record only | `get_*`, `list_*`, `search_*` |
| `write` | ask | `create_issue`, `create_pull_request`, `add_issue_comment` |
| `dangerous` | ask, and never offer "allow always for any repo" | `merge_pull_request`, `delete_branch`, `push_files`, `create_release` |

The dialog offers: **once · this session · always for this repo · always · deny**.
Every answer other than "once" creates a *grant*; later matching calls are
allowed without a dialog and the record says which grant they rode on.

Classification order: your `rules` (exact, then glob) → built-in GitHub list →
name heuristics → unknown tools are treated as `write` so they at least get a dialog.

If the client can't show dialogs (no elicitation support), `whenNoDialog`
decides: by default `write` is allowed, `dangerous` is denied, and the record
says `no-dialog-default` so you can see it happened.

## Setup

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`).

```sh
npm install
npm run build
cp consent.config.example.json consent.config.json   # edit upstream + actor
```

Then point your MCP client at the proxy instead of the GitHub server.
For Claude Desktop / Claude Code, something like:

```json
{
  "mcpServers": {
    "github": {
      "command": "node",
      "args": ["/path/to/mcp-consent-proxy/dist/proxy.js"],
      "env": { "MCP_CONSENT_CONFIG": "/path/to/consent.config.json" }
    }
  }
}
```

Config:

```jsonc
{
  "upstream": { "command": "docker", "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
                "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…" } },
  "dbPath": "~/.mcp-consent/consent.sqlite",
  "actor": "alice",                                   // who is granting; defaults to OS user
  "rules": { "delete_*": "dangerous", "create_issue": "write" },
  "confirm": { "read": false, "write": true, "dangerous": true },
  "whenNoDialog": { "read": "allow", "write": "allow", "dangerous": "deny" }
}
```

## Reading the record

```sh
npx mcp-consent history                 # last 50 decisions
npx mcp-consent history --denied        # only blocked calls
npx mcp-consent history --tool merge_pull_request --json
npx mcp-consent grants                  # standing permissions
npx mcp-consent revoke <grant-id>
npx mcp-consent verify                  # walk the hash chain
```

```
when                 actor  agent               tool                repo       tier       decision via          outcome
2026-10-21 07:39:10  alice  claude-desktop@2.0  get_file_contents   octo/demo  read       allow    rule         ok
2026-10-21 07:39:10  alice  claude-desktop@2.0  create_issue        octo/demo  write      allow    dialog:repo  ok
2026-10-21 07:39:10  alice  claude-desktop@2.0  create_issue        octo/demo  write      allow    grant:repo   ok
2026-10-21 07:39:10  alice  claude-desktop@2.0  merge_pull_request  octo/demo  dangerous  deny     dialog:once  blocked
```

Each record stores: timestamp, session, actor, agent (`clientInfo` from the MCP
handshake), tool, repo, full arguments, tier, the rule that produced the tier,
decision, scope, how it was decided (`rule` / `grant` / `dialog` /
`no-dialog-default`), the grant it used, and the upstream outcome.

### Tamper resistance

- `records` has `BEFORE UPDATE` / `BEFORE DELETE` triggers that abort.
- Every record carries `sha256(prev_hash + contents)`. `verify` recomputes the
  chain and reports the first broken link. Dropping the triggers and editing a
  row is caught.

This is *detection*, not *prevention*: anyone with write access to the file can
rewrite the whole chain. Shipping the head hash somewhere else periodically
(a log line, another machine) is what turns it into real evidence.

## Development

```sh
npm test            # e2e: fake agent → proxy → fake GitHub server, scripted dialog answers
npm run dev:proxy   # run from source
```

`test/fake-github.ts` is a three-tool stand-in for the GitHub server so the
tests need no token.

## Not yet

- Multi-user / team: `actor` is a config value, not an authenticated identity.
- Dialogs when nobody is at the keyboard (Slack approval, timeout policies).
- Delegation chains (sub-agents inheriting a parent's grant).
- Expiring grants.
- HTTP transport for the upstream (stdio only).
