import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdir, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { ImageRelayService } from './image-relay.service';

const CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

export async function downloadImage(url: string, referer: string, signal: AbortSignal, maxBytes: number, fetcher: typeof fetch = fetch) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid image URL');
  const response = await fetcher(url, { signal, headers: {
    'user-agent': 'Mozilla/5.0 (compatible; RepuestosUYBot/1.0)',
    accept: 'image/avif,image/webp,image/*', referer,
  } });
  try {
    if (!response.ok) throw new Error(`Image HTTP ${response.status}`);
    const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (!CONTENT_TYPES.has(contentType)) throw new Error('Unsupported image content type');
    if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Image exceeds byte limit');
    if (!response.body) throw new Error('Empty image response');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error('Image exceeds byte limit');
      chunks.push(Buffer.from(chunk));
    }
    if (!bytes) throw new Error('Empty image response');
    return { chunks, contentType };
  } finally { if (response.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
}

@Injectable()
export class ImageDownloadWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ImageDownloadWorker.name);
  private readonly workerId = `server-images-${randomUUID()}`;
  private readonly storageRoot = process.env.IMAGE_STORAGE_ROOT ?? '/data/images';
  private readonly maxBytes = positiveInt(process.env.IMAGE_MAX_BYTES, 10485760);
  private readonly minFreeBytes = positiveInt(process.env.IMAGE_MIN_FREE_BYTES, 2147483648);
  private readonly delayMs = positiveInt(process.env.IMAGE_DOWNLOAD_DELAY_MS, 1000);
  private readonly cooldowns = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private controller?: AbortController;
  private current?: Promise<void>;
  private lastStorageWarning = 0;

  constructor(@Inject(ImageRelayService) private readonly relay: ImageRelayService) {}

  async onModuleInit() {
    if (process.env.IMAGE_DOWNLOAD_WORKER_ENABLED !== 'true' || !this.relay.enabled()) return;
    if (!process.env.IMAGE_WORKER_TOKEN) throw new Error('IMAGE_WORKER_TOKEN required for image downloads');
    await mkdir(this.storageRoot, { recursive: true });
    this.logger.log('Image downloader enabled; existing queue resumes automatically');
    this.schedule(10000);
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.controller?.abort();
    await this.current;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => { this.current = this.tick(); }, ms);
  }

  private async tick() {
    let delay = this.delayMs;
    try { if (!await this.runOnce()) delay = 30000; }
    catch (error) { this.logger.warn(`Image worker paused: ${error instanceof Error ? error.message : 'error'}`); delay = 30000; }
    finally { this.schedule(delay); }
  }

  async runOnce(): Promise<boolean> {
    const space = await statfs(this.storageRoot, { bigint: true });
    if (space.bavail * space.bsize < BigInt(this.minFreeBytes + this.maxBytes)) {
      if (Date.now() - this.lastStorageWarning > 300000) {
        this.logger.warn('Image downloads paused: storage reserve reached');
        this.lastStorageWarning = Date.now();
      }
      return false;
    }
    const token = process.env.IMAGE_WORKER_TOKEN ?? '';
    const excluded = [...this.cooldowns].filter(([, until]) => until > Date.now()).map(([host]) => host);
    const job = await this.relay.claim(token, this.workerId, excluded);
    if (!job) return false;
    this.controller = new AbortController();
    const timeout = setTimeout(() => this.controller?.abort(), 90000);
    const heartbeat = setInterval(() => {
      void this.relay.heartbeat(job.id, token, this.workerId).catch(() => this.controller?.abort());
    }, 30000);
    try {
      const downloaded = await downloadImage(job.image_url, job.site, this.controller.signal, this.maxBytes);
      const metadata = await this.relay.upload(job.id, token, this.workerId, downloaded.contentType, Readable.from(downloaded.chunks));
      await this.relay.complete(job.id, token, this.workerId, metadata);
      this.cooldowns.delete(new URL(job.image_url).host);
    } catch (error) {
      try { this.cooldowns.set(new URL(job.image_url).host, Date.now() + 300000); } catch { /* Invalid URL still records a failed job. */ }
      await this.relay.fail(job.id, token, this.workerId, error instanceof Error ? error.message : 'Download failed');
    } finally {
      clearTimeout(timeout); clearInterval(heartbeat); this.controller = undefined;
    }
    return true;
  }
}

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
