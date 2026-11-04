// Base64 <-> media payloads: recognise what a pasted data URL or raw Base64
// blob actually contains, and turn it back into bytes or text. Pure, so
// test/base64.test.mjs covers the sniffing and the text fallback.

import { MIME_BY_EXT } from './plan.js';

// What a decoded payload turned out to be: a file to write, or plain text.
export type DecodedPayload =
  | { kind: 'file'; bytes: Buffer; mime: string; ext: string }
  | { kind: 'text'; text: string };

function ascii(bytes: Buffer, offset: number, length: number): string {
  if (bytes.length < offset + length) return '';
  return bytes.toString('latin1', offset, offset + length);
}

const SIGNATURES: { mime: string; ext: string; match: (b: Buffer) => boolean }[] = [
  { mime: 'image/png', ext: 'png', match: (b) => b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' },
  { mime: 'image/jpeg', ext: 'jpg', match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', ext: 'gif', match: (b) => ascii(b, 0, 3) === 'GIF' },
  { mime: 'image/webp', ext: 'webp', match: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP' },
  { mime: 'audio/wav', ext: 'wav', match: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE' },
  { mime: 'video/x-msvideo', ext: 'avi', match: (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ' },
  { mime: 'video/mp4', ext: 'mp4', match: (b) => ascii(b, 4, 4) === 'ftyp' },
  { mime: 'video/webm', ext: 'webm', match: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { mime: 'audio/ogg', ext: 'ogg', match: (b) => ascii(b, 0, 4) === 'OggS' },
  { mime: 'audio/flac', ext: 'flac', match: (b) => ascii(b, 0, 4) === 'fLaC' },
  { mime: 'audio/mpeg', ext: 'mp3', match: (b) => ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) },
];

export function sniffMime(bytes: Buffer): { mime: string; ext: string } | null {
  if (!bytes || bytes.length < 4) return null;
  const hit = SIGNATURES.find((signature) => signature.match(bytes));
  return hit ? { mime: hit.mime, ext: hit.ext } : null;
}

export function extForMime(mime: string): string {
  const wanted = String(mime || '').toLowerCase().split(';')[0].trim();
  const hit = Object.keys(MIME_BY_EXT).find((ext) => MIME_BY_EXT[ext].split(';')[0] === wanted);
  return hit || 'bin';
}

// Valid UTF-8 with no control bytes: show it as text instead of writing a file.
export function looksLikeText(bytes: Buffer): boolean {
  if (!bytes || !bytes.length || bytes.includes(0)) return false;
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) return false;
  return !/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/.test(text);
}

// data URL or raw Base64 -> { kind: 'file', bytes, mime, ext } | { kind: 'text', text }
export function decodeBase64Payload(input: string | undefined): DecodedPayload {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('还没有粘贴内容');

  let mime = '';
  let body = raw;
  const dataUrl = /^data:([^;,]*)(?:;[^,]*)?,/i.exec(raw);
  if (dataUrl) {
    mime = String(dataUrl[1] || '').toLowerCase();
    body = raw.slice(dataUrl[0].length);
  }
  body = body.replace(/\s+/g, '');
  if (!body) throw new Error('Base64 内容为空');
  if (!/^[A-Za-z0-9+/_=-]+$/.test(body)) throw new Error('不是有效的 Base64 文本');

  body = body.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes = Buffer.from(body + '='.repeat((4 - (body.length % 4)) % 4), 'base64');
  if (!bytes.length) throw new Error('Base64 解码结果为空');

  // An explicit data URL type wins; a raw blob is identified by its own bytes.
  const sniffed = mime ? { mime, ext: extForMime(mime) } : sniffMime(bytes);
  if (sniffed && sniffed.mime !== 'application/octet-stream' && !sniffed.mime.startsWith('text/')) {
    return { kind: 'file', bytes, mime: sniffed.mime, ext: sniffed.ext };
  }
  if (looksLikeText(bytes)) return { kind: 'text', text: bytes.toString('utf8') };
  return { kind: 'file', bytes, mime: sniffed ? sniffed.mime : 'application/octet-stream', ext: sniffed ? sniffed.ext : 'bin' };
}
