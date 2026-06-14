import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ScrapingOperationPayload, ScrapingTask } from '../interfaces/scraping.types';
import { CatalogScrapeRequestDto } from '../dto/catalog-request.dto';
import { CatalogScrapingService, type CatalogSiteProgress, type CatalogProductSummary } from '../catalog-scraping.service';
import { ScrapingService } from '../scraping.service';
import { PostgresService } from './postgres.service';

export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface ScrapingJob {
  id: string;
  task: ScrapingTask;
  payload: ScrapingOperationPayload;
  status: JobStatus;
  provider?: string;
  summary?: ScrapingJobSummary;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ScrapingJobSummary {
  currentSite?: string;
  stage?: CatalogSiteProgress['stage'];
  quantityScrapped?: number;
  timeWorkingMs?: number;
  lastScrapedProduct?: CatalogProductSummary;
  progress?: {
    sites: CatalogSiteProgress[];
  };
}

type ScrapingJobRow = {
  id: string;
  task: ScrapingTask;
  payload: ScrapingOperationPayload;
  status: JobStatus;
  provider: string | null;
  result: unknown | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

@Injectable()
export class JobQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobQueueService.name);
  private readonly maxWorkers = clampNumber(process.env.JOB_WORKERS, 1, 20, 2);
  private readonly pollIntervalMs = clampNumber(process.env.JOB_POLL_INTERVAL_MS, 200, 10000, 1000);
  private activeWorkers = 0;
  private timer: NodeJS.Timeout | undefined;
  private shuttingDown = false;

  constructor(
    @Inject(ScrapingService)
    private readonly scrapingService: ScrapingService,
    @Inject(CatalogScrapingService)
    private readonly catalogScrapingService: CatalogScrapingService,
    @Inject(PostgresService)
    private readonly postgresService: PostgresService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.postgresService.ensureJobsTable();
    this.startPolling();
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async enqueue(task: ScrapingTask, payload: ScrapingOperationPayload): Promise<ScrapingJob> {
    const id = randomUUID();
    const inserted = await this.postgresService.query<ScrapingJobRow>(
      `
      INSERT INTO scraping_jobs (id, task, payload, status)
      VALUES ($1, $2, $3::jsonb, 'queued')
      RETURNING id, task, payload, status, provider, result, error, created_at, updated_at
      `,
      [id, task, JSON.stringify(payload)],
    );

    const [row] = inserted.rows;
    this.tick();
    return mapRowToJob(row);
  }

  async findById(id: string): Promise<ScrapingJob | undefined> {
    const query = await this.postgresService.query<ScrapingJobRow>(
      `
      SELECT id, task, payload, status, provider, result, error, created_at, updated_at
      FROM scraping_jobs
      WHERE id = $1
      `,
      [id],
    );

    const [row] = query.rows;
    if (!row) {
      return undefined;
    }

    return mapRowToJob(row);
  }

  private startPolling() {
    this.timer = setInterval(() => {
      this.tick();
    }, this.pollIntervalMs);
    this.timer.unref?.();
    this.tick();
  }

  private tick() {
    if (this.shuttingDown) {
      return;
    }

    while (this.activeWorkers < this.maxWorkers) {
      this.activeWorkers += 1;
      void this.processNext().finally(() => {
        this.activeWorkers -= 1;
      });
    }
  }

  private async processNext(): Promise<void> {
    const claimed = await this.claimNextQueuedJob();
    if (!claimed) {
      return;
    }

    try {
      const result = await this.runClaimedJob(claimed.id, claimed.task, claimed.payload);
      const provider = extractProvider(result);
      const current = await this.postgresService.query<{ result: unknown | null }>(
        `
        SELECT result
        FROM scraping_jobs
        WHERE id = $1
        `,
        [claimed.id],
      );
      const finalResult = mergeJobResultWithProgress(result, current.rows[0]?.result);
      await this.postgresService.query(
        `
        UPDATE scraping_jobs
        SET status = 'done',
            provider = $2,
            result = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
        `,
        [claimed.id, provider, JSON.stringify(finalResult)],
      );
    } catch (error) {
      await this.postgresService.query(
        `
        UPDATE scraping_jobs
        SET status = 'failed',
            error = $2,
            updated_at = NOW()
        WHERE id = $1
        `,
        [claimed.id, error instanceof Error ? error.message : 'Unknown error'],
      );
      this.logger.warn(`Job ${claimed.id} falló: ${error instanceof Error ? error.message : String(error)}`);
    }

    this.tick();
  }

  private async runClaimedJob(jobId: string, task: ScrapingTask, payload: ScrapingOperationPayload): Promise<unknown> {
    if (task === 'catalog-run') {
      return this.catalogScrapingService.scrapeCatalogWithPrices(payload as CatalogScrapeRequestDto, async (progress) => {
        await this.updateProcessingProgress(jobId, progress);
      });
    }

    const providerOverride = typeof payload.providerOverride === 'string' ? payload.providerOverride : undefined;
    const normalizedPayload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'providerOverride'));
    return this.scrapingService.runTask(task, normalizedPayload, providerOverride);
  }

  private async updateProcessingProgress(jobId: string, progress: CatalogSiteProgress): Promise<void> {
    const current = await this.postgresService.query<{ result: unknown | null }>(
      `
      SELECT result
      FROM scraping_jobs
      WHERE id = $1
      `,
      [jobId],
    );

    const sites = normalizeProgressSites(current.rows[0]?.result);
    sites.set(progress.site, progress);

    await this.postgresService.query(
      `
      UPDATE scraping_jobs
      SET result = $2::jsonb,
          updated_at = NOW()
      WHERE id = $1
      `,
      [jobId, JSON.stringify({ progress: { sites: serializeProgressSites(sites) } })],
    );
  }

  private async claimNextQueuedJob(): Promise<ScrapingJob | undefined> {
    await this.postgresService.query('BEGIN');
    try {
      const selected = await this.postgresService.query<ScrapingJobRow>(
        `
        SELECT id, task, payload, status, provider, result, error, created_at, updated_at
        FROM scraping_jobs
        WHERE status = 'queued'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        `,
      );

      if (selected.rows.length === 0) {
        await this.postgresService.query('COMMIT');
        return undefined;
      }

      const [selectedRow] = selected.rows;
      const updated = await this.postgresService.query<ScrapingJobRow>(
        `
        UPDATE scraping_jobs
        SET status = 'processing',
            updated_at = NOW()
        WHERE id = $1
        RETURNING id, task, payload, status, provider, result, error, created_at, updated_at
        `,
        [selectedRow.id],
      );

      await this.postgresService.query('COMMIT');
      const [updatedRow] = updated.rows;
      return mapRowToJob(updatedRow);
    } catch (error) {
      await this.postgresService.query('ROLLBACK');
      throw error;
    }
  }
}

