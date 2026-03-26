import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { getDb } from '../../db/database';
import { getSteamCookie } from '../../auth/steamAuth';
import { syncFromGcpd } from '../../sync/gcpdFetcher';
import { parseAllDemos } from '../../sync/parseDemos';

const router = Router();
const CONFIG_PATH = path.join(process.cwd(), 'config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

// GET /api/sync/log — recent sync history
router.get('/log', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM sync_log ORDER BY timestamp DESC LIMIT 20
  `).all();
  res.json(rows);
});

// POST /api/sync/trigger — run GCPD sync on demand from the dashboard
router.post('/trigger', async (_req: Request, res: Response) => {
  const cfg = readConfig();

  if (!cfg.steamId || cfg.steamId === 'YOUR_STEAM_ID_64') {
    return res.status(400).json({ error: 'steamId not configured in config.json' });
  }

  // Resolve cookie — same priority as start.ts
  let cookie: string | undefined;
  if (cfg.steamSessionCookie) {
    cookie = cfg.steamSessionCookie;
  } else if (cfg.refreshToken) {
    try {
      cookie = await getSteamCookie(cfg.refreshToken);
    } catch (err) {
      console.warn('[sync/trigger] Token refresh failed:', (err as Error).message);
    }
  }

  if (!cookie) {
    return res.status(401).json({ error: 'Not authenticated — use the Login button first.' });
  }

  let newMatches = 0;
  let status: 'ok' | 'error' = 'ok';
  let errorMessage: string | undefined;

  try {
    newMatches = await syncFromGcpd(cookie, cfg.steamId);
    await parseAllDemos(cfg.steamId, cookie);
  } catch (err) {
    status = 'error';
    errorMessage = (err as Error).message;
    console.error('[sync/trigger] Sync error:', errorMessage);
  }

  // Log the triggered sync
  getDb().prepare(`
    INSERT INTO sync_log (timestamp, last_share_code, matches_fetched, status, error_message)
    VALUES (?, '', ?, ?, ?)
  `).run(Math.floor(Date.now() / 1000), newMatches, status, errorMessage ?? null);

  if (status === 'error') {
    return res.status(500).json({ error: errorMessage });
  }

  return res.json({ ok: true, newMatches });
});

export default router;
