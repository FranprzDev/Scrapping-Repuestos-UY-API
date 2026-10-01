import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { URL } from 'node:url';
import { Readable } from 'node:stream';

export interface HttpResponseData {
  url: string;
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface HttpRequestInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  cookieJar?: Map<string, string>;
}

const HTTP_AGENT = new HttpAgent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 60000,
});

const HTTPS_AGENT = new HttpsAgent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20,
  timeout: 60000,
  rejectUnauthorized: false,
});

export async function fetchHtml(url: string, redirects = 5, init: HttpRequestInit = {}): Promise<HttpResponseData> {
  const target = new URL(url);
  const response = await requestUrl(target, redirects, init);

  return {
    url,
    finalUrl: response.finalUrl,
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
  };
}

async function requestUrl(target: URL, redirects: number, init: HttpRequestInit): Promise<HttpResponseData> {
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const method = init.method ?? 'GET';
  const body = init.body ?? '';
  const timeoutMs = init.timeoutMs ?? Number(process.env.SCRAPING_HTTP_TIMEOUT_MS ?? 45000);
  const timeoutSignal = init.signal ?? AbortSignal.timeout(timeoutMs);
  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 (compatible; RepuestosUYBot/1.0; +hybrid-scraper)',
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-language': 'es-ES,es;q=0.9,en;q=0.7',
    'accept-encoding': 'gzip, deflate, br',
    connection: 'keep-alive',
    ...init.headers,
  };

  if (init.cookieJar?.size && !headers.cookie) {
    headers.cookie = Array.from(init.cookieJar, ([name, value]) => `${name}=${value}`).join('; ');
  }

  if (method === 'POST' && !headers['content-type']) {
    headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
  }

  if (method === 'POST' && !headers['content-length']) {
    headers['content-length'] = Buffer.byteLength(body).toString();
  }

  return new Promise<HttpResponseData>((resolve, reject) => {
    const req = transport(
      target,
      {
        method,
        headers,
        agent: target.protocol === 'https:' ? HTTPS_AGENT : HTTP_AGENT,
        rejectUnauthorized: false,
        signal: timeoutSignal,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const location = res.headers.location;
        storeResponseCookies(init.cookieJar, res.headers['set-cookie']);

        if (statusCode >= 300 && statusCode < 400 && location && redirects > 0) {
          res.resume();
          const redirected = new URL(location, target);
          const redirectInit = method === 'POST' && [301, 302, 303].includes(statusCode)
            ? {
                ...init,
                method: 'GET' as const,
                body: undefined,
                headers: Object.fromEntries(
                  Object.entries(init.headers ?? {}).filter(([name]) => !['content-type', 'content-length'].includes(name.toLowerCase())),
                ),
              }
            : init;
          resolve(requestUrl(redirected, redirects - 1, redirectInit));
          return;
        }

        readResponse(res)
          .then((body) =>
            resolve({
              url: target.toString(),
              finalUrl: target.toString(),
              statusCode,
              headers: res.headers,
              body,
            }),
          )
          .catch(reject);
      },
    );

    req.on('error', reject);
    req.end(body);
  });
}

function storeResponseCookies(jar: Map<string, string> | undefined, setCookie: string[] | string | undefined): void {
  if (!jar || !setCookie) return;
  for (const cookie of Array.isArray(setCookie) ? setCookie : [setCookie]) {
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value) jar.set(name, value);
    else jar.delete(name);
  }
}

async function readResponse(stream: Readable & { headers?: Record<string, string | string[] | undefined> }): Promise<string> {
  const encoding = String(stream.headers?.['content-encoding'] ?? '').toLowerCase();
  const source =
    encoding.includes('br')
      ? stream.pipe(createBrotliDecompress())
      : encoding.includes('gzip')
        ? stream.pipe(createGunzip())
        : encoding.includes('deflate')
          ? stream.pipe(createInflate())
          : stream;

  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}
