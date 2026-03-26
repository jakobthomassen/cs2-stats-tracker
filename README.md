# CS2 Stats Tracker

Personal CS2 stats dashboard. Pulls match history from Steam's GCPD, downloads and parses demo files, and serves a local web UI. No cloud, no third-party services.

**Requires Node.js v18+ and a Steam account with CS2.**

## Setup

```
npm install
```

Copy `config.example.json` to `config.json` and set your values:

```json
{
  "steamId":  "YOUR_STEAM_ID_64",
  "port":     3000
}
```

`steamId` — your 64-bit Steam ID ([steamid.io](https://steamid.io)).
`steamApiKey` — optional, from [steamcommunity.com/dev/apikey](https://steamcommunity.com/dev/apikey).
`steamSessionCookie` — optional fallback if QR login isn't working.

```
npm start
```

On first launch, open the dashboard at `http://localhost:3000` and click **Login** to authenticate via QR code. Scan it with the Steam mobile app. Subsequent launches reuse the stored refresh token automatically.

## How it works

- **GCPD sync** — walks Steam's match history pages, inserts new matches, stops when it hits already-known data
- **Demo parsing** — downloads `.dem.bz2` replays from Valve's servers and extracts per-match stats (K/D/A, ADR, HS%, aim rating, time-to-damage)
- **Dashboard** — single-page app served locally; no external frontend dependencies

Match rows are inserted as stubs on first sync. Full stats (ADR, aim rating) appear once the demo for that match has been downloaded and parsed. Demos are only available for roughly the 8 most recent matches at any given time.

## Data directory

`data/tracker.db` — SQLite database (gitignored, back it up if you care about history)
`data/demos/` — downloaded demo files (gitignored)
