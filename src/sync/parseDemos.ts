import fs from 'fs';
import path from 'path';
import { getDb } from '../db/database';
import { downloadDemoBz2, decompressBz2ToDisk } from './demoDownloader';
import { parseDemoStats } from './demoParser';
import { upsertMatchStats } from './matchFetcher';

const DEMO_CACHE_DIR = path.join(process.cwd(), 'data', 'demos');

type DemoStatus = 'pending' | 'ok' | 'expired' | 'server_gone' | 'parse_error' | 'gcpd_ok';

function setDemoStatus(matchId: string, status: DemoStatus): void {
  upsertMatchStats(getDb(), { match_id: matchId, demo_status: status } as any);
}

/**
 * Download and parse demos for ADR enrichment.
 *
 * Only processes matches that have a demo URL in gcpdUrls (supplied by
 * syncFromGcpd). Rows with demo_status='ok' are skipped — they're already
 * fully parsed.
 *
 * For gcpd_ok rows: updates ADR and sets demo_status='ok'.
 * For any legacy pending/expired rows that also have a URL: same.
 *
 * @param steamId   - player's SteamID64 (used for Referer header)
 * @param steamCookie - full cookie string from steam-session
 * @param gcpdUrls  - matchId → downloadUrl, returned by syncFromGcpd
 */
export async function parseAllStubMatches(
  steamId:     string,
  steamCookie?: string,
  gcpdUrls?:   Map<string, string>,
): Promise<void> {
  if (!steamCookie || !gcpdUrls || gcpdUrls.size === 0) {
    if (!steamCookie && gcpdUrls && gcpdUrls.size > 0) {
      console.log(`[demo] ${gcpdUrls.size} demo(s) ready — Steam login required to download for ADR stats.`);
    }
    return;
  }

  const db = getDb();

  if (!fs.existsSync(DEMO_CACHE_DIR)) {
    fs.mkdirSync(DEMO_CACHE_DIR, { recursive: true });
  }

  console.log(`[demo] ${gcpdUrls.size} demo(s) available for ADR enrichment.`);

  const urlEntries = Array.from(gcpdUrls.entries()).slice(0, 1);  // DEBUG: one demo only
  for (const [matchId, demoUrl] of urlEntries) {
    // Skip rows already fully parsed
    const row = db.prepare(`SELECT demo_status FROM matches WHERE match_id = ?`).get(matchId) as
      { demo_status: string } | undefined;
    if (row?.demo_status === 'ok') {
      console.log(`[demo] ${matchId} already parsed — skipping.`);
      continue;
    }

    await processOne(matchId, demoUrl, steamId, steamCookie);
  }

  console.log('[demo] ADR enrichment pass complete.');
}

async function processOne(
  matchId:     string,
  demoUrl:     string,
  steamId:     string,
  steamCookie: string,
): Promise<void> {
  const bz2Path = path.join(DEMO_CACHE_DIR, `${matchId}.dem.bz2`);

  // ── Download ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(bz2Path)) {
    try {
      await downloadDemoBz2(demoUrl, bz2Path, steamCookie, steamId);
    } catch (err) {
      const status = (err as any)?.response?.status as number | undefined;
      const isNetworkGone = (err as Error).message?.includes('ENOTFOUND');
      const msg = status ? `HTTP ${status}` : (err as Error).message;
      console.error(`[demo] Download failed for ${matchId}: ${msg}`);

      if (isNetworkGone) {
        setDemoStatus(matchId, 'server_gone');
      } else if (status && status >= 400) {
        setDemoStatus(matchId, 'expired');
      }
      return;
    }
  } else {
    console.log(`[demo] Using cached demo: ${matchId}`);
  }

  // ── Decompress to disk ────────────────────────────────────────────────────
  // @laihoe/demoparser2 requires a file path — writing to disk also avoids
  // loading 280–320 MB into a single in-memory buffer.
  const demPath = bz2Path.replace('.dem.bz2', '.dem');
  try {
    await decompressBz2ToDisk(bz2Path, demPath);
  } catch (err) {
    console.error(`[demo] Decompression failed for ${matchId}:`, err);
    fs.unlinkSync(bz2Path);
    return;
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  try {
    console.log(`[demo] Parsing stats: ${matchId}`);
    const stats = parseDemoStats(demPath, steamId);

    // Only upsert fields the demo provides — GCPD fields (map, date, result,
    // score, ping) are already set and should not be overwritten.
    upsertMatchStats(getDb(), {
      match_id:      matchId,
      kills:         stats.kills,
      deaths:        stats.deaths,
      assists:       stats.assists,
      hs_count:      stats.hs_count,
      adr:           stats.adr,
      mvps:          stats.mvps,
      rounds_played: stats.rounds_played,
      demo_status:   'ok',
    } as any);

    console.log(
      `[demo] ✓ ${matchId}` +
      ` | K${stats.kills}/D${stats.deaths}/A${stats.assists}` +
      ` | ADR ${stats.adr}` +
      ` | HS ${stats.hs_count}` +
      ` | MVPs ${stats.mvps}`
    );
  } catch (err) {
    console.error(`[demo] Parse error for ${matchId}:`, err);
    setDemoStatus(matchId, 'parse_error');
  } finally {
    // Always remove the uncompressed .dem — it's large and not needed after parsing.
    // The .bz2 is kept as a cache so re-parsing doesn't require a re-download.
    if (fs.existsSync(demPath)) fs.unlinkSync(demPath);
  }
}
