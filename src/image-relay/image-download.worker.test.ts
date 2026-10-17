import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadImage, sniffImageContentType } from './image-download.worker';

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

test('accepts a valid image when the provider sends application/octet-stream', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const result = await downloadImage('https://provider.test/a.jpg', 'https://provider.test/',
    new AbortController().signal, 100, response(jpeg, 'application/octet-stream'));
  assert.equal(result.contentType, 'image/jpeg');
});

test('retries a forbidden image once without referer', async () => {
  let attempts = 0;
  const fetcher = (async (_url: string, init?: RequestInit) => {
    attempts += 1;
    if (attempts === 1) return new Response('forbidden', { status: 403 });
    assert.equal((init?.headers as Record<string, string>).referer, undefined);
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;

  const result = await downloadImage('https://provider.test/a.jpg', 'https://provider.test/',
    new AbortController().signal, 100, fetcher);
  assert.equal(result.contentType, 'image/jpeg');
  assert.equal(attempts, 2);
});

test('sniffs supported image signatures', () => {
  assert.equal(sniffImageContentType(Buffer.from([0xff, 0xd8, 0xff])), 'image/jpeg');
  assert.equal(sniffImageContentType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
  assert.equal(sniffImageContentType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(sniffImageContentType(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
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

