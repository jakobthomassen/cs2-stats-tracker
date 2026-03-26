/**
 * GCPD Incremental Sync
 *
 * Walks Steam GCPD match history (newest-first) and inserts every match that
 * isn't already in the DB, stopping as soon as it finds a known reservation_id.
 *
 * On the first run this walks the full history. On subsequent runs it stops
 * after the first page once it hits existing data — naturally incremental.
 *
 * Endpoint:  GET /profiles/{steamId}/gcpd/730
 *              ?ajax=1 &tab=... &sessionid=... [&continue_token=...]
 * Response:  JSON { success, html, continue_token, continue_text }
 *
 * reservationId = first number in the .dem.bz2 filename (strip leading zeros).
 * match_id in the DB = reservationId (GCPD rows have no share code).
 *
 * PAGE_LIMIT is set to 2 for initial verification — raise once confirmed working.
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import { getDb } from '../db/database';
import { insertGcpdMatch } from './matchFetcher';

const TABS      = ['matchhistorypremier', 'matchhistorycomp'];
const PAGE_LIMIT = 2;  // ← raise after verifying correctness
const DEBUG_SINGLE_MATCH = true;  // ← set false after debugging

const HEADERS = {
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept':           'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language':  'en-US,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
};

// ── Parsed stats from one match block ─────────────────────────────────────────

interface MatchBlock {
  reservationId: string;
  downloadUrl:   string | null;  // only present for ~12 most recent matches
  map:           string;
  date:          number;         // unix timestamp
  duration:      number;         // seconds
  result:        'W' | 'L' | 'T';
  score_own:     number;
  score_enemy:   number;
  rounds_played: number;
  kills:         number;
  deaths:        number;
  assists:       number;
  hs_count:      number;         // Math.round(kills * hsp_pct / 100)
  mvps:          number;
  ping:          number;
}

// ── HTML parsing ───────────────────────────────────────────────────────────────

/**
 * Parse one match from its left + right panel elements.
 *
 * Structure (one <tr> per match inside the single .csgo_scoreboard_root wrapper):
 *   <td>  .csgo_scoreboard_inner_left   — map/date/duration/demo link
 *   <td>  .csgo_scoreboard_inner_right  — player rows + score divider
 *
 * Caller passes leftEl (.csgo_scoreboard_inner_left) and derives rightEl from it.
 */
function parseOneBlock(
  $: cheerio.CheerioAPI,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  leftEl: any,
  steamId: string,
): MatchBlock | null {
  // Sibling <td> contains the right panel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rightEl: any = $(leftEl).closest('td').next('td').find('.csgo_scoreboard_inner_right');

  // ── Demo URL & reservationId ──────────────────────────────────────────────
  const demoHref = $(leftEl).find('a[href*=".dem.bz2"]').first().attr('href') ?? null;
  let reservationId: string;

  if (demoHref) {
    const m = demoHref.match(/\/0*(\d+)_\d+\.dem\.bz2/);
    if (!m) return null;
    reservationId = String(BigInt(m[1]));
  } else {
    // No demo link — skip (can't identify the match without a reservationId)
    return null;
  }

  // ── Match metadata (left panel) ───────────────────────────────────────────
  const leftTds = $(leftEl)
    .find('td')
    .toArray()
    .map((td: any) => $(td).text().trim());

  const mapName     = (leftTds[0] ?? '').replace(/^Premier\s+/i, '').trim();
  const dateStr     = leftTds.find((t: string) => t.includes('GMT')) ?? '';
  const durationRaw = (leftTds.find((t: string) => t.startsWith('Match Duration:')) ?? '')
    .replace('Match Duration:', '').trim();

  const date = dateStr ? Math.floor(new Date(dateStr).getTime() / 1000) : 0;

  let duration = 0;
  if (durationRaw) {
    const [mm, ss] = durationRaw.split(':').map(Number);
    duration = (mm || 0) * 60 + (ss || 0);
  }

  // ── Player row & score (right panel) ─────────────────────────────────────
  const rows = $(rightEl).find('tr').toArray();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let playerRow: any = null;
  let playerRowIdx = -1;
  let scoreRowIdx  = -1;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows.forEach((row: any, idx: number) => {
    if ($(row).find('.csgo_scoreboard_score').length) scoreRowIdx = idx;
    if ($(row).find(`a[href*="${steamId}"]`).length) {
      playerRow    = row;
      playerRowIdx = idx;
    }
  });

  if (!playerRow || scoreRowIdx === -1) return null;

  const scoreText  = $(rows[scoreRowIdx]).find('.csgo_scoreboard_score').text().trim();
  const scoreMatch = scoreText.match(/(\d+)\s*:\s*(\d+)/);
  if (!scoreMatch) return null;

  const team1Score = parseInt(scoreMatch[1], 10);
  const team2Score = parseInt(scoreMatch[2], 10);
  const isTeam1    = playerRowIdx < scoreRowIdx;

  const score_own     = isTeam1 ? team1Score : team2Score;
  const score_enemy   = isTeam1 ? team2Score : team1Score;
  const rounds_played = team1Score + team2Score;
  const result: 'W' | 'L' | 'T' =
    score_own > score_enemy ? 'W' :
    score_own < score_enemy ? 'L' : 'T';

  // ── Player stat cells ─────────────────────────────────────────────────────
  // Columns: [0] name | [1] ping | [2] K | [3] A | [4] D | [5] ★ | [6] HSP | [7] score
  const cells = $(playerRow).find('td').toArray();

  const ping    = parseInt($(cells[1]).text().trim(), 10) || 0;
  const kills   = parseInt($(cells[2]).text().trim(), 10) || 0;
  const assists = parseInt($(cells[3]).text().trim(), 10) || 0;
  const deaths  = parseInt($(cells[4]).text().trim(), 10) || 0;

  const mvpCell = $(cells[5]).text().trim().replace(/\u00a0/g, '');
  const mvps    = mvpCell.includes('★')
    ? (parseInt(mvpCell.replace('★', '').trim(), 10) || 1)
    : 0;

  const hspPct   = parseFloat($(cells[6]).text().trim().replace('%', '')) || 0;
  const hs_count = Math.round(kills * hspPct / 100);

  return {
    reservationId,
    downloadUrl: demoHref,
    map: mapName,
    date,
    duration,
    result,
    score_own,
    score_enemy,
    rounds_played,
    kills,
    deaths,
    assists,
    hs_count,
    mvps,
    ping,
  };
}

