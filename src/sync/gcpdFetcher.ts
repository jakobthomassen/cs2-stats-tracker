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
import path from 'path';
import { getDb } from '../db/database';
import { insertGcpdMatch } from './matchFetcher';

const TABS      = ['matchhistorypremier', 'matchhistorycomp'];
const PAGE_LIMIT = 100; // pages per tab — well above any realistic match history

const HEADERS = {
  'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept':           'application/json, text/javascript, */*; q=0.01',
  'Accept-Language':  'en-US,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
};

// ── Parsed stats from one match block ─────────────────────────────────────────

interface MatchBlock {
  matchId:       string;         // reservationId when demo link present; synthetic 'gcpd_<date>_<s1>_<s2>' otherwise
  reservationId: string | null;  // null when demo link has expired
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
  const demoHref     = $(leftEl).find('a[href*=".dem.bz2"]').first().attr('href') ?? null;
  let reservationId: string | null = null;

  if (demoHref) {
    const m = demoHref.match(/\/0*(\d+)_\d+\.dem\.bz2/);
    if (!m) return null;
    reservationId = String(BigInt(m[1]));
  }
  // If no demo link the match is too old for Valve's replay servers.
  // We still insert it using a synthetic match_id derived from date+score.
  // (Two 13:8 Ancient games are distinguishable because they start at different
  //  unix seconds; we add kills as a tiebreaker for the astronomically rare case.)

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

  const matchId = reservationId
    ?? `gcpd_${date}_${score_own}_${score_enemy}_${kills}`;

