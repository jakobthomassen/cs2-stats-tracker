// Share code decoder using csgo-sharecode
// A share code encodes: matchId, outcomeId, tokenId
// The demo URL is constructed from these values.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharecode = require('csgo-sharecode');

export interface DecodedShareCode {
  matchId: bigint;
  reservationId: bigint;
  tvPort: number;
  demoUrl: string;
  infoUrl: string;
}

export function decodeShareCode(code: string): DecodedShareCode {
  // csgo-sharecode returns { matchId, reservationId, tvPort }
  const decoded = sharecode.decode(code) as {
    matchId: bigint;
    reservationId: bigint;
    tvPort: number;
  };

  // Use BigInt modulo to avoid precision loss — matchId > 2^53 so Number() truncates
  const replayNum = decoded.matchId % 256n;
  const base = `https://replay${replayNum}.valve.net/730/${decoded.matchId}_${decoded.reservationId}`;

  return {
    matchId:       decoded.matchId,
    reservationId: decoded.reservationId,
    tvPort:        decoded.tvPort,
    demoUrl: `${base}.dem.bz2`,
    infoUrl: `${base}.dem.info`,
  };
}

export function encodeShareCode(matchId: bigint, outcomeId: bigint, tokenId: number): string {
  return sharecode.encode({ matchId, outcomeId, tokenId });
}