// ── Per-page processing ───────────────────────────────────────────────────────

/**
 * Parse and insert all new match blocks from one HTML page.
 * @returns inserted count and whether we hit an already-known match.
 */
function processPage(
  db:       ReturnType<typeof getDb>,
  html:     string,
  steamId:  string,
  demoUrls: Map<string, string>,
): { inserted: number; done: boolean } {
  const $ = cheerio.load(html);
  let inserted = 0;
  let done     = false;

  // .csgo_scoreboard_root is a single wrapper for the whole page.
  // Each match is one <tr> containing an inner_left + inner_right pair.
  // Iterate over inner_left elements — one per match.
  $('.csgo_scoreboard_inner_left').each((_i, leftEl) => {
    if (done) return;

    const block = parseOneBlock($, leftEl, steamId);
    if (!block) return;

    // Stop if we've already seen this match
    const exists = db.prepare(
      `SELECT 1 FROM matches WHERE reservation_id = ? OR match_id = ?`
    ).get(block.reservationId, block.reservationId);

    if (exists) {
      done = true;
      return;
    }

    insertGcpdMatch(db, {
      match_id:      block.reservationId,
      reservation_id: block.reservationId,
      map:           block.map,
      date:          block.date,
      duration:      block.duration,
      result:        block.result,
      score_own:     block.score_own,
      score_enemy:   block.score_enemy,
      rounds_played: block.rounds_played,
      kills:         block.kills,
      deaths:        block.deaths,
      assists:       block.assists,
      hs_count:      block.hs_count,
      mvps:          block.mvps,
      ping:          block.ping,
    });

    if (block.downloadUrl) demoUrls.set(block.reservationId, block.downloadUrl);

    console.log(
      `[gcpd] + ${block.reservationId}` +
      ` | ${block.map}` +
      ` | ${block.result} ${block.score_own}:${block.score_enemy}` +
      ` | K${block.kills}/D${block.deaths}/A${block.assists}` +
      ` | ping ${block.ping}`,
    );

    inserted++;
    if (DEBUG_SINGLE_MATCH) { done = true; return; }  // DEBUG: one match only
  });

  return { inserted, done };
}

// ── Tab fetch loop ─────────────────────────────────────────────────────────────

async function syncTab(
  steamId:     string,
  tab:         string,
  cookieHeader: string,
  demoUrls:    Map<string, string>,
): Promise<number> {
  const db      = getDb();
  const baseUrl = `https://steamcommunity.com/profiles/${steamId}/gcpd/730`;
  const m       = cookieHeader.match(/sessionid=([^;]+)/);
  const sessionId = m ? m[1].trim() : '';

  let continueToken: string | null = null;
  let totalInserted = 0;

  for (let page = 0; page < PAGE_LIMIT; page++) {
    const params: Record<string, string> = { ajax: '1', tab, sessionid: sessionId };
    if (continueToken) params.continue_token = continueToken;

    let html: string;
    let nextToken: string | null = null;

    try {
      const res = await axios.get(baseUrl, {
        params,
        headers: { ...HEADERS, Cookie: cookieHeader },
        timeout: 30_000,
      });

      // Dump for debugging
      const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      fs.writeFileSync(`data/gcpd-debug-${tab}-page${page}.html`, raw);

      if (typeof res.data === 'object' && res.data !== null) {
        const d = res.data as Record<string, unknown>;
        html      = (d.html as string) ?? '';
        nextToken = d.continue_token != null ? String(d.continue_token) : null;
      } else {
        html = raw;
      }
    } catch (err) {
      console.warn(`[gcpd] Fetch failed (${tab} page ${page}): ${(err as Error).message}`);
      break;
    }

    const { inserted, done } = processPage(db, html, steamId, demoUrls);
    totalInserted += inserted;
    console.log(`[gcpd] ${tab} page ${page} — ${inserted} new match(es)${done ? ' (up to date)' : ''}`);

    if (done || !nextToken) break;
    continueToken = nextToken;
  }

  return totalInserted;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Sync all GCPD tabs, inserting new matches and stopping once existing data
 * is encountered (incremental, self-terminating).
 *
 * Returns a map of matchId → downloadUrl for matches that have a demo URL —
 * used by the optional ADR enrichment step in parseDemos.ts.
 */
export async function syncFromGcpd(
  cookieHeader: string,
  steamId:      string,
): Promise<Map<string, string>> {
  const demoUrls     = new Map<string, string>();
  let   totalInserted = 0;

  for (const tab of TABS) {
    const n = await syncTab(steamId, tab, cookieHeader, demoUrls);
    totalInserted += n;
  }

  console.log(`[gcpd] Sync complete — ${totalInserted} new match(es) inserted across ${TABS.length} tab(s).`);
  return demoUrls;
}
