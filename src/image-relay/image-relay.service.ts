import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { PostgresService } from '../scraping/jobs/postgres.service';

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
]);

const DEFAULT_MAX_BYTES = 10_485_760;
const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_LEASE_MS = 1_800_000;

type ImageJob = {
  id: string;
  inventory_id: string;
  site: string;
  product_id: string;
  image_url: string;
  status: string;
  attempts: number;
  claimed_by?: string;
  claimed_at?: string;
  upload_storage_key?: string;
  upload_bytes?: number;
  upload_sha256?: string;
  upload_content_type?: string;
};

type UploadMetadata = {
  storageKey: string;
  bytes: number;
  sha256: string;
  contentType: string;
};

@Injectable()
export class ImageRelayService {
  private readonly logger = new Logger(ImageRelayService.name);
  private readonly storageRoot = process.env.IMAGE_STORAGE_ROOT ?? '/data/images';
  private readonly maxBytes = Number(process.env.IMAGE_MAX_BYTES ?? DEFAULT_MAX_BYTES);
  private readonly retryLimit = Number(process.env.IMAGE_RETRY_LIMIT ?? DEFAULT_RETRY_LIMIT);
  private readonly leaseMs = Number(process.env.IMAGE_JOB_LEASE_MS ?? DEFAULT_LEASE_MS);

  constructor(private readonly db: PostgresService) {}

  enabled(): boolean {
    return process.env.IMAGE_RELAY_ENABLED === 'true';
  }

  async enqueueForInventory(
    inventoryId: string,
    site: string,
    product: { imageUrl?: string; imageUrls?: string[] },
  ): Promise<number> {
    if (!this.enabled() || !this.isAllowedSite(site)) {
      return 0;
    }

    const imageUrls = this.uniqueImageUrls(product);
    for (const imageUrl of imageUrls) {
      await this.db.query(
        `
        INSERT INTO image_jobs (inventory_id, site, product_id, image_url)
        VALUES ($1, $2, $1, $3)
        ON CONFLICT (inventory_id, image_url) DO NOTHING
        `,
        [inventoryId, site, imageUrl],
      );
    }

    return imageUrls.length;
  }

  async claim(workerId: string): Promise<ImageJob | undefined> {
    this.authenticate(workerId);

    const result = await this.db.query<ImageJob>(
      `
      UPDATE image_jobs
      SET status = 'processing',
          claimed_by = $1,
          claimed_at = NOW(),
          attempts = attempts + 1,
          updated_at = NOW(),
          upload_storage_key = NULL,
          upload_bytes = NULL,
          upload_sha256 = NULL,
          upload_content_type = NULL,
          upload_started_at = NULL
      WHERE id = (
        SELECT id
        FROM image_jobs
        WHERE status IN ('pending', 'retry_pending')
           OR (
             status = 'processing'
             AND claimed_at < NOW() - ($2::text || ' milliseconds')::interval
           )
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
      `,
      [workerId, this.leaseMs],
    );

    const job = result.rows[0];
    this.logEvent(job ? 'image_job_claimed' : 'image_job_poll_empty', {
      jobId: job?.id,
      workerId,
      state: job?.status ?? 'empty',
    });
    return job;
  }

  async heartbeat(jobId: string, workerId: string): Promise<{ id: string; state: string }> {
    this.authenticate(workerId);

    const result = await this.db.query(
      `
      UPDATE image_jobs
      SET claimed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'processing' AND claimed_by = $2
      RETURNING id
      `,
      [jobId, workerId],
    );

    if (!result.rows[0]) {
      throw new UnauthorizedException('Worker no autorizado o lease expirado');
    }

    this.logEvent('image_job_heartbeat', { jobId, workerId, state: 'processing' });
    return { id: jobId, state: 'processing' };
  }

