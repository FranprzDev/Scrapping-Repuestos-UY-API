import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
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

export async function fetchHtml(url: string, redirects = 5): Promise<HttpResponseData> {
  const target = new URL(url);
  const response = await requestUrl(target, redirects);

  return {
    url,
    finalUrl: response.finalUrl,
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body,
  };
}

async function requestUrl(target: URL, redirects: number): Promise<HttpResponseData> {
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise<HttpResponseData>((resolve, reject) => {
    const req = transport(
      target,
      {
        method: 'GET',
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; RepuestosUYBot/1.0; +hybrid-scraper)',
          accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'accept-language': 'es-ES,es;q=0.9,en;q=0.7',
          'accept-encoding': 'gzip, deflate, br',
          connection: 'keep-alive',
        },
        rejectUnauthorized: false,
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const location = res.headers.location;

        if (statusCode >= 300 && statusCode < 400 && location && redirects > 0) {
          res.resume();
          const redirected = new URL(location, target);
          resolve(requestUrl(redirected, redirects - 1));
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

    req.setTimeout(45000, () => {
      req.destroy(new Error(`Timeout leyendo ${target.toString()}`));
    });

    req.on('error', reject);
    req.end();
  });
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
