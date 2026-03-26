// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseEvent, parseTicks } = require('@laihoe/demoparser2');

/**
 * Stats extractable directly from the demo file.
 * map / date / duration / result / score are already populated by GCPD —
 * demos are only used for ADR enrichment (and exact K/D/A/HS as a bonus).
 */
export interface ParsedMatchStats {
  kills:         number;
  deaths:        number;
  assists:       number;
  hs_count:      number;
  adr:           number;
  mvps:          number;
  rounds_played: number;
}

/**
 * Parse per-player stats from an uncompressed .dem file on disk.
 * @param demoPath  absolute path to the uncompressed .dem file
 * @param steamId   player's SteamID64 string
 */
export function parseDemoStats(demoPath: string, steamId: string): ParsedMatchStats {
  // ── K / D / A / HS ─────────────────────────────────────────────────────────
  // attacker / victim / assister / headshot are built-in event fields.
  const deathEvents: any[] = parseEvent(demoPath, 'player_death', [], []) ?? [];

  let kills = 0, deaths = 0, assists = 0, hs_count = 0;
  for (const evt of deathEvents) {
    if (String(evt.attacker_steamid) === steamId) { kills++; if (evt.headshot) hs_count++; }
    if (String(evt.user_steamid)     === steamId) deaths++;
    if (evt.assister_steamid && String(evt.assister_steamid) === steamId) assists++;
  }

  // ── ADR ─────────────────────────────────────────────────────────────────────
  const hurtEvents: any[] = parseEvent(demoPath, 'player_hurt', [], []) ?? [];

  let totalDamage = 0;
  for (const evt of hurtEvents) {
    if (String(evt.attacker_steamid) === steamId) totalDamage += (evt.dmg_health ?? 0);
  }

  // ── MVPs ────────────────────────────────────────────────────────────────────
  const mvpEvents: any[] = parseEvent(demoPath, 'round_mvp', [], []) ?? [];
  const mvps = mvpEvents.filter((e: any) => String(e.user_steamid) === steamId).length;

  // ── Rounds played (for ADR denominator) ─────────────────────────────────────
  const roundEndEvents: any[] = parseEvent(demoPath, 'round_end', [], []) ?? [];
  const rounds_played = roundEndEvents.length;

  const adr = rounds_played > 0 ? Math.round(totalDamage / rounds_played) : 0;

  return { kills, deaths, assists, hs_count, adr, mvps, rounds_played };
}
