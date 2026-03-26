import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { startQrLogin, getQrState, getSteamCookie, invalidateCookieCache } from '../../auth/steamAuth';
import { syncFromGcpd } from '../../sync/gcpdFetcher';
import { parseAllStubMatches } from '../../sync/parseDemos';

const router = Router();
const CONFIG_PATH = path.join(process.cwd(), 'config.json');

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

// GET /api/auth/check — does the config have a refresh token?
router.get('/check', (_req: Request, res: Response) => {
  const cfg = readConfig();
  res.json({ hasToken: !!(cfg.refreshToken) });
});

// POST /api/auth/start — begin QR login; returns the QR data URL immediately
router.post('/start', async (_req: Request, res: Response) => {
  try {
    const cfg = readConfig();
    await startQrLogin(async (refreshToken) => {
      console.log('[auth] Login complete — triggering GCPD sync with new session.');
      try {
        const cookie  = await getSteamCookie(refreshToken);
        const demoUrls = await syncFromGcpd(cookie, cfg.steamId);
        if (demoUrls.size > 0) await parseAllStubMatches(cfg.steamId, cookie, demoUrls);
      } catch (err) {
        console.error('[auth] Post-login sync failed:', err);
      }
    });
    res.json(getQrState());
  } catch (err) {
    res.status(500).json({ status: 'error', error: (err as Error).message });
  }
});

// GET /api/auth/status — poll for QR login state
router.get('/status', (_req: Request, res: Response) => {
  res.json(getQrState());
});

// DELETE /api/auth/logout — remove refresh token and clear cookie cache
router.delete('/logout', (_req: Request, res: Response) => {
  try {
    invalidateCookieCache();
    const cfg = readConfig();
    delete cfg.refreshToken;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
export default router;
