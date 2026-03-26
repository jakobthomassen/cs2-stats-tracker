import { getDb } from '../db/database';

export interface AppConfig {
  steamId:            string;
  port:               number;
  refreshToken?:      string;
  steamSessionCookie?: string;
  steamApiKey?:       string;   // optional — only needed for weapon-stats snapshot
}

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
  demo_status:    'pending' | 'ok' | 'expired' | 'server_gone' | 'parse_error' | 'gcpd_ok';
}

/**
 * Insert a new match row sourced from GCPD.
 * match_id = reservation_id (the first number in the demo filename).
 * share_code is left empty; adr starts at 0 (populated later via demo parsing).
 */
export function insertGcpdMatch(
  db: ReturnType<typeof getDb>,
  row: Omit<MatchRow, 'share_code' | 'adr' | 'demo_status'> & { reservation_id: string },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO matches
      (match_id, share_code, reservation_id, map, date, duration, result,
       score_own, score_enemy, rounds_played, kills, deaths,
       assists, hs_count, adr, mvps, ping, demo_status)
    VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?, 'gcpd_ok')
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
