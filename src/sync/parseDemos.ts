import fs from 'fs';
import path from 'path';
import { getDb } from '../db/database';
import { DemoStatus } from './matchFetcher';
import { downloadDemoBz2, decompressBz2ToDisk } from './demoDownloader';
import { parseDemoStats } from './demoParser';
import { parseAimStats } from './aimParser';
import { upsertMatchStats } from './matchFetcher';

const DEMO_CACHE_DIR = path.join(process.cwd(), 'data', 'demos');

function setDemoStatus(matchId: string, status: DemoStatus): void {
  upsertMatchStats(getDb(), { match_id: matchId, demo_status: status } as any);
}

/**
 * Process all demos that are pending in the DB.
 *
 * Queries matches with demo_status IN ('queued', 'downloaded', 'corrupt') and
 * either a known demo_url or an existing .bz2 file on disk.  For each match:
 *   queued     → download .bz2 → set 'downloaded' → decompress → parse → 'parsed'
 *   downloaded → .bz2 already on disk → decompress → parse → 'parsed'
 *   corrupt    → retry if URL still available, otherwise skip
 *
 * Status transitions on failure:
 *   404 / network error  → 'expired'
 *   decompress failure   → delete .bz2, retry download if URL available, else 'corrupt'
 *   parse failure        → 'corrupt'
 */
export async function parseAllDemos(
  steamId:      string,
  steamCookie?: string,
): Promise<void> {
  if (!fs.existsSync(DEMO_CACHE_DIR)) {
    fs.mkdirSync(DEMO_CACHE_DIR, { recursive: true });
  }

  const db = getDb();

  type DemoRow = { match_id: string; demo_url: string | null; demo_status: string };
  const pending = db.prepare(`
    SELECT match_id, demo_url, demo_status
    FROM matches
    WHERE demo_status IN ('queued', 'downloaded', 'corrupt')
    ORDER BY date DESC
  `).all() as DemoRow[];

  // Keep only rows we can actually process: has a URL or .bz2 already on disk
  const toProcess = pending.filter(r =>
    r.demo_url || fs.existsSync(path.join(DEMO_CACHE_DIR, `${r.match_id}.dem.bz2`))
  );

  if (toProcess.length === 0) {
    console.log('[demo] No demos pending — all up to date.');
    return;
  }

  const needsDownload = toProcess.some(r =>
    r.demo_url && !fs.existsSync(path.join(DEMO_CACHE_DIR, `${r.match_id}.dem.bz2`))
  );
  if (needsDownload && !steamCookie) {
    console.log(`[demo] ${toProcess.length} demo(s) pending — Steam login required to download.`);
    // Still fall through: 'downloaded' rows (bz2 on disk) can be parsed without a cookie.
  }

  console.log(`[demo] Processing ${toProcess.length} demo(s).`);

  for (const { match_id, demo_url } of toProcess) {
    // Re-read status in case a previous iteration updated it (shouldn't happen, but safe)
    const current = db.prepare(`SELECT demo_status FROM matches WHERE match_id = ?`)
      .get(match_id) as { demo_status: string } | undefined;
    if (current?.demo_status === 'parsed') continue;

    await processOne(match_id, demo_url ?? '', steamId, steamCookie ?? '');
  }

  console.log('[demo] Processing complete.');
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
    if (!demoUrl) return; // no file, no URL — nothing we can do
    try {
      await downloadDemoBz2(demoUrl, bz2Path, steamCookie, steamId);
      setDemoStatus(matchId, 'downloaded');
    } catch (err) {
      const status = (err as any)?.response?.status as number | undefined;
      const isNetworkGone = (err as Error).message?.includes('ENOTFOUND');
      const msg = status ? `HTTP ${status}` : (err as Error).message;
      console.error(`[demo] Download failed for ${matchId}: ${msg}`);
      setDemoStatus(matchId, 'expired');
      return;
    }
  } else {
    console.log(`[demo] Using cached demo: ${matchId}`);
  }

  // ── Decompress ────────────────────────────────────────────────────────────
  const demPath = bz2Path.replace('.dem.bz2', '.dem');
  try {
    await decompressBz2ToDisk(bz2Path, demPath);
  } catch (err) {
    console.error(`[demo] Decompression failed for ${matchId}:`, err);
    fs.unlinkSync(bz2Path);
    // Corrupt/partial .bz2 — retry download immediately if URL available
    if (demoUrl) {
      console.log(`[demo] Retrying download for ${matchId}…`);
      try {
        await downloadDemoBz2(demoUrl, bz2Path, steamCookie, steamId);
        setDemoStatus(matchId, 'downloaded');
        await decompressBz2ToDisk(bz2Path, demPath);
      } catch (retryErr) {
        console.error(`[demo] Retry failed for ${matchId}:`, retryErr);
        if (fs.existsSync(bz2Path)) fs.unlinkSync(bz2Path);
        setDemoStatus(matchId, 'corrupt');
        return;
      }
    } else {
      setDemoStatus(matchId, 'corrupt');
      return;
    }
  }

  // ── Parse ─────────────────────────────────────────────────────────────────
  try {
    console.log(`[demo] Parsing: ${matchId}`);
    const stats    = parseDemoStats(demPath, steamId);
    const aimStats = parseAimStats(demPath, steamId);

    // GCPD is authoritative for K/D/A/HS/MVPs — demo only contributes ADR + aim.
    upsertMatchStats(getDb(), {
      match_id:    matchId,
      adr:         stats.adr,
      demo_status: 'parsed' as DemoStatus,
      ...(aimStats ?? {}),
    } as any);

    console.log(
      `[demo] ✓ ${matchId}` +
      ` | ADR ${stats.adr}` +
      (aimStats ? ` | Aim ${aimStats.aim_rating ?? '—'} (n=${aimStats.aim_sample_count})` : ' | Aim —')
    );
  } catch (err) {
    console.error(`[demo] Parse error for ${matchId}:`, err);
    setDemoStatus(matchId, 'corrupt');
  } finally {
    if (fs.existsSync(demPath)) fs.unlinkSync(demPath);
    if (fs.existsSync(bz2Path)) fs.unlinkSync(bz2Path);
  }
}
