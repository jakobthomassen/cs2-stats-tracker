/**
 * Phase 2 — CS2 Game State Integration listener
 *
 * CS2 POSTs JSON payloads to this endpoint while a match is in progress.
 * Drop the cfg file into your CS2 cfg/ folder (see instructions below)
 * then run with GSI_ENABLED=1 npm start to activate.
 *
 * GSI cfg location (Windows):
 *   C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\gamestate_integration_cs2tracker.cfg
 *
 * cfg contents:
 *   "CS2 Tracker"
 *   {
 *     "uri"           "http://127.0.0.1:3000/gsi"
 *     "timeout"       "5.0"
 *     "buffer"        "0.1"
 *     "throttle"      "0.5"
 *     "heartbeat"     "10.0"
 *     "data"
 *     {
 *       "provider"            "1"
 *       "map"                 "1"
 *       "round"               "1"
 *       "player_id"           "1"
 *       "player_state"        "1"
 *       "player_weapons"      "1"
 *       "player_match_stats"  "1"
 *       "allplayers_id"       "0"
 *     }
 *   }
 */

import { Request, Response, Router } from 'express';
import { getDb } from '../db/database';

const router = Router();

interface GsiPayload {
  provider?: { steamid?: string };
  map?: {
    name?: string;
    phase?: string;       // "warmup" | "live" | "gameover"
    round?: number;
    team_ct?: { score?: number };
    team_t?: { score?: number };
  };
  round?: {
    phase?: string;       // "freezetime" | "live" | "over"
    win_team?: string;
  };
  player?: {
    steamid?: string;
    state?: {
      health?: number;
      money?: number;
      equip_value?: number;
      round_kills?: number;
      round_killhs?: number;
    };
    match_stats?: {
      kills?: number;
      deaths?: number;
      assists?: number;
      mvps?: number;
      score?: number;
    };
    activity?: string;
  };
  previously?: Record<string, unknown>;
}

// Tracks state across GSI events for the current round
interface RoundState {
  matchId: string | null;
  roundNumber: number;
  side: 'CT' | 'T' | null;
  startMoney: number;
  spend: number;
  buyType: 'eco' | 'force' | 'full' | 'pistol' | 'unknown';
  killsThisRound: number;
  died: boolean;
  clutchSituation: boolean;
  clutchWon: boolean;
  roundPhase: string;
  mapName: string | null;
}

let state: RoundState = resetState();

function resetState(): RoundState {
  return {
    matchId: null,
    roundNumber: 0,
    side: null,
    startMoney: 0,
    spend: 0,
    buyType: 'unknown',
    killsThisRound: 0,
    died: false,
    clutchSituation: false,
    clutchWon: false,
    roundPhase: '',
    mapName: null,
  };
}

function classifyBuyType(spend: number, round: number): 'pistol' | 'eco' | 'force' | 'full' {
  if (round === 1 || round === 16) return 'pistol';
  if (spend < 1000) return 'eco';
  if (spend < 3500) return 'force';
  return 'full';
}

router.post('/', (req: Request, res: Response) => {
  const payload = req.body as GsiPayload;

  const mapPhase  = payload.map?.phase;
  const roundNum  = payload.map?.round ?? 0;
  const roundPhase = payload.round?.phase ?? '';

  // Ignore warmup and non-live states
  if (mapPhase === 'warmup' || !mapPhase) {
    return res.sendStatus(200);
  }

  const mapName = payload.map?.name ?? null;
  const playerSteamId = payload.player?.steamid;
  if (!playerSteamId) return res.sendStatus(200);

  // Derive side from map team scores (heuristic: track CT/T via map.team_ct)
  // The GSI doesn't directly say which team the local player is on in all versions.
  // We infer it from round kills + player state in Phase 2 full implementation.
  // For now, record what we can.

  const equipValue = payload.player?.state?.equip_value ?? 0;
  const health     = payload.player?.state?.health ?? 100;
  const roundKills = payload.player?.state?.round_kills ?? 0;

  // New round: freezetime started
  if (roundPhase === 'freezetime' && roundNum !== state.roundNumber) {
    // Commit previous round if it was live
    if (state.roundNumber > 0 && state.mapName && state.matchId) {
      commitRound();
    }

    state = resetState();
    state.roundNumber = roundNum;
    state.mapName = mapName;
    state.startMoney = payload.player?.state?.money ?? 0;
    // Derive matchId from map name + round 1 timestamp (rough proxy until demo parsing)
    state.matchId = state.matchId ?? `gsi_${mapName}_${Date.now()}`;
  }

  // Track spend during freezetime
  if (roundPhase === 'freezetime') {
    state.spend = Math.max(0, state.startMoney - (payload.player?.state?.money ?? state.startMoney));
    state.buyType = classifyBuyType(equipValue, roundNum);
  }

  if (roundPhase === 'live' || roundPhase === 'over') {
    state.killsThisRound = roundKills;
    if (health === 0) state.died = true;
  }

  // Round over
  if (payload.round?.phase === 'over' && roundPhase !== state.roundPhase) {
    state.roundPhase = roundPhase;
    // Clutch detection: simplified — if died=false and kills>0 late in round, flag it
    // Full clutch detection (1vN) requires allplayers data (not enabled in basic cfg)
  }

  state.roundPhase = roundPhase;

  return res.sendStatus(200);
});

function commitRound(): void {
  if (!state.matchId || !state.mapName) return;

  const db = getDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO gsi_rounds
        (match_id, round_number, side, buy_type, spend, start_money,
         kills_this_round, died, clutch_situation, clutch_won)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      state.matchId,
      state.roundNumber,
      state.side ?? 'CT',
      state.buyType,
      state.spend,
      state.startMoney,
      state.killsThisRound,
      state.died ? 1 : 0,
      state.clutchSituation ? 1 : 0,
      state.clutchWon ? 1 : 0,
    );
  } catch (err) {
    console.error('[gsi] Failed to insert round:', err);
  }
}

export default router;