  async upload(
    jobId: string,
    workerId: string,
    contentTypeHeader: string | undefined,
    request: NodeJS.ReadableStream,
  ): Promise<UploadMetadata & { jobId: string }> {
    this.authenticate(workerId);
    const contentType = this.normalizeContentType(contentTypeHeader);
    const job = await this.getJob(jobId);

    if (job.status === 'completed') {
      return this.asset(jobId) as Promise<UploadMetadata & { jobId: string }>;
    }
    this.assertJobOwner(job, workerId);

    const startedAt = Date.now();
    const uploadKey = `.staging/${jobId}/${randomUUID()}.tmp`;
    const temporaryPath = join(this.storageRoot, uploadKey);
    await fs.mkdir(dirname(temporaryPath), { recursive: true });

    let metadata: UploadMetadata;
    try {
      metadata = await this.writeStreamToFile(request, temporaryPath, uploadKey, contentType);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }

    await this.db.query(
      `
      UPDATE image_jobs
      SET upload_storage_key = $2,
          upload_bytes = $3,
          upload_sha256 = $4,
          upload_content_type = $5,
          upload_started_at = NOW(),
          updated_at = NOW()
      WHERE id = $1 AND status = 'processing' AND claimed_by = $6
      `,
      [jobId, metadata.storageKey, metadata.bytes, metadata.sha256, metadata.contentType, workerId],
    );

    this.logEvent('image_upload_received', {
      jobId,
      workerId,
      bytes: metadata.bytes,
      durationMs: Date.now() - startedAt,
      state: 'staged',
      contentType: metadata.contentType,
    });

    return { jobId, ...metadata };
  }

  async complete(jobId: string, workerId: string, body: Record<string, unknown>): Promise<unknown> {
    this.authenticate(workerId);
    const job = await this.getJob(jobId);

    if (job.status === 'completed') {
      return this.asset(jobId);
    }
    this.assertJobOwner(job, workerId);

    const metadata = this.readCompleteMetadata(body);
    this.assertStoredMetadataMatches(job, metadata);

    const stagedPath = join(this.storageRoot, job.upload_storage_key!);
    const publicKey = `${jobId}/original`;
    const publicPath = join(this.storageRoot, publicKey);
    await this.verifyFile(stagedPath, metadata);

    await fs.mkdir(dirname(publicPath), { recursive: true });
    await fs.rename(stagedPath, publicPath);

    const asset = await this.db.query(
      `
      INSERT INTO image_assets
        (inventory_id, image_job_id, source_url, storage_key, content_type, bytes, sha256)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (image_job_id)
      DO UPDATE SET updated_at = NOW()
      RETURNING *
      `,
      [job.inventory_id, jobId, job.image_url, publicKey, metadata.contentType, metadata.bytes, metadata.sha256],
    );

    await this.db.query(
      `
      UPDATE image_jobs
      SET status = 'completed', completed_at = NOW(), claimed_by = $2,
          upload_storage_key = NULL, updated_at = NOW()
      WHERE id = $1
      `,
      [jobId, workerId],
    );

    this.logEvent('image_job_completed', {
      jobId,
      workerId,
      bytes: metadata.bytes,
      state: 'completed',
    });
    return asset.rows[0];
  }

  async fail(jobId: string, workerId: string, error: unknown): Promise<{ id: string; status: string }> {
    this.authenticate(workerId);
    const job = await this.getJob(jobId);
    this.assertJobOwner(job, workerId);

    const status = job.attempts < this.retryLimit ? 'retry_pending' : 'failed';
    await this.db.query(
      `
      UPDATE image_jobs
      SET status = $2, last_error = $3, failed_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status <> 'completed'
      `,
      [jobId, status, sanitizeError(error)],
    );

    this.logEvent('image_job_failed', { jobId, workerId, state: status, error: sanitizeError(error) });
    return { id: jobId, status };
  }

  async asset(id: string): Promise<any> {
    const result = await this.db.query(
      'SELECT * FROM image_assets WHERE id = $1 OR image_job_id = $1',
      [id],
    );
    if (!result.rows[0]) {
      throw new NotFoundException('Asset no encontrado');
    }
    return result.rows[0];
  }

  async stream(id: string): Promise<{ asset: any; stream: NodeJS.ReadableStream }> {
    const asset = await this.asset(id);
    return { asset, stream: createReadStream(join(this.storageRoot, asset.storage_key)) };
  }

