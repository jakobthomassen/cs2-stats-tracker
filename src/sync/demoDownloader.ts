import axios from 'axios';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';

// unbzip2-stream has no @types package — CommonJS require
// eslint-disable-next-line @typescript-eslint/no-require-imports
const unbzip2 = require('unbzip2-stream');

/**
 * Download a .dem.bz2 file from url and return the raw compressed bytes (Buffer).
 * We store compressed rather than decompressed to save disk space.
 */
export async function downloadDemoBz2(
  url: string,
  destPath: string,
  steamCookie?: string,
  steamId?: string,
): Promise<void> {
  // Valve replay servers use plain HTTP — SSL handshake fails on https://
  const httpUrl = url.replace(/^https?:\/\//, 'http://');
  console.log(`[demo] Downloading: ${httpUrl}${steamCookie ? ' (authenticated)' : ''}`);

  const headers: Record<string, string> = {
    'User-Agent':      'Valve/Steam HTTP Client 1.0',
    'Accept':          'text/html,*/*;q=0.9',
    'Accept-Encoding': 'gzip,identity,*;q=0',
    'Accept-Charset':  'ISO-8859-1,utf-8,*;q=0.7',
  };
  if (steamCookie) headers['Cookie'] = steamCookie;
  // Valve replay servers check Referer — requests without it get 502
  if (steamId) {
    headers['Referer'] = `https://steamcommunity.com/profiles/${steamId}/gcpd/730`;
  }

  const response = await axios.get(httpUrl, {
    responseType: 'stream',
    timeout: 180_000, // 3 min — demos can be large
    headers,
  });

  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const writeStream = fs.createWriteStream(destPath);

  await new Promise<void>((resolve, reject) => {
    (response.data as Readable).pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    (response.data as Readable).on('error', reject);
  });

  const sizeKB = Math.round(fs.statSync(destPath).size / 1024);
  console.log(`[demo] Downloaded: ${sizeKB} KB compressed`);
}

/**
 * Decompress a .dem.bz2 file to a .dem file on disk.
 * Writing to disk avoids loading 280–320 MB into a single in-memory buffer,
 * which caused WASM out-of-memory crashes with the old in-process parser.
 */
export async function decompressBz2ToDisk(bz2Path: string, demPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const readStream  = fs.createReadStream(bz2Path);
    const decompressor = unbzip2() as NodeJS.ReadWriteStream;
    const writeStream = fs.createWriteStream(demPath);

    readStream.pipe(decompressor).pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    readStream.on('error', reject);
    decompressor.on('error', reject);
  });

  const sizeMB = (fs.statSync(demPath).size / 1024 / 1024).toFixed(1);
  console.log(`[demo] Decompressed to disk: ${sizeMB} MB → ${demPath}`);
}
