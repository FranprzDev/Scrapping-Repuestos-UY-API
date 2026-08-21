import type { YokomitsuHttpClient, YokomitsuHttpResponse } from './yokomitsu-auth';

export class YokomitsuCookieJarHttpClient implements YokomitsuHttpClient {
  private readonly cookies = new Map<string, string>();

  async get(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<YokomitsuHttpResponse> {
    return this.request(url, { method: 'GET', headers });
  }

  async post(
    url: string,
    body: string,
    headers: Record<string, string> = {},
  ): Promise<YokomitsuHttpResponse> {
    return this.request(url, { method: 'POST', headers, body });
  }

  async getCookieNames(): Promise<string[]> {
    return Array.from(this.cookies.keys()).sort();
  }

  async clearSession(): Promise<void> {
    this.cookies.clear();
  }

  private async request(
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body?: string;
    },
  ): Promise<YokomitsuHttpResponse> {
    const headers = { ...init.headers };
    const cookieHeader = this.cookieHeader();

    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    const response = await fetch(url, {
      method: init.method,
      headers,
      body: init.body,
      redirect: 'follow',
    });

    const responseHeaders = headersToRecord(response.headers);
    const setCookies = getSetCookieHeaders(response.headers);

    if (setCookies.length > 0) {
      responseHeaders['set-cookie'] = setCookies;
      this.storeSetCookies(setCookies);
    }

    return {
      url: response.url,
      status: response.status,
      headers: responseHeaders,
      body: await response.text(),
    };
  }

  private storeSetCookies(values: string[]): void {
    for (const value of values) {
      const [pair] = value.split(';');
      const separator = pair.indexOf('=');

      if (separator <= 0) continue;

      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1);

      if (name) {
        this.cookies.set(name, cookieValue);
      }
    }
  }

  private cookieHeader(): string | undefined {
    if (this.cookies.size === 0) return undefined;

    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }
}

function headersToRecord(headers: Headers): Record<string, string | string[] | undefined> {
  return Object.fromEntries(headers.entries());
}

function getSetCookieHeaders(headers: Headers): string[] {
  const values = (
    headers as Headers & { getSetCookie?: () => string[] }
  ).getSetCookie?.();

  if (values && values.length > 0) {
    return values;
  }

  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