  return {
    matchId,
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
 * For existing matches that are still awaiting a demo, refreshes demo_url in DB.
 * @returns inserted count and whether we hit an already-known match.
 */
function processPage(
  db:      ReturnType<typeof getDb>,
  html:    string,
  steamId: string,
): { inserted: number; done: boolean; pageEntries: number } {
  const $ = cheerio.load(html);
  let inserted    = 0;
  let hitExisting = false;

  const leftPanels = $('.csgo_scoreboard_inner_left').toArray();

  for (const leftEl of leftPanels) {
    const block = parseOneBlock($, leftEl, steamId);
    if (!block) continue;

    type ExistingRow = { demo_status: string };
    const existing: ExistingRow | undefined = block.reservationId
      ? db.prepare(`SELECT demo_status FROM matches WHERE match_id = ? OR reservation_id = ?`)
           .get(block.matchId, block.reservationId) as ExistingRow | undefined
      : db.prepare(`SELECT demo_status FROM matches WHERE match_id = ? OR (date = ? AND map = ? AND score_own = ? AND score_enemy = ? AND kills = ?)`)
           .get(block.matchId, block.date, block.map, block.score_own, block.score_enemy, block.kills) as ExistingRow | undefined;

    if (existing) {
      // Refresh the stored demo_url for matches still waiting to be downloaded.
      // URLs rotate with each Steam session; keeping them current avoids stale-URL failures.
      if (['queued', 'corrupt'].includes(existing.demo_status)) {
        if (block.downloadUrl) {
          db.prepare(`UPDATE matches SET demo_url = ? WHERE match_id = ?`)
            .run(block.downloadUrl, block.matchId);
        } else {
          // Match visible on GCPD without a demo link — Valve has removed the replay.
          db.prepare(`UPDATE matches SET demo_status = 'expired', demo_url = NULL WHERE match_id = ?`)
            .run(block.matchId);
        }
      }
      hitExisting = true;
      continue;
    }

    insertGcpdMatch(db, {
      match_id:       block.matchId,
      reservation_id: block.reservationId,
      demo_url:       block.downloadUrl,
      map:            block.map,
      date:           block.date,
      duration:       block.duration,
      result:         block.result,
      score_own:      block.score_own,
      score_enemy:    block.score_enemy,
      rounds_played:  block.rounds_played,
      kills:          block.kills,
      deaths:         block.deaths,
      assists:        block.assists,
      hs_count:       block.hs_count,
      mvps:           block.mvps,
      ping:           block.ping,
    });

    console.log(
      `[gcpd] + ${block.matchId}` +
      ` | ${block.map}` +
      ` | ${block.result} ${block.score_own}:${block.score_enemy}` +
      ` | K${block.kills}/D${block.deaths}/A${block.assists}` +
      ` | ping ${block.ping}` +
      (block.downloadUrl ? ' | demo queued' : ''),
    );

    inserted++;
  }

  return { inserted, done: hitExisting, pageEntries: leftPanels.length };
}

// ── Tab fetch loop ─────────────────────────────────────────────────────────────

async function syncTab(
  steamId:      string,
  tab:          string,
  cookieHeader: string,
): Promise<number> {
  console.log('[gcpd] Raw cookieHeader being sent:', cookieHeader);
  const db      = getDb();
  const baseUrl = `https://steamcommunity.com/profiles/${steamId}/gcpd/730`;
  const sessionId = cookieHeader.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('sessionid='))
    ?.split('=')[1] ?? '';

  // Prime the session by visiting the GCPD page normally first.
  // Steam requires a normal page visit before AJAX requests will return JSON.
  try {
    await axios.get(`https://steamcommunity.com/profiles/${steamId}/gcpd/730`, {
      headers: { ...HEADERS, Cookie: cookieHeader },
      maxRedirects: 5,
      timeout: 15_000,
    });
    console.log('[gcpd] Session primed.');
  } catch (err) {
    console.warn('[gcpd] Primer request failed (continuing anyway):', (err as Error).message);
  }
  // Small delay to let Steam register the visit
  await new Promise(r => setTimeout(r, 1000));

  let continueToken:    string | null = null;
  let totalInserted     = 0;
  let consecutiveEmpty  = 0;
  const EMPTY_PAGE_CUTOFF = 3;

  for (let page = 0; page < PAGE_LIMIT; page++) {
    const params: Record<string, string> = { ajax: '1', tab, sessionid: sessionId };
    if (continueToken) params.continue_token = continueToken;

    let html: string;
    let nextToken: string | null = null;

    try {
      const res = await axios.get(baseUrl, {
        params,
        headers: { ...HEADERS, Cookie: cookieHeader, Referer: baseUrl },
        timeout: 30_000,
        maxRedirects: 0,
        validateStatus: (s) => s < 400 || s === 302,
      });

      // Log the actual URL axios ended up at
      console.log('[gcpd] Response URL:', res.request?.res?.responseUrl ?? res.config?.url);
      console.log('[gcpd] Status:', res.status);
      console.log('[gcpd] Redirect Location:', res.headers['location']);

      const raw = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      fs.writeFileSync(`data/gcpd-debug-${tab}-page${page}.html`, raw);

      if (page === 0) {
        const cookieNames = cookieHeader.split(';').map(c => c.trim().split('=')[0]).filter(Boolean).join(', ');
        console.log(`[gcpd] HTTP ${res.status} | response type: ${typeof res.data} | cookies present: ${cookieNames}`);
        if (typeof res.data === 'string') {
          console.log(`[gcpd] Response is plain HTML (expected JSON). First 300 chars:`);
          console.log(raw.slice(0, 300));
        }
      }

      if (res.status !== 200) {
        console.warn(`[gcpd] Non-200 response (${res.status}) on ${tab} page ${page} — stopping.`);
        break;
      }

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

    let inserted = 0, done = false, pageEntries = 0;
    try {
      ({ inserted, done, pageEntries } = processPage(db, html, steamId));
    } catch (err) {
      console.warn(`[gcpd] Error processing ${tab} page ${page}:`, err);
      break;
    }
    totalInserted += inserted;
    console.log(`[gcpd] ${tab} page ${page} — ${inserted} new match(es)${done ? ' (up to date)' : ''}`);

    if (page === 0 && pageEntries === 0 && !nextToken) {
      console.warn(`[gcpd] Warning: page 0 returned no entries and no continue token.`);
      console.warn(`[gcpd]   This usually means the Steam session cookie is expired.`);
      console.warn(`[gcpd]   Open the dashboard and use the Login button to re-authenticate.`);
    }

    if (pageEntries === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= EMPTY_PAGE_CUTOFF) break;
    } else {
      consecutiveEmpty = 0;
    }

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
 * Demo URLs are persisted directly to the matches table (demo_url column).
 * Returns the total number of newly inserted matches.
 */
export async function syncFromGcpd(
  cookieHeader: string,
  steamId:      string,
): Promise<number> {
  let totalInserted = 0;

  for (const tab of TABS) {
    totalInserted += await syncTab(steamId, tab, cookieHeader);
  }

  console.log(`[gcpd] Sync complete — ${totalInserted} new match(es) inserted across ${TABS.length} tab(s).`);

  // Keep debug dumps when nothing was inserted — lets you inspect the raw Steam response.
  // Delete them only on successful syncs to avoid stale files piling up.
  if (totalInserted > 0) {
    try {
      const dataDir = path.join(process.cwd(), 'data');
      for (const f of fs.readdirSync(dataDir).filter(n => n.startsWith('gcpd-debug-'))) {
        fs.unlinkSync(path.join(dataDir, f));
      }
    } catch { /* non-fatal */ }
  } else {
    console.log('[gcpd] Debug files preserved in data/ — inspect gcpd-debug-*.html to see the raw Steam response.');
  }

  return totalInserted;
}
