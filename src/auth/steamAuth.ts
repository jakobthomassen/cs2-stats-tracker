import { LoginSession, EAuthTokenPlatformType } from 'steam-session';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

// ── Cookie cache (in-memory, ~20h TTL) ───────────────────────────────────────

let _cachedCookie: string | null = null;
let _cookieExpiry = 0;

/**
 * Exchange a stored refresh token for a fresh steamLoginSecure cookie.
 * Result is cached in memory; call again after expiry or on auth error.
 */
export async function getSteamCookie(refreshToken: string): Promise<string> {
  if (_cachedCookie && Date.now() < _cookieExpiry - 5 * 60 * 1000) {
    return _cachedCookie;
  }

  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  session.refreshToken = refreshToken;
  const cookies = await session.getWebCookies();

  _cachedCookie = cookies.join('; ');
  _cookieExpiry = Date.now() + 20 * 60 * 60 * 1000; // 20 h
  console.log('[auth] Steam web cookies refreshed.');
  return _cachedCookie;
}

export function invalidateCookieCache(): void {
  _cachedCookie = null;
  _cookieExpiry = 0;
}

// ── QR login flow ─────────────────────────────────────────────────────────────

export type QrStatus = 'idle' | 'pending' | 'ok' | 'error';

interface QrState {
  status: QrStatus;
  qrDataUrl?: string;
  error?: string;
}

let _qrState: QrState = { status: 'idle' };
let _activeSession: LoginSession | null = null;

export function getQrState(): QrState {
  return { ..._qrState };
}

/**
 * Start a QR-code login session.
 * Resolves once the QR image is ready; the `onAuthenticated` callback fires later
 * when the user scans and approves on their phone.
 */
export async function startQrLogin(
  onAuthenticated: (refreshToken: string) => void
): Promise<void> {
  // Cancel any existing in-progress session
  if (_activeSession) {
    try { _activeSession.cancelLoginAttempt(); } catch { /* ignore */ }
    _activeSession = null;
  }

  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
  _activeSession = session;
  _qrState = { status: 'pending' };

  const startResult = await session.startWithQR();
  const challengeUrl = startResult.qrChallengeUrl ?? '';
  const qrDataUrl = await QRCode.toDataURL(challengeUrl, { width: 240 });
  _qrState = { status: 'pending', qrDataUrl };

  session.on('authenticated', async () => {
    const refreshToken = session.refreshToken!;
    _qrState = { status: 'ok' };
    _activeSession = null;
    invalidateCookieCache();

    // Persist refresh token
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      cfg.refreshToken = refreshToken;
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
      console.log('[auth] Refresh token saved to config.json.');
    } catch (err) {
      console.error('[auth] Could not save refresh token:', err);
    }

    onAuthenticated(refreshToken);
  });

  session.on('error', (err: Error) => {
    console.error('[auth] QR login error:', err.message);
    _qrState = { status: 'error', error: err.message };
    _activeSession = null;
  });
}
