// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseEvent, parseTicks } = require('@laihoe/demoparser2');

const RIFLES = new Set([
  'ak47', 'm4a1', 'm4a1_silencer', 'sg556', 'aug', 'galilar', 'famas', 'g3sg1', 'scar20',
]);
const AWPS    = new Set(['awp', 'ssg08']);
const INCLUDED = new Set([...RIFLES, ...AWPS]);

export interface AimStats {
  ttd_ms_rifle:     number | null;
  ttd_ms_awp:       number | null;
  xhair_deg_rifle:  number | null;
  xhair_deg_awp:    number | null;
  spotted_acc:      number | null;
  aim_rating:       number | null;
  aim_sample_count: number;
}

function normaliseAngle(a: number): number {
  while (a > 180)  a -= 360;
  while (a < -180) a += 360;
  return a;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Normalise val from [lo, hi] → [0, 100], clamped. */
function clamp(val: number, lo: number, hi: number): number {
  return Math.max(0, Math.min(100, ((val - lo) / (hi - lo)) * 100));
}

/** Map val from [worst, best] → [0, 100] for lower-is-better metrics. */
function invert(val: number, worst: number, best: number): number {
  return ((worst - val) / (worst - best)) * 100;
}

/**
 * Extract TTD, crosshair placement, spotted accuracy, and composite aim rating
 * from an uncompressed .dem file.
 *
 * Returns null when fewer than 5 engagements are found (match too short,
 * player disconnected, etc.).
 *
 * @param demPath  absolute path to the uncompressed .dem file
 * @param steamId  player's SteamID64 string
 */
export function parseAimStats(demPath: string, steamId: string): AimStats | null {
  // ── Step 1: Build tick index ─────────────────────────────────────────────
  // @laihoe/demoparser2 parseTicks takes string steamIds (not BigInt).
  // Omit 'spotted' until we confirm its exact prop name from the diagnostic below.
  const tickRows: any[] = parseTicks(
    demPath,
    ['pitch', 'yaw', 'is_spotted'],
    [],
    [steamId],
  ) ?? [];
  console.log(`[aim] parseTicks returned ${tickRows.length} rows`);
  if (tickRows.length > 0) {
    console.log('[aim] tick row keys:', Object.keys(tickRows[0]));
    console.log('[aim] tick row sample:', JSON.stringify(tickRows[0]));
  }

  const eyeAngles  = new Map<number, { x: number; y: number }>();
  const spottedMap = new Map<number, boolean>();

  for (const row of tickRows) {
    const tick = row.tick as number;
    eyeAngles.set(tick, { x: row.pitch ?? 0, y: row.yaw ?? 0 });
    if (row.is_spotted !== undefined) spottedMap.set(tick, Boolean(row.is_spotted));
  }

  // If we have no spotted data, treat every tick as spotted so fire events aren't
  // all filtered out. Metrics will be slightly noisier but still meaningful.
  const hasSpottedData = spottedMap.size > 0;
  const isSpotted = (tick: number) => hasSpottedData ? spottedMap.get(tick) : true;

  // ── Step 2: Build engagement list ────────────────────────────────────────
  const fireEvents:  any[] = parseEvent(demPath, 'weapon_fire',  [], []) ?? [];
  const hurtEvents:  any[] = parseEvent(demPath, 'player_hurt',  [], []) ?? [];
  const deathEvents: any[] = parseEvent(demPath, 'player_death', [], []) ?? [];

  // weapon_fire uses user_steamid (the shooter), not attacker_steamid.
  // weapon field has a 'weapon_' prefix (e.g. 'weapon_ak47') — strip it before matching.
  const myFires = fireEvents
    .filter((e: any) => String(e.user_steamid) === steamId && INCLUDED.has((e.weapon ?? '').replace('weapon_', '')))
    .sort((a: any, b: any) => a.tick - b.tick);

  // Filter myHurts to INCLUDED weapons so grenade/molotov/pistol damage can't
  // match a rifle burst, and so FF from non-rifle weapons is excluded.
  // Rifle FF is still possible but rare enough to not skew a 15+ sample.
  const myHurts = hurtEvents
    .filter((e: any) => String(e.attacker_steamid) === steamId && INCLUDED.has((e.weapon ?? '').replace('weapon_', '')))
    .sort((a: any, b: any) => a.tick - b.tick);

  // ── Group fires into bursts (gap ≥ 128 ticks = 2 s at 64 Hz) ─────────────
  const BURST_GAP = 128;

  interface Burst {
    startTick:    number;
    lastFireTick: number;
    is_awp:       boolean;
  }

  const bursts: Burst[] = [];
  let cur: Burst | null = null;

  for (const fire of myFires) {
    if (!isSpotted(fire.tick)) continue; // skip blind spray / smokes
    if (!cur || (fire.tick - cur.lastFireTick) >= BURST_GAP) {
      if (cur) bursts.push(cur);
      cur = {
        startTick:    fire.tick,
        lastFireTick: fire.tick,
        is_awp:       AWPS.has(fire.weapon ?? ''),
      };
    } else {
      cur.lastFireTick = fire.tick;
    }
  }
  if (cur) bursts.push(cur);

  // Match each burst to its first hurt event within the burst window
  interface Engagement {
    startTick:    number;
    firstHitTick: number;
    is_awp:       boolean;
  }

  const engagements: Engagement[] = [];
  for (const burst of bursts) {
    const hit = myHurts.find(
      (h: any) => h.tick >= burst.startTick && h.tick <= burst.lastFireTick + BURST_GAP,
    );
    if (!hit) continue; // no hit — discard
    engagements.push({
      startTick:    burst.startTick,
      firstHitTick: hit.tick,
      is_awp:       burst.is_awp,
    });
  }

  console.log(`[aim] bursts=${bursts.length} engagements=${engagements.length}`);
  if (engagements.length < 5) return null;

  // ── Step 3: TTD ──────────────────────────────────────────────────────────
  const ttdRifle: number[] = [];
  const ttdAwp:   number[] = [];

  for (const eng of engagements) {
    const ms = ((eng.firstHitTick - eng.startTick) / 64) * 1000;
    if (ms > 1000) continue; // outlier cutoff (Leetify uses the same threshold)
    (eng.is_awp ? ttdAwp : ttdRifle).push(ms);
  }

  // ── Step 4: Crosshair placement ──────────────────────────────────────────
  const xhairRifle: number[] = [];
  const xhairAwp:   number[] = [];

  for (const eng of engagements) {
    const atSpot = eyeAngles.get(eng.startTick);
    const atHit  = eyeAngles.get(eng.firstHitTick);
    if (!atSpot || !atHit) continue;

    const dYaw   = Math.abs(normaliseAngle(atHit.y - atSpot.y));
    const dPitch = Math.abs(normaliseAngle(atHit.x - atSpot.x));
    const delta  = Math.sqrt(dYaw ** 2 + dPitch ** 2);
    (eng.is_awp ? xhairAwp : xhairRifle).push(delta);
  }

  // ── Step 5: Spotted accuracy ─────────────────────────────────────────────
  const shotsFiredSpotted = myFires.filter((e: any) => isSpotted(e.tick)).length;
  const hitsWhileSpotted  = myHurts.filter((e: any) => isSpotted(e.tick)).length;
  const spotted_acc = shotsFiredSpotted > 0 ? hitsWhileSpotted / shotsFiredSpotted : null;

  // HS accuracy (head kills / total kills) for aim rating composite
  let kills = 0, hsKills = 0;
  for (const e of deathEvents) {
    if (String(e.attacker_steamid) === steamId) { kills++; if (e.headshot) hsKills++; }
  }
  const hs_accuracy = kills > 0 ? hsKills / kills : null;

  // ── Step 6: Composite aim rating ─────────────────────────────────────────
  const ttd_ms_rifle    = median(ttdRifle);
  const ttd_ms_awp      = median(ttdAwp);
  const xhair_deg_rifle = median(xhairRifle);
  const xhair_deg_awp   = median(xhairAwp);

  let aim_rating: number | null = null;

  if (ttd_ms_rifle !== null && xhair_deg_rifle !== null && spotted_acc !== null) {
    // Reference ranges: worst → 0, best → 100
    const normCrosshair  = clamp(invert(xhair_deg_rifle, 15, 0),  0, 100); // 15°=0, 0°=100
    const normTTD        = clamp(invert(ttd_ms_rifle, 800, 100),  0, 100); // 800ms=0, 100ms=100
    const normSpottedAcc = clamp(spotted_acc * 100, 5, 60);                // 5%=0, 60%=100
    // Fall back to spotted_acc weight when HS data unavailable
    const normHSAcc = hs_accuracy !== null
      ? clamp(hs_accuracy * 100, 10, 70)   // 10%=0, 70%=100
      : normSpottedAcc;

    const raw = (
      normCrosshair  * 0.30 +
      normTTD        * 0.30 +
      normSpottedAcc * 0.25 +
      normHSAcc      * 0.15
    );
    aim_rating = Math.round(raw * 10) / 10;
  }

  const r1 = (v: number | null) => v !== null ? Math.round(v * 10) / 10 : null;

  return {
    ttd_ms_rifle:     ttd_ms_rifle    !== null ? Math.round(ttd_ms_rifle) : null,
    ttd_ms_awp:       ttd_ms_awp      !== null ? Math.round(ttd_ms_awp)   : null,
    xhair_deg_rifle:  r1(xhair_deg_rifle),
    xhair_deg_awp:    r1(xhair_deg_awp),
    spotted_acc:      spotted_acc !== null ? Math.round(spotted_acc * 1000) / 1000 : null,
    aim_rating,
    aim_sample_count: engagements.length,
  };
}
