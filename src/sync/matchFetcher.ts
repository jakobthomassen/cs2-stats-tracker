import { getDb } from '../db/database';

export interface AppConfig {
  steamId:            string;
  port:               number;
  refreshToken?:      string;
  steamSessionCookie?: string;
  steamApiKey?:       string;   // optional — only needed for weapon-stats snapshot
}

export type DemoStatus = 'queued' | 'downloaded' | 'parsed' | 'corrupt' | 'expired' | 'no_demo';

export interface MatchRow {
  match_id:       string;
  share_code:     string;
  reservation_id?: string;
  map:            string;
  date:           number;
  duration:       number;
  result:         'W' | 'L' | 'T';
  score_own:      number;
  score_enemy:    number;
  rounds_played:  number;
  kills:          number;
  deaths:         number;
  assists:        number;
  hs_count:       number;
  adr:            number;
  mvps:           number;
  ping:           number;
  demo_status:    DemoStatus;
  demo_url?:      string | null;
  ttd_ms_rifle?:     number | null;
  ttd_ms_awp?:       number | null;
  xhair_deg_rifle?:  number | null;
  xhair_deg_awp?:    number | null;
  spotted_acc?:      number | null;
  aim_rating?:       number | null;
  aim_sample_count?: number | null;
}

/**
 * Insert a new match row sourced from GCPD.
 * match_id = reservation_id (the first number in the demo filename).
 * share_code is left empty; adr starts at 0 (populated later via demo parsing).
 * demo_status is set to 'queued' when a download URL is available, 'no_demo' otherwise.
 */
export function insertGcpdMatch(
  db: ReturnType<typeof getDb>,
  row: Omit<MatchRow, 'share_code' | 'adr' | 'demo_status' | 'reservation_id'> & {
    reservation_id: string | null;
    demo_url:       string | null;
  },
): void {
  const demoStatus: DemoStatus = row.demo_url ? 'queued' : 'no_demo';
  db.prepare(`
    INSERT OR IGNORE INTO matches
      (match_id, share_code, reservation_id, map, date, duration, result,
       score_own, score_enemy, rounds_played, kills, deaths,
       assists, hs_count, adr, mvps, ping, demo_status, demo_url)
    VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?, ?, ?)
  `).run(
    row.match_id,
    row.reservation_id,
    row.map,
    row.date,
    row.duration,
    row.result,
    row.score_own,
    row.score_enemy,
    row.rounds_played,
    row.kills,
    row.deaths,
    row.assists,
    row.hs_count,
    row.mvps,
    row.ping,
    demoStatus,
    row.demo_url,
  );
}

/**
 * Update match stats for a given matchId.
 * Called when stats become available from demo parsing or GCPD enrichment.
 */
export function upsertMatchStats(
  db: ReturnType<typeof getDb>,
  row: Partial<MatchRow> & { match_id: string },
): void {
  const fields = Object.keys(row).filter(k => k !== 'match_id');
  if (fields.length === 0) return;

  const setClause = fields.map(f => `${f} = @${f}`).join(', ');
  db.prepare(`UPDATE matches SET ${setClause} WHERE match_id = @match_id`).run(row);
}