  private async writeStreamToFile(
    request: NodeJS.ReadableStream,
    temporaryPath: string,
    storageKey: string,
    contentType: string,
  ): Promise<UploadMetadata> {
    let bytes = 0;
    const hash = createHash('sha256');
    const output = createWriteStream(temporaryPath);

    try {
      for await (const chunk of request as AsyncIterable<Buffer>) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > this.maxBytes) {
          throw new PayloadTooLargeException('Imagen demasiado grande');
        }
        hash.update(buffer);
        if (!output.write(buffer)) {
          await new Promise<void>((resolve) => output.once('drain', resolve));
        }
      }
      await new Promise<void>((resolve, reject) => {
        output.once('error', reject);
        output.end(resolve);
      });
    } catch (error) {
      output.destroy();
      throw error;
    }

    return { storageKey, bytes, sha256: hash.digest('hex'), contentType };
  }

  private async verifyFile(path: string, metadata: UploadMetadata): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(path);
    } catch {
      throw new BadRequestException('Upload staged no encontrado');
    }
    if (stat.size !== metadata.bytes) {
      throw new BadRequestException('Bytes de imagen no coinciden');
    }

    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk);
    }
    if (hash.digest('hex') !== metadata.sha256) {
      throw new BadRequestException('SHA-256 de imagen no coincide');
    }
  }

  private readCompleteMetadata(body: Record<string, unknown>): UploadMetadata {
    const contentType = String(body.contentType ?? '');
    const bytes = Number(body.bytes);
    const sha256 = String(body.sha256 ?? '');
    if (!sha256 || !Number.isSafeInteger(bytes) || bytes <= 0 || !ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new BadRequestException('Metadata de imagen incompleta');
    }
    return { storageKey: '', bytes, sha256, contentType };
  }

  private assertStoredMetadataMatches(job: ImageJob, metadata: UploadMetadata): void {
    if (
      !job.upload_storage_key ||
      job.upload_sha256 !== metadata.sha256 ||
      Number(job.upload_bytes) !== metadata.bytes ||
      job.upload_content_type !== metadata.contentType
    ) {
      throw new BadRequestException('Metadata de imagen no coincide con upload');
    }
  }

  private assertJobOwner(job: ImageJob, workerId: string): void {
    if (job.claimed_by !== workerId) {
      throw new UnauthorizedException('Worker no autorizado para este job');
    }
  }

  private async getJob(id: string): Promise<ImageJob> {
    const result = await this.db.query<ImageJob>('SELECT * FROM image_jobs WHERE id = $1', [id]);
    if (!result.rows[0]) {
      throw new NotFoundException('Image job no encontrado');
    }
    return result.rows[0];
  }

  private authenticate(workerId: string): void {
    const expectedToken = process.env.IMAGE_WORKER_TOKEN;
    if (!expectedToken || workerId !== expectedToken) {
      throw new UnauthorizedException('Token de worker invalido');
    }
  }

  private isAllowedSite(site: string): boolean {
    const allowedSites = (process.env.IMAGE_RELAY_ALLOWED_SITES ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    const normalizedSite = site.toLowerCase();
    return allowedSites.some((allowed) => normalizedSite === allowed || normalizedSite.includes(allowed));
  }

  private uniqueImageUrls(product: { imageUrl?: string; imageUrls?: string[] }): string[] {
    return [...new Set([...(product.imageUrls ?? []), product.imageUrl]
      .filter((url): url is string => Boolean(url?.trim())))];
  }

  private normalizeContentType(value?: string): string {
    const contentType = value?.split(';')[0].trim().toLowerCase();
    if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
      throw new BadRequestException('Content-Type de imagen invalido');
    }
    return contentType;
  }

  private logEvent(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ event, ...fields, workerId: safeLogValue(fields.workerId) }));
  }
}

function safeLogValue(value: unknown): string {
  return String(value ?? '').trim().slice(0, 100);
}

function sanitizeError(value: unknown): string {
  return String(value ?? 'error')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/[\r\n]/g, ' ')
    .slice(0, 300);
}
