import { Router, Request, Response } from 'express';
import { getDb } from '../../db/database';

const router = Router();

// GET /api/clutch — clutch stats from GSI data (Phase 2)
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();

  // Multi-kill frequency from match data
  // (Phase 2 will have per-round granularity; for now derive from matches)
  const clutchRows = db.prepare(`
    SELECT
      match_id,
      SUM(clutch_situation) AS clutch_attempts,
      SUM(clutch_won)       AS clutch_wins
    FROM gsi_rounds
    GROUP BY match_id
  `).all();

  const byRoundCount = db.prepare(`
    SELECT
      clutch_situation,
      COUNT(*)                              AS attempts,
      SUM(clutch_won)                       AS wins,
      ROUND(AVG(clutch_won) * 100, 1)       AS win_pct
    FROM gsi_rounds
    WHERE clutch_situation = 1
    GROUP BY clutch_won
  `).all();

  const ecoClutch = db.prepare(`
    SELECT
      buy_type,
      SUM(clutch_situation) AS attempts,
      SUM(clutch_won)       AS wins,
      CASE WHEN SUM(clutch_situation) > 0
        THEN ROUND(CAST(SUM(clutch_won) AS REAL) / SUM(clutch_situation) * 100, 1)
        ELSE 0
      END AS win_pct
    FROM gsi_rounds
    WHERE clutch_situation = 1
    GROUP BY buy_type
  `).all();

  res.json({ clutchRows, byRoundCount, ecoClutch });
});

export default router;
