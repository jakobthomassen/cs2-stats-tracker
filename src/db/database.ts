/**
 * SQLite via sql.js (pure WASM — no native compilation required).
 *
 * sql.js keeps the database in memory; we persist to disk after every write.
 * Call initDb() once at startup (it's async), then use getDb() everywhere else.
 */

import initSqlJs, { BindParams, Database, SqlJsStatic } from 'sql.js';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH  = path.join(DATA_DIR, 'tracker.db');

let _SQL: SqlJsStatic | null = null;
let _db:  Database    | null = null;
let _inTx = false;   // suppress per-statement saves inside a transaction

// ── Persistence ────────────────────────────────────────────────────────────

function persistToDisk(): void {
  if (!_db) return;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = _db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// ── Param normalisation ────────────────────────────────────────────────────
// better-sqlite3 accepts named objects whose keys have no sigil, e.g. {id: 1}
// for a query that uses @id.  sql.js requires the sigil on the key: {"@id": 1}.
// We add it here so callers don't need to change.

type RawParams = unknown[] | Record<string, unknown>;

function normalise(args: unknown[]): RawParams | undefined {
  if (args.length === 0) return undefined;

  // Single plain object → named params
  if (
    args.length === 1 &&
    args[0] !== null &&
    typeof args[0] === 'object' &&
    !Array.isArray(args[0])
  ) {
    const obj = args[0] as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[/^[@:$]/.test(k) ? k : `@${k}`] = v;
    }
    return out;
  }

  // Multiple positional args (or single primitive)
  return args;
}

// ── Statement wrapper ──────────────────────────────────────────────────────

class WrappedStatement {
  constructor(private rawDb: Database, private sql: string) {}

  run(...args: unknown[]): void {
    const params = normalise(args);
    this.rawDb.run(this.sql, params as BindParams);
    if (!_inTx) persistToDisk();
  }

  get(...args: unknown[]): unknown {
    const params = normalise(args);
    const stmt = this.rawDb.prepare(this.sql);
    if (params) stmt.bind(params as BindParams);
    const row = stmt.step() ? stmt.getAsObject() : undefined;
    stmt.free();
    return row;
  }

