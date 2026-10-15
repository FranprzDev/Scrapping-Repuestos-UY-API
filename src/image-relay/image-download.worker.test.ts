import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadImage } from './image-download.worker';

const response = (body: BodyInit | null, type: string, extra: Record<string, string> = {}) =>
  (async () => new Response(body, { headers: { 'content-type': type, ...extra } })) as typeof fetch;

test('downloads image bytes and preserves content type', async () => {
  const result = await downloadImage('https://provider.test/a.jpg', 'https://provider.test/',
    new AbortController().signal, 100, response(new Uint8Array([1, 2, 3]), 'image/jpeg; charset=binary'));
  assert.equal(result.contentType, 'image/jpeg');
  assert.deepEqual(Buffer.concat(result.chunks), Buffer.from([1, 2, 3]));
});

test('rejects HTML login/error pages rather than storing them as images', async () => {
  await assert.rejects(downloadImage('https://provider.test/a.jpg', '', new AbortController().signal,
    100, response('<html>Login</html>', 'text/html')), /content type/);
});

test('enforces size for both declared and chunked image responses', async () => {
  for (const headers of [{ 'content-length': '20' }, {}] as Record<string, string>[]) {
    await assert.rejects(downloadImage('https://provider.test/a.jpg', '', new AbortController().signal,
      2, response(new Uint8Array([1, 2, 3]), 'image/png', headers)), /byte limit/);
  }
});

test('rejects empty images and unsupported URL schemes', async () => {
  await assert.rejects(downloadImage('https://provider.test/a.jpg', '', new AbortController().signal,
    100, response(null, 'image/png')), /Empty/);
  await assert.rejects(downloadImage('file:///secret.png', '', new AbortController().signal,
    100, response(null, 'image/png')), /Invalid image URL/);
});
