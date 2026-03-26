import axios from 'axios';

const STEAM_API_BASE = 'https://api.steampowered.com';

export interface NextShareCodeResponse {
  nextcode: string;
}

export interface UserStatsForGame {
  steamID: string;
  gameName: string;
  stats: Array<{ name: string; value: number }>;
  achievements: Array<{ name: string; achieved: number }>;
}

/**
 * Walk one step in the share code chain.
 * Returns null when Steam says "no new match" (HTTP 202 or specific body).
 */
export async function getNextMatchSharingCode(
  apiKey: string,
  steamId: string,
  authCode: string,
  knownCode: string
): Promise<string | null> {
  const url = `${STEAM_API_BASE}/ICSGOPlayers_730/GetNextMatchSharingCode/v1`;

  try {
    const res = await axios.get(url, {
      params: {
        key: apiKey,
        steamid: steamId,
        steamidkey: authCode,
        knowncode: knownCode,
      },
      // Steam returns 202 when there is no next match — don't throw
      validateStatus: (status) => status === 200 || status === 202,
      timeout: 10_000,
    });

    if (res.status === 202 || !res.data?.result?.nextcode) {
      return null;
    }

    const next: string = res.data.result.nextcode;
    // Steam returns "n/a" when there is no next code
    if (next === 'n/a' || next === '') return null;

    return next;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GetNextMatchSharingCode failed: ${msg}`);
  }
}

/**
 * Fetch lifetime weapon stats for the given Steam user in CS2 (appId 730).
 */
export async function getUserStatsForGame(
  apiKey: string,
  steamId: string
): Promise<UserStatsForGame> {
  const url = `${STEAM_API_BASE}/ISteamUserStats/GetUserStatsForGame/v2`;

  try {
    const res = await axios.get(url, {
      params: {
        key: apiKey,
        steamid: steamId,
        appid: 730,
      },
      timeout: 10_000,
    });

    if (!res.data?.playerstats) {
      throw new Error('No playerstats in response');
    }

    return res.data.playerstats as UserStatsForGame;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`GetUserStatsForGame failed: ${msg}`);
  }
}
