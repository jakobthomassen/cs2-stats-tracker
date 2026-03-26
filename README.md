# CS2 Personal Stats Tracker

A local Node.js + TypeScript web app that syncs your CS2 match data into a SQLite database and serves a personal stats dashboard. No cloud, no third-party scraping — all data comes from Valve's own APIs.

## Requirements

- Node.js v18+
- A Steam account with CS2

## Setup

### 1. Install dependencies

```
npm install
```

### 2. Configure credentials

Copy `config.example.json` to `config.json` and fill in your details:

```json
{
  "steamApiKey":   "YOUR_STEAM_API_KEY",
  "steamId":       "YOUR_STEAM_ID_64",
  "authCode":      "YOUR_GAME_AUTH_CODE",
  "lastShareCode": "CSGO-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  "port":          3000
}
```

**steamApiKey** — Get one at [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey). Any domain works (e.g. `localhost`).

**steamId** — Your 64-bit Steam ID. Find it at [steamid.io](https://steamid.io) or in Steam → Profile URL.

**authCode** — A one-time code that authorises the share code API.
1. Go to **Steam Help → CS:GO / CS2**
2. Find the option **"I want to permanently delete my CS:GO / CS2 game data"** (don't worry — just navigating to it generates the code, you don't confirm anything)
3. Copy the **Game Authentication Code** shown on that page

**lastShareCode** — Your most recent match's share code. In CS2:
1. Open the **Watch** tab
2. Click **Your Matches**
3. Click **Share** on your most recent match and copy the `CSGO-XXXXX-…` code

> **Important:** The seed share code must be no more than 30 days old. If sync lapses longer than that, paste a new seed code here manually.

### 3. Run

```
npm start
```

The tracker will:
1. Walk the share code chain from your seed code to find new matches
2. Snapshot current weapon stats from Steam
3. Log the sync to the database
4. Start the dashboard at **http://localhost:3000** and open it in your browser

---

## Dashboard views

| View | What it shows |
|------|---------------|
| **Overview** | K/D, ADR, HS%, win rate KPI cards; K/D trend chart; recent sessions table |
| **Weapons** | Per-weapon accuracy bars, HS% bars, kill share chart, full lifetime stats table |
| **Maps** | Win rate bar chart, per-map K/D / ADR / HS% table |
| **Clutch** | Clutch win rate by economy type *(requires GSI — Phase 2)* |
| **Role** | Entry / support / lurk tendency *(requires GSI — Phase 2)* |

---

## Data sources

All Valve-sanctioned, zero ToS risk:

- **`ICSGOPlayers_730/GetNextMatchSharingCode/v1`** — walks the share code chain to discover new matches
- **`ISteamUserStats/GetUserStatsForGame/v2`** — lifetime weapon stats; per-session accuracy is approximated from deltas between consecutive snapshots
- **Game State Integration (GSI)** — Phase 2; CS2 pushes live round data to a local HTTP listener

---

## Phase 2 — Game State Integration (optional)

For clutch tracking and role tendency, CS2 can push real-time round data while you play.

1. Create the GSI config file at:
   ```
   C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\csgo\cfg\gamestate_integration_cs2tracker.cfg
   ```
2. Paste this content:
   ```
   "CS2 Tracker"
   {
     "uri"           "http://127.0.0.1:3000/gsi"
     "timeout"       "5.0"
     "buffer"        "0.1"
     "throttle"      "0.5"
     "heartbeat"     "10.0"
     "data"
     {
       "provider"            "1"
       "map"                 "1"
       "round"               "1"
       "player_id"           "1"
       "player_state"        "1"
       "player_weapons"      "1"
       "player_match_stats"  "1"
     }
   }
   ```
3. Start the tracker with GSI enabled:
   ```
   GSI_ENABLED=1 npm start
   ```

---

## Project structure

```
cs2-stats-tracker/
├── start.ts                   # Entry point
├── config.json                # Credentials (gitignored — copy from config.example.json)
├── config.example.json        # Template
├── src/
│   ├── db/
│   │   ├── schema.sql         # Tables + weapon_stats_delta view
│   │   └── database.ts        # sql.js wrapper (no native compilation needed)
│   ├── sync/
│   │   ├── shareCode.ts       # Decode/encode CSGO share codes
│   │   ├── steamApi.ts        # Steam API calls
│   │   ├── matchFetcher.ts    # Share code chain walker
│   │   └── weaponSnapshots.ts # Lifetime weapon stat snapshots + deltas
│   ├── gsi/
│   │   └── listener.ts        # Phase 2: GSI round data listener
│   ├── server/
│   │   ├── index.ts           # Express app
│   │   └── routes/            # /api/matches /api/weapons /api/clutch /api/sync
│   └── dashboard/
│       └── index.html         # Single-page dashboard (no external frontend deps)
└── data/
    └── tracker.db             # SQLite database (gitignored)
```

---

## Notes

- **Match stats (K/D, ADR, map, result)** are populated as stub rows on first sync. Full per-match stats require demo parsing (Phase 3) — the decoded share codes already contain direct `.dem.bz2` download URLs from Valve's replay servers for when that's implemented.
- **Weapon accuracy stats** work immediately on first sync — lifetime totals come straight from the Steam API, with per-session deltas computed from consecutive snapshots.
- The database is a local `data/tracker.db` file. It's gitignored — back it up if you care about history.
