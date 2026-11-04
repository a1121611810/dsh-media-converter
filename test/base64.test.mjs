// Self-check for Base64 payload recognition: `node test/base64.test.mjs`.
import assert from 'node:assert/strict';
import { decodeBase64Payload, extForMime, looksLikeText, sniffMime } from '../dist/lib/base64.js';

const pngBytes = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.alloc(16),
]);
const jpegBytes = Buffer.concat([Buffer.from('ffd8ffe000104a46', 'hex'), Buffer.alloc(16)]);
const mp4Bytes = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
const webmBytes = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.alloc(16)]);
const mp3Bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16)]);

assert.deepEqual(sniffMime(pngBytes), { mime: 'image/png', ext: 'png' });
assert.deepEqual(sniffMime(jpegBytes), { mime: 'image/jpeg', ext: 'jpg' });
assert.deepEqual(sniffMime(mp4Bytes), { mime: 'video/mp4', ext: 'mp4' });
assert.deepEqual(sniffMime(webmBytes), { mime: 'video/webm', ext: 'webm' });
assert.deepEqual(sniffMime(mp3Bytes), { mime: 'audio/mpeg', ext: 'mp3' });
assert.equal(sniffMime(Buffer.from('hello world')), null);

assert.equal(extForMime('image/jpeg'), 'jpg');
assert.equal(extForMime('image/png; charset=binary'), 'png');
assert.equal(extForMime('application/x-nope'), 'bin');

assert.equal(looksLikeText(Buffer.from('你好，世界')), true);
assert.equal(looksLikeText(Buffer.from([0x00, 0x01, 0x02])), false);
assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0xfd])), false);
assert.equal(looksLikeText(Buffer.alloc(0)), false);

// A data URL keeps its declared type and round-trips the bytes.
const pngData = 'data:image/png;base64,' + pngBytes.toString('base64');
const fromDataUrl = decodeBase64Payload(pngData);
assert.equal(fromDataUrl.kind, 'file');
assert.equal(fromDataUrl.mime, 'image/png');
assert.equal(fromDataUrl.ext, 'png');
assert.ok(fromDataUrl.bytes.equals(pngBytes));

// Raw Base64 is identified from its own magic bytes.
const rawMp4 = decodeBase64Payload('  ' + mp4Bytes.toString('base64') + '\n');
assert.equal(rawMp4.kind, 'file');
assert.equal(rawMp4.ext, 'mp4');
assert.ok(rawMp4.bytes.equals(mp4Bytes));

// Base64 of plain text comes back as text, not as a mystery binary file.
assert.deepEqual(decodeBase64Payload(Buffer.from('你好，世界').toString('base64')), { kind: 'text', text: '你好，世界' });
assert.equal(decodeBase64Payload(Buffer.from('hello').toString('base64url')).text, 'hello');

// Unknown binary stays a file instead of being mangled into text.
const binary = Buffer.from([0x01, 0x02, 0x03, 0x04, 0xff]);
const unknown = decodeBase64Payload(binary.toString('base64'));
assert.equal(unknown.kind, 'file');
assert.equal(unknown.ext, 'bin');
assert.ok(unknown.bytes.equals(binary));

assert.throws(() => decodeBase64Payload(''), /还没有粘贴/);
assert.throws(() => decodeBase64Payload('%not-base64%'), /不是有效的 Base64/);

console.log('base64.test.mjs: ok');
