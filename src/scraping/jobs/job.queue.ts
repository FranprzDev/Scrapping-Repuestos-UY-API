import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProviderResult, ScrapingOperationPayload, ScrapingTask } from '../interfaces/scraping.types';
import { ScrapingService } from '../scraping.service';
import { PostgresService } from './postgres.service';

export type JobStatus = 'queued' | 'processing' | 'done' | 'failed';

export interface ScrapingJob {
  id: string;
  task: ScrapingTask;
  payload: ScrapingOperationPayload;
  status: JobStatus;
  provider?: string;
  result?: ProviderResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

type ScrapingJobRow = {
  id: string;
  task: ScrapingTask;
  payload: ScrapingOperationPayload;
  status: JobStatus;
  provider: string | null;
  result: ProviderResult | null;
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
      const providerOverride = typeof claimed.payload.providerOverride === 'string' ? claimed.payload.providerOverride : undefined;
      const payload = Object.fromEntries(Object.entries(claimed.payload).filter(([key]) => key !== 'providerOverride'));
      const result = await this.scrapingService.runTask(claimed.task, payload, providerOverride);
      await this.postgresService.query(
        `
        UPDATE scraping_jobs
        SET status = 'done',
            provider = $2,
            result = $3::jsonb,
            updated_at = NOW()
        WHERE id = $1
        `,
        [claimed.id, result.provider, JSON.stringify(result)],
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
    result: row.result ?? undefined,
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
