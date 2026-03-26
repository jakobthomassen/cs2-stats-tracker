import { LoginSession, EAuthTokenPlatformType } from 'steam-session';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';

const CONFIG_PATH = path.join(process.cwd(), 'config.json');

// ── Cookie helpers ────────────────────────────────────────────────────────────

/**
 * getWebCookies() returns steamLoginSecure for every Steam domain (store, community,
 * help, checkout, etc.). We need only the one with audience "web:community" for
 * steamcommunity.com requests. Pair it with the first sessionid found.
 */
function extractCommunityLoginSecure(cookies: string[]): string {
  const nameValues = cookies.map(c => c.split(';')[0].trim());

  const communityToken = nameValues
    .filter(c => c.startsWith('steamLoginSecure='))
    .find(c => {
      try {
        const jwt = c.split('=').slice(1).join('=');
        const decoded = decodeURIComponent(jwt);
        const payload = decoded.split('||')[1];
        const parsed = JSON.parse(Buffer.from(payload.split('.')[1], 'base64').toString());
        return parsed.aud?.includes('web:community');
      } catch { return false; }
    });

  const sessionId = nameValues.find(c => c.startsWith('sessionid=')) ?? '';

  return [communityToken, sessionId].filter(Boolean).join('; ');
}

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

  // getWebCookies() returns cookies for ALL Steam domains (store, community, help, etc.)
  // with duplicate steamLoginSecure entries per domain. We need only the one whose
  // JWT audience is "web:community" for steamcommunity.com requests.
  _cachedCookie = extractCommunityLoginSecure(cookies);

  // Derive expiry from the JWT exp field inside steamLoginSecure so we don't
  // serve a cached cookie past its actual expiry.
  // steamLoginSecure value format: "<steamId>||<JWT header>.<payload>.<sig>"
  _cookieExpiry = Date.now() + 20 * 60 * 60 * 1000; // fallback: 20 h
  try {
    const secureValue = _cachedCookie.split('; ')
      .find(c => c.startsWith('steamLoginSecure='))
      ?.split('=').slice(1).join('=') ?? '';
    const jwtPart = decodeURIComponent(secureValue).split('||')[1] ?? '';
    const payloadB64 = jwtPart.split('.')[1] ?? '';
    if (payloadB64) {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
      if (typeof payload.exp === 'number') {
        _cookieExpiry = payload.exp * 1000;
        console.log(`[auth] JWT exp: ${new Date(_cookieExpiry).toISOString()}`);
      }
    }
  } catch { /* non-fatal — fallback TTL already set */ }
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

    Promise.resolve(onAuthenticated(refreshToken)).catch(err => {
      console.error('[auth] Post-login callback failed:', err);
    });
  });

  session.on('error', (err: Error) => {
    console.error('[auth] QR login error:', err.message);
    _qrState = { status: 'error', error: err.message };
    _activeSession = null;
  });
}