function mapRowToJob(row: ScrapingJobRow): ScrapingJob {
  return {
    id: row.id,
    task: row.task,
    payload: row.payload,
    status: row.status,
    provider: row.provider ?? undefined,
    summary: buildJobSummary(row.result),
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampNumber(raw: string | undefined, min: number, max: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, value));
}

function extractProvider(result: unknown): string | null {
  if (typeof result !== 'object' || !result) {
    return null;
  }

  const provider = (result as { provider?: unknown }).provider;
  return typeof provider === 'string' ? provider : null;
}

function normalizeProgressSites(result: unknown): Map<string, CatalogSiteProgress> {
  const sites = new Map<string, CatalogSiteProgress>();

  if (typeof result !== 'object' || !result) {
    return sites;
  }

  const progress = (result as { progress?: unknown }).progress;
  if (typeof progress !== 'object' || !progress) {
    return sites;
  }

  const rawSites = (progress as { sites?: unknown[] }).sites;
  if (!Array.isArray(rawSites)) {
    return sites;
  }

  for (const entry of rawSites) {
    if (entry && typeof entry === 'object' && typeof (entry as CatalogSiteProgress).site === 'string') {
      const progressEntry = entry as CatalogSiteProgress;
      sites.set(progressEntry.site, progressEntry);
    }
  }

  return sites;
}

function mergeJobResultWithProgress(result: unknown, existingResult: unknown): unknown {
  const mergedSites = normalizeProgressSites(existingResult);

  if (typeof result !== 'object' || !result) {
    return mergedSites.size > 0 ? { progress: { sites: serializeProgressSites(mergedSites) } } : result;
  }

  const current = result as Record<string, unknown>;
  const currentSites = normalizeProgressSites(current.progress);

  for (const [site, progress] of currentSites) {
    mergedSites.set(site, progress);
  }

  return {
    ...current,
    progress: {
      sites: serializeProgressSites(mergedSites),
    },
  };
}

function serializeProgressSites(sites: Map<string, CatalogSiteProgress>): CatalogSiteProgress[] {
  return Array.from(sites.values()).sort((left, right) => left.site.localeCompare(right.site));
}

function buildJobSummary(result: unknown): ScrapingJobSummary | undefined {
  if (typeof result !== 'object' || !result) {
    return undefined;
  }

  const current = result as {
    runId?: unknown;
    requestedAt?: unknown;
    strategy?: unknown;
    sitesProcessed?: unknown;
    inventorySize?: unknown;
    progress?: unknown;
  };
  const progress = current.progress && typeof current.progress === 'object'
    ? (current.progress as { sites?: unknown[] })
    : undefined;
  const rawSites = progress?.sites;
  const sites = Array.isArray(rawSites)
    ? rawSites.filter((entry): entry is CatalogSiteProgress => Boolean(entry) && typeof entry === 'object' && typeof (entry as CatalogSiteProgress).site === 'string')
    : [];
  const lastSite = [...sites].reverse().find((site: CatalogSiteProgress) => site.lastScrapedProduct);

  return {
    currentSite: lastSite?.site,
    stage: lastSite?.stage,
    quantityScrapped: typeof lastSite?.quantityScrapped === 'number' ? lastSite.quantityScrapped : undefined,
    timeWorkingMs: typeof lastSite?.timeWorkingMs === 'number' ? lastSite.timeWorkingMs : undefined,
    lastScrapedProduct: lastSite?.lastScrapedProduct,
    progress: sites.length > 0 ? { sites } : undefined,
  };
}
