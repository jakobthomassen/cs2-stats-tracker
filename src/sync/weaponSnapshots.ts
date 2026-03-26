import { getDb } from '../db/database';
import { getUserStatsForGame } from './steamApi';

// CS2 weapon stat prefixes in the Steam API
// e.g. "total_kills_ak47", "total_shots_ak47", "total_hits_ak47", "total_kills_headshot_ak47"
const WEAPON_NAMES = [
  'ak47', 'aug', 'awp', 'bizon', 'cz75a', 'deagle', 'elite', 'famas',
  'fiveseven', 'g3sg1', 'galilar', 'glock', 'hkp2000', 'incgrenade',
  'knife', 'm249', 'm4a1', 'm4a4', 'mac10', 'mag7', 'molotov', 'mp5sd',
  'mp7', 'mp9', 'negev', 'nova', 'p250', 'p90', 'sawedoff', 'scar20',
  'sg556', 'ssg08', 'tec9', 'ump45', 'usp_silencer', 'xm1014',
];

interface WeaponStat {
  weapon: string;
  shots: number;
  hits: number;
  kills: number;
  hs: number;
}

/**
 * Snapshot current lifetime weapon stats from Steam API and store them.
 * Returns the number of weapons recorded.
 */
export async function snapshotWeaponStats(
  apiKey: string,
  steamId: string
): Promise<number> {
  const db = getDb();
  const syncTime = Math.floor(Date.now() / 1000);

  let stats: Awaited<ReturnType<typeof getUserStatsForGame>>;
  try {
    stats = await getUserStatsForGame(apiKey, steamId);
  } catch (err) {
    console.error('[sync] Failed to fetch weapon stats:', err);
    return 0;
  }

  const statMap = new Map<string, number>();
  for (const s of stats.stats) {
    statMap.set(s.name, s.value);
  }

  const insert = db.prepare(`
    INSERT INTO weapon_snapshots (sync_time, weapon, shots, hits, kills, hs)
    VALUES (@sync_time, @weapon, @shots, @hits, @kills, @hs)
  `);

  const insertMany = db.transaction((rows: WeaponStat[]) => {
    for (const row of rows) {
      insert.run({ sync_time: syncTime, ...row });
    }
  });

  const rows: WeaponStat[] = [];
  for (const weapon of WEAPON_NAMES) {
    const shots = statMap.get(`total_shots_${weapon}`) ?? 0;
    const hits  = statMap.get(`total_hits_${weapon}`) ?? 0;
    const kills = statMap.get(`total_kills_${weapon}`) ?? 0;
    const hs    = statMap.get(`total_kills_headshot_${weapon}`) ?? 0;

    // Skip weapons with zero activity
    if (shots === 0 && kills === 0) continue;

    rows.push({ weapon, shots, hits, kills, hs });
  }

  insertMany(rows);
  console.log(`[sync] Snapshotted ${rows.length} weapon stats at ${new Date(syncTime * 1000).toISOString()}`);
  return rows.length;
}

/**
 * Get the latest snapshot per weapon (lifetime totals).
 */
export function getLatestWeaponSnapshot(): WeaponStat[] {
  const db = getDb();
  return db.prepare(`
    SELECT weapon, shots, hits, kills, hs
    FROM weapon_snapshots
    WHERE snapshot_id IN (
      SELECT MAX(snapshot_id) FROM weapon_snapshots GROUP BY weapon
    )
    ORDER BY kills DESC
  `).all() as WeaponStat[];
}

/**
 * Get per-session weapon deltas (from the view).
 */
export function getWeaponDeltas(): unknown[] {
  const db = getDb();
  return db.prepare(`
    SELECT weapon,
      SUM(delta_shots) AS total_shots,
      SUM(delta_hits)  AS total_hits,
      SUM(delta_kills) AS total_kills,
      SUM(delta_hs)    AS total_hs,
      CASE WHEN SUM(delta_shots) > 0
        THEN ROUND(CAST(SUM(delta_hits) AS REAL) / SUM(delta_shots) * 100, 1)
        ELSE 0
      END AS accuracy_pct,
      CASE WHEN SUM(delta_kills) > 0
        THEN ROUND(CAST(SUM(delta_hs) AS REAL) / SUM(delta_kills) * 100, 1)
        ELSE 0
      END AS hs_pct
    FROM weapon_stats_delta
    GROUP BY weapon
    ORDER BY total_kills DESC
  `).all();
}
