import { Router, Request, Response } from 'express';
import { getDb } from '../../db/database';

const router = Router();

// GET /api/matches?limit=20&offset=0&map=de_dust2&from=<unix>&to=<unix>
router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const limit  = Math.min(parseInt(String(req.query.limit  ?? 50)), 200);
  const offset = parseInt(String(req.query.offset ?? 0));
  const map    = req.query.map as string | undefined;
  const from   = req.query.from ? parseInt(String(req.query.from)) : null;
  const to     = req.query.to   ? parseInt(String(req.query.to))   : null;

  let where = 'WHERE 1=1';
  const params: (string | number)[] = [];

  if (map)  { where += ' AND map = ?';  params.push(map); }
  if (from) { where += ' AND date >= ?'; params.push(from); }
  if (to)   { where += ' AND date <= ?'; params.push(to); }

  const rows = db.prepare(`
    SELECT * FROM matches ${where}
    ORDER BY date DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM matches ${where}`).get(...params) as { n: number }).n;

  res.json({ matches: rows, total, limit, offset });
});

// GET /api/matches/overview — KPI summary
router.get('/overview', (_req: Request, res: Response) => {
  const db = getDb();

  // total_matches counts all rows; stat aggregates only cover rows with real data (kills > 0)
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                                          AS total_matches,
      COALESCE(SUM(CASE WHEN result = 'W' AND kills > 0 THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN result = 'L' AND kills > 0 THEN 1 ELSE 0 END), 0) AS losses,
      COALESCE(SUM(CASE WHEN result = 'T' AND kills > 0 THEN 1 ELSE 0 END), 0) AS ties,
      ROUND(AVG(CASE WHEN kills > 0 THEN CAST(kills AS REAL) / NULLIF(deaths,0) END), 2) AS kd_ratio,
      ROUND(AVG(CASE WHEN kills > 0 THEN adr END), 1)                  AS avg_adr,
      ROUND(AVG(CASE WHEN kills > 0 THEN CAST(hs_count AS REAL) / NULLIF(kills,0) * 100 END), 1) AS hs_pct,
      COALESCE(SUM(CASE WHEN kills > 0 THEN kills END), 0)             AS total_kills,
      COALESCE(SUM(CASE WHEN kills > 0 THEN deaths END), 0)            AS total_deaths,
      COALESCE(SUM(CASE WHEN kills > 0 THEN mvps END), 0)              AS total_mvps,
      SUM(CASE WHEN kills > 0 THEN 1 ELSE 0 END)                       AS matches_with_stats,
      ROUND(AVG(CASE WHEN aim_rating IS NOT NULL THEN aim_rating END), 1) AS avg_aim_rating
    FROM matches
  `).get();

  // K/D + aim_rating trend — last 20 matches with real stats
  const trend = db.prepare(`
    SELECT date, ROUND(CAST(kills AS REAL) / NULLIF(deaths,0), 2) AS kd, map, result, aim_rating
    FROM matches
    WHERE kills > 0
    ORDER BY date DESC
    LIMIT 20
  `).all();

  res.json({ totals, trend: (trend as unknown[]).reverse() });
});

// GET /api/matches/maps — per-map breakdown
router.get('/maps', (_req: Request, res: Response) => {
  const db = getDb();

  const rows = db.prepare(`
    SELECT
      map,
      COUNT(*)                                               AS played,
      SUM(CASE WHEN result = 'W' THEN 1 ELSE 0 END)         AS wins,
      ROUND(AVG(CAST(kills AS REAL) / NULLIF(deaths,0)),2)   AS kd,
      ROUND(AVG(adr),1)                                      AS avg_adr,
      ROUND(AVG(CAST(hs_count AS REAL) / NULLIF(kills,0) * 100),1) AS hs_pct
    FROM matches
    WHERE map != 'unknown'
    GROUP BY map
    ORDER BY played DESC
  `).all();

  res.json(rows);
});

// GET /api/matches/:id
router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM matches WHERE match_id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  return res.json(row);
});

export default router;