  all(...args: unknown[]): unknown[] {
    const params = normalise(args);
    const stmt = this.rawDb.prepare(this.sql);
    if (params) stmt.bind(params as BindParams);
    const rows: unknown[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

// ── DB wrapper ─────────────────────────────────────────────────────────────

export class WrappedDb {
  constructor(private rawDb: Database) {}

  prepare(sql: string): WrappedStatement {
    return new WrappedStatement(this.rawDb, sql);
  }

  /** Run one or more semicolon-separated statements (no result). */
  exec(sql: string): void {
    this.rawDb.run(sql);
    if (!_inTx) persistToDisk();
  }

  /** Wrap a function in a BEGIN/COMMIT transaction. */
  transaction<T>(fn: (arg: T) => void): (arg: T) => void {
    const rawDb = this.rawDb;
    return (arg: T) => {
      _inTx = true;
      rawDb.run('BEGIN');
      try {
        fn(arg);
        rawDb.run('COMMIT');
      } catch (e) {
        rawDb.run('ROLLBACK');
        throw e;
      } finally {
        _inTx = false;
      }
      persistToDisk();
    };
  }

  /** Ignored in sql.js (in-memory WAL irrelevant), kept for API compat. */
  pragma(_stmt: string): void { /* no-op */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Must be awaited once at startup before any getDb() calls. */
export async function initDb(): Promise<void> {
  _SQL = await initSqlJs({
    // Point to the WASM file shipped with sql.js
    locateFile: (file: string) =>
      path.join(path.dirname(require.resolve('sql.js')), file),
  });

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    _db = new _SQL.Database(buf);
  } else {
    _db = new _SQL.Database();
  }

  // Enable foreign keys
  _db.run('PRAGMA foreign_keys = ON');

  migrate();
  persistToDisk();   // ensure file exists immediately
}

export function getDb(): WrappedDb {
  if (!_db) throw new Error('Database not initialised — call initDb() first');
  return new WrappedDb(_db);
}

export function closeDb(): void {
  if (_db) {
    persistToDisk();
    _db.close();
    _db = null;
  }
}

// ── Migration ──────────────────────────────────────────────────────────────

function migrate(): void {
  if (!_db) return;

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf-8');

  // exec() runs all semicolon-separated statements in one pass.
  // All DDL uses IF NOT EXISTS so this is safe to call on every startup.
  _db.exec(schema);

  // Additive column migrations — SQLite throws if the column already exists,
  // so we catch and ignore that specific error.
  const addColumns = [
    `ALTER TABLE matches ADD COLUMN demo_status TEXT NOT NULL DEFAULT 'no_demo'`,
    `ALTER TABLE matches ADD COLUMN reservation_id TEXT`,
    `ALTER TABLE matches ADD COLUMN demo_url TEXT`,
    `ALTER TABLE matches ADD COLUMN ttd_ms_rifle REAL`,
    `ALTER TABLE matches ADD COLUMN ttd_ms_awp REAL`,
    `ALTER TABLE matches ADD COLUMN xhair_deg_rifle REAL`,
    `ALTER TABLE matches ADD COLUMN xhair_deg_awp REAL`,
    `ALTER TABLE matches ADD COLUMN spotted_acc REAL`,
    `ALTER TABLE matches ADD COLUMN aim_rating REAL`,
    `ALTER TABLE matches ADD COLUMN aim_sample_count INTEGER`,
  ];
  for (const sql of addColumns) {
    try { _db.run(sql); } catch { /* column already exists — expected */ }
  }

  // Migrate demo_status to the new status vocabulary and add demo_url column.
  // Detects whether migration is needed by checking for the new value 'parsed'
  // in the CHECK constraint — covers both very-old and intermediate schemas.
  const masterResult = _db.exec(`SELECT sql FROM sqlite_master WHERE type='table' AND name='matches'`);
  const currentSql = (masterResult[0]?.values?.[0]?.[0] as string) ?? '';
  if (!currentSql.includes("'parsed'")) {
    _db.run('PRAGMA foreign_keys = OFF');
    try {
      _db.run(`DROP TABLE IF EXISTS matches_bak`);
      _db.run(`ALTER TABLE matches RENAME TO matches_bak`);
      _db.run(`CREATE TABLE matches (
        match_id       TEXT PRIMARY KEY,
        share_code     TEXT NOT NULL DEFAULT '',
        reservation_id TEXT,
        map            TEXT NOT NULL,
        date          INTEGER NOT NULL,
        duration      INTEGER NOT NULL,
        result        TEXT NOT NULL CHECK(result IN ('W', 'L', 'T')),
        score_own     INTEGER NOT NULL,
        score_enemy   INTEGER NOT NULL,
        rounds_played INTEGER NOT NULL,
        kills         INTEGER NOT NULL DEFAULT 0,
        deaths        INTEGER NOT NULL DEFAULT 0,
        assists       INTEGER NOT NULL DEFAULT 0,
        hs_count      INTEGER NOT NULL DEFAULT 0,
        adr           REAL NOT NULL DEFAULT 0,
        mvps          INTEGER NOT NULL DEFAULT 0,
        ping          INTEGER NOT NULL DEFAULT 0,
        demo_status   TEXT NOT NULL DEFAULT 'no_demo'
          CHECK(demo_status IN ('queued','downloaded','parsed','corrupt','expired','no_demo')),
        demo_url          TEXT,
        ttd_ms_rifle      REAL,
        ttd_ms_awp        REAL,
        xhair_deg_rifle   REAL,
        xhair_deg_awp     REAL,
        spotted_acc       REAL,
        aim_rating        REAL,
        aim_sample_count  INTEGER
      )`);
      // Remap old status values; demo_url starts NULL (repopulated by next GCPD sync)
      _db.run(`
        INSERT INTO matches (
          match_id, share_code, reservation_id, map, date, duration, result,
          score_own, score_enemy, rounds_played, kills, deaths, assists,
          hs_count, adr, mvps, ping, demo_status,
          ttd_ms_rifle, ttd_ms_awp, xhair_deg_rifle, xhair_deg_awp,
          spotted_acc, aim_rating, aim_sample_count
        )
        SELECT
          match_id, share_code, reservation_id, map, date, duration, result,
          score_own, score_enemy, rounds_played, kills, deaths, assists,
          hs_count, adr, mvps, ping,
          CASE demo_status
            WHEN 'ok'          THEN 'parsed'
            WHEN 'gcpd_ok'     THEN 'queued'
            WHEN 'parse_error' THEN 'corrupt'
            WHEN 'server_gone' THEN 'expired'
            WHEN 'pending'     THEN 'no_demo'
            ELSE demo_status
          END,
          ttd_ms_rifle, ttd_ms_awp, xhair_deg_rifle, xhair_deg_awp,
          spotted_acc, aim_rating, aim_sample_count
        FROM matches_bak
      `);
      _db.run(`DROP TABLE matches_bak`);
    } finally {
      _db.run('PRAGMA foreign_keys = ON');
    }
  }
}
