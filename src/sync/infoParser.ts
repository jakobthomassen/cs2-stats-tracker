/**
 * Phase 3 — .dem.info companion file parser
 *
 * Valve's .dem.info files require Game Coordinator authentication and are not
 * accessible via plain HTTP. This module is kept for Phase 3, where demos will
 * be downloaded through the Steam GC or the CS2 client, at which point the
 * .info file can be read locally.
 *
 * The protobuf scanner below (scanProtobuf) is correct and ready to use once
 * the file bytes are available locally.
 */

export interface DemoInfo {
  map: string;       // e.g. "de_dust2"
  matchDate: number; // unix timestamp (seconds)
}

const MAP_PREFIXES = ['de_', 'ar_', 'cs_', 'fy_', 'aim_', 'training_'];
const MIN_TIMESTAMP = 1577836800; // 2020-01-01
const MAX_TIMESTAMP = 1924905600; // 2031-01-01

/**
 * Parse a locally-read .dem.info buffer.
 * Phase 3: call this after downloading the file via the Steam GC / CS2 client.
 */
export function parseDemoInfo(buf: Buffer): DemoInfo | null {
  const { strings, varints } = scanProtobuf(buf);

  const map = strings.find(s =>
    MAP_PREFIXES.some(p => s.startsWith(p)) && s.length <= 64
  ) ?? null;

  const matchDate = varints.find(v => v >= MIN_TIMESTAMP && v <= MAX_TIMESTAMP) ?? null;

  if (!map && !matchDate) return null;

  return {
    map:       map ?? 'unknown',
    matchDate: matchDate ?? Math.floor(Date.now() / 1000),
  };
}

// ── Minimal protobuf scanner ────────────────────────────────────────────────

interface ScanResult {
  strings: string[];
  varints: number[];
}

function scanProtobuf(buf: Buffer): ScanResult {
  const strings: string[] = [];
  const varints: number[] = [];
  let pos = 0;

  function readVarint(): number | null {
    let result = 0;
    let shift = 0;
    while (pos < buf.length) {
      const byte = buf[pos++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return result >>> 0;
      if (shift >= 35) {
        while (pos < buf.length && buf[pos++] & 0x80) { /* skip */ }
        return null;
      }
    }
    return null;
  }

  while (pos < buf.length) {
    const tag = readVarint();
    if (tag === null) break;

    const wireType = tag & 0x07;

    if (wireType === 0) {
      const val = readVarint();
      if (val !== null) varints.push(val);
    } else if (wireType === 2) {
      const len = readVarint();
      if (len === null || pos + len > buf.length || len > 65536) break;
      const slice = buf.slice(pos, pos + len);
      pos += len;
      try {
        const str = slice.toString('utf8');
        if (/^[\x20-\x7e]+$/.test(str)) strings.push(str);
      } catch { /* skip */ }
      if (len > 2) {
        const nested = scanProtobuf(slice);
        strings.push(...nested.strings);
        varints.push(...nested.varints);
      }
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 <= buf.length) varints.push(buf.readUInt32LE(pos));
      pos += 4;
    } else {
      break;
    }
  }

  return { strings, varints };
}
