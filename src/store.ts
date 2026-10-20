import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Tier } from "./config.js";

export type Decision = "allow" | "deny";
export type Scope = "once" | "session" | "repo" | "always";
export type Source = "rule" | "grant" | "dialog" | "no-dialog-default";

export interface Record_ {
  id: string;
  ts: string;
  session_id: string;
  actor: string;
  agent: string;
  tool: string;
  repo: string | null;
  args: string;
  tier: Tier;
  rule: string;
  decision: Decision;
  scope: Scope | null;
  source: Source;
  grant_id: string | null;
  outcome: "ok" | "error" | "blocked";
  error: string | null;
  prev_hash: string | null;
  hash: string;
}

export interface Grant {
  id: string;
  ts: string;
  actor: string;
  agent: string;
  tool: string;
  repo: string | null;
  scope: Scope;
  session_id: string | null;
  revoked_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL UNIQUE,
  ts         TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor      TEXT NOT NULL,
  agent      TEXT NOT NULL,
  tool       TEXT NOT NULL,
  repo       TEXT,
  args       TEXT NOT NULL,
  tier       TEXT NOT NULL,
  rule       TEXT NOT NULL,
  decision   TEXT NOT NULL,
  scope      TEXT,
  source     TEXT NOT NULL,
  grant_id   TEXT,
  outcome    TEXT NOT NULL,
  error      TEXT,
  prev_hash  TEXT,
  hash       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  id         TEXT PRIMARY KEY,
  ts         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  agent      TEXT NOT NULL,
  tool       TEXT NOT NULL,
  repo       TEXT,
  scope      TEXT NOT NULL,
  session_id TEXT,
  revoked_at TEXT
);
-- Append-only: refuse edits and deletes at the database level.
CREATE TRIGGER IF NOT EXISTS records_no_update BEFORE UPDATE ON records
  BEGIN SELECT RAISE(ABORT, 'records is append-only'); END;
CREATE TRIGGER IF NOT EXISTS records_no_delete BEFORE DELETE ON records
  BEGIN SELECT RAISE(ABORT, 'records is append-only'); END;
`;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  private lastHash(): string | null {
    const row = this.db.prepare("SELECT hash FROM records ORDER BY seq DESC LIMIT 1").get() as
      | { hash: string }
      | undefined;
    return row?.hash ?? null;
  }

  static hashOf(r: Omit<Record_, "hash">): string {
    const h = createHash("sha256");
    h.update(
      JSON.stringify([
        r.id, r.ts, r.session_id, r.actor, r.agent, r.tool, r.repo, r.args, r.tier, r.rule,
        r.decision, r.scope, r.source, r.grant_id, r.outcome, r.error, r.prev_hash,
      ])
    );
    return h.digest("hex");
  }

  append(input: Omit<Record_, "id" | "ts" | "prev_hash" | "hash">): Record_ {
    const base: Omit<Record_, "hash"> = {
      ...input,
      id: randomUUID(),
      ts: new Date().toISOString(),
      prev_hash: this.lastHash(),
    };
    const rec: Record_ = { ...base, hash: Store.hashOf(base) };
    this.db
      .prepare(
        `INSERT INTO records (id, ts, session_id, actor, agent, tool, repo, args, tier, rule, decision, scope, source, grant_id, outcome, error, prev_hash, hash)
         VALUES (@id, @ts, @session_id, @actor, @agent, @tool, @repo, @args, @tier, @rule, @decision, @scope, @source, @grant_id, @outcome, @error, @prev_hash, @hash)`
      )
      .run(rec as unknown as globalThis.Record<string, string | null>);
    return rec;
  }

  addGrant(g: Omit<Grant, "id" | "ts" | "revoked_at">): Grant {
    const grant: Grant = { ...g, id: randomUUID(), ts: new Date().toISOString(), revoked_at: null };
    this.db
      .prepare(
        `INSERT INTO grants (id, ts, actor, agent, tool, repo, scope, session_id, revoked_at)
         VALUES (@id, @ts, @actor, @agent, @tool, @repo, @scope, @session_id, @revoked_at)`
      )
      .run(grant as unknown as globalThis.Record<string, string | null>);
    return grant;
  }

  /** Find a live grant that covers this call. Session grants only match their own session. */
  findGrant(q: { actor: string; agent: string; tool: string; repo: string | null; session_id: string }): Grant | null {
    const rows = this.db
      .prepare(
        `SELECT * FROM grants
         WHERE revoked_at IS NULL AND actor = ? AND agent = ? AND tool = ?
         ORDER BY ts DESC`
      )
      .all(q.actor, q.agent, q.tool) as unknown as Grant[];
    for (const g of rows) {
      if (g.scope === "always") return g;
      if (g.scope === "repo" && g.repo && g.repo === q.repo) return g;
      if (g.scope === "session" && g.session_id === q.session_id) return g;
    }
    return null;
  }

  revokeGrant(id: string): boolean {
    const r = this.db.prepare("UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id);
    return r.changes > 0;
  }

  listRecords(opts: { limit?: number; tool?: string; decision?: Decision; since?: string } = {}): Record_[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.tool) { where.push("tool = ?"); params.push(opts.tool); }
    if (opts.decision) { where.push("decision = ?"); params.push(opts.decision); }
    if (opts.since) { where.push("ts >= ?"); params.push(opts.since); }
    const sql = `SELECT * FROM records ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ?`;
    params.push(opts.limit ?? 50);
    return this.db.prepare(sql).all(...params) as unknown as Record_[];
  }

  listGrants(includeRevoked = false): Grant[] {
    const sql = `SELECT * FROM grants ${includeRevoked ? "" : "WHERE revoked_at IS NULL"} ORDER BY ts DESC`;
    return this.db.prepare(sql).all() as unknown as Grant[];
  }

  /** Walk the whole chain and report the first broken link, if any. */
  verify(): { ok: true; count: number } | { ok: false; at: number; id: string } {
    const rows = this.db.prepare("SELECT * FROM records ORDER BY seq ASC").all() as unknown as (Record_ & { seq: number })[];
    let prev: string | null = null;
    for (const r of rows) {
      const { hash, seq, ...rest } = r;
      if (rest.prev_hash !== prev || Store.hashOf(rest) !== hash) return { ok: false, at: seq, id: r.id };
      prev = hash;
    }
    return { ok: true, count: rows.length };
  }

  close() { this.db.close(); }
}
