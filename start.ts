/**
 * CS2 Stats Tracker — entry point
 * 1. Load config
 * 2. Init DB
 * 3. Refresh Steam session cookie (QR or stored refreshToken)
 * 4. Sync from GCPD → insert new matches with full scoreboard stats
 * 5. Download demos for ADR enrichment (optional — recent matches only)
 * 6. Weapon stats snapshot (optional — requires steamApiKey)
 * 7. Start Express server + open dashboard
 */

import fs from 'fs';
import path from 'path';
import open from 'open';
import { initDb, getDb, closeDb } from './src/db/database';
import { AppConfig } from './src/sync/matchFetcher';
import { syncFromGcpd } from './src/sync/gcpdFetcher';
import { snapshotWeaponStats } from './src/sync/weaponSnapshots';
import { parseAllDemos } from './src/sync/parseDemos';
import { getSteamCookie } from './src/auth/steamAuth';
import { createServer } from './src/server/index';
import gsiRouter from './src/gsi/listener';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('[start] config.json not found. Copy config.example.json and fill in your steamId.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as AppConfig;
}

function isConfigured(cfg: AppConfig): boolean {
  return !!(cfg.steamId && cfg.steamId !== 'YOUR_STEAM_ID_64');
}

async function resolveCookie(cfg: AppConfig): Promise<string | undefined> {
  // 1. Manual cookie in config takes priority (pasted from DevTools)
  if (cfg.steamSessionCookie) {
    console.log('[start] Using steamSessionCookie from config.');
    return cfg.steamSessionCookie;
  }
  // 2. Auto-refresh via stored refresh token
  if (cfg.refreshToken) {
    try {
      return await getSteamCookie(cfg.refreshToken);
    } catch (err) {
      console.warn('[start] Steam token refresh failed:', (err as Error).message);
      console.warn('        Open the dashboard and use the Login button to re-authenticate.');
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  console.log('╔══════════════════════════════╗');
  console.log('║    CS2 Personal Stats Tracker  ║');
  console.log('╚══════════════════════════════╝');

  const cfg  = loadConfig();
  const port = cfg.port ?? 3000;

  // ── DB ────────────────────────────────────────────────────────────────────
  console.log('[start] Initialising database…');
  await initDb();

  if (!isConfigured(cfg)) {
    console.log('\n[start] config.json has placeholder steamId — skipping sync.');
    console.log('        Set steamId to your SteamID64 and restart.\n');
  } else {
    // ── Steam session ─────────────────────────────────────────────────────
    const steamCookie = await resolveCookie(cfg);

    if (!steamCookie) {
      console.log('[start] No Steam session — open the dashboard and use the Login button.');
    } else {
      // ── GCPD sync ───────────────────────────────────────────────────────
      console.log('\n[start] Syncing match history from GCPD…');
      let matchesFetched = 0;
      let syncStatus: 'ok' | 'error' = 'ok';
      let syncError: string | undefined;

      try {
        matchesFetched = await syncFromGcpd(steamCookie, cfg.steamId);
      } catch (err) {
        syncStatus = 'error';
        syncError  = (err instanceof Error) ? err.message : String(err);
        console.error('[start] GCPD sync error:', err);
      }

      // Write sync log
      getDb().prepare(`
        INSERT INTO sync_log (timestamp, last_share_code, matches_fetched, status, error_message)
        VALUES (?, '', ?, ?, ?)
      `).run(Math.floor(Date.now() / 1000), matchesFetched, syncStatus, syncError ?? null);

      // ── Demo processing ────────────────────────────────────────────────
      // Queries DB directly — handles new queued demos, cached .bz2 files,
      // and any matches left interrupted from a previous run.
      console.log('\n[start] Processing demos…');
      await parseAllDemos(cfg.steamId, steamCookie);

      // ── Weapon stats (optional) ────────────────────────────────────────
      if (cfg.steamApiKey) {
        console.log('\n[start] Snapshotting weapon stats…');
        await snapshotWeaponStats(cfg.steamApiKey, cfg.steamId);
      }
    }
  }

  // ── Server ────────────────────────────────────────────────────────────────
  const app = createServer();

  if (process.env.GSI_ENABLED === '1') {
    app.use('/gsi', gsiRouter);
    console.log('[start] GSI listener active on /gsi');
  }

  app.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(`\n[start] Dashboard running at ${url}`);
    open(url).catch(() => console.log(`        (Visit ${url} manually)`));
  });

  process.on('SIGINT', () => {
    console.log('\n[start] Shutting down…');
    closeDb();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[start] Fatal error:', err);
  process.exit(1);
});
