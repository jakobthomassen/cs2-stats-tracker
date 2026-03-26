import { Router, Request, Response } from 'express';
import { getLatestWeaponSnapshot, getWeaponDeltas } from '../../sync/weaponSnapshots';

const router = Router();

// GET /api/weapons — lifetime totals from latest snapshot
router.get('/', (_req: Request, res: Response) => {
  const snapshot = getLatestWeaponSnapshot();
  res.json(snapshot);
});

// GET /api/weapons/deltas — per-session deltas aggregated
router.get('/deltas', (_req: Request, res: Response) => {
  const deltas = getWeaponDeltas();
  res.json(deltas);
});

export default router;
