import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface CatalogQueueOptions {
  globalConcurrency?: number;
  perDomainConcurrency?: number;
  requestDelayMs?: number;
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  progressPath?: string;
  signal?: AbortSignal;
}

export interface CatalogQueueProgress {
  completed: string[];
  failed: Array<{ key: string; message: string }>;
}

export interface QueueTask<T> {
  key: string;
  domain: string;
  run: (attempt: number) => Promise<T>;
}

export class CatalogRequestQueue {
  private readonly globalConcurrency: number;
  private readonly perDomainConcurrency: number;
  private readonly requestDelayMs: number;
  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly progressPath?: string;
  private readonly signal?: AbortSignal;
  private progress: CatalogQueueProgress = { completed: [], failed: [] };
  private readonly activeByDomain = new Map<string, number>();
  private readonly lastStartedByDomain = new Map<string, number>();

  constructor(options: CatalogQueueOptions = {}) {
    this.globalConcurrency = clamp(options.globalConcurrency ?? Number(process.env.CATALOG_QUEUE_GLOBAL_MAX ?? 8), 1, 100);
    this.perDomainConcurrency = clamp(options.perDomainConcurrency ?? Number(process.env.CATALOG_QUEUE_DOMAIN_MAX ?? 2), 1, 20);
    this.requestDelayMs = Math.max(0, options.requestDelayMs ?? 0);
    this.retryAttempts = clamp(options.retryAttempts ?? 2, 0, 10);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 500);
    this.progressPath = options.progressPath;
    this.signal = options.signal;
  }

  async run<T>(tasks: Array<QueueTask<T>>): Promise<T[]> {
    await this.loadProgress();
    const pending = tasks.filter((task) => !this.progress.completed.includes(task.key));
    const results: T[] = [];
    let cursor = 0;

    const workers = Array.from({ length: Math.min(this.globalConcurrency, pending.length) }, async () => {
      while (cursor < pending.length) {
        this.throwIfCancelled();
        const task = pending[cursor];
        cursor += 1;
        results.push(await this.runWhenDomainAvailable(task));
      }
    });

    await Promise.all(workers);
    return results;
  }

  getProgress(): CatalogQueueProgress {
    return {
      completed: [...this.progress.completed],
      failed: [...this.progress.failed],
    };
  }

  private async runWhenDomainAvailable<T>(task: QueueTask<T>): Promise<T> {
    while ((this.activeByDomain.get(task.domain) ?? 0) >= this.perDomainConcurrency) {
      this.throwIfCancelled();
      await sleep(10);
    }

    this.activeByDomain.set(task.domain, (this.activeByDomain.get(task.domain) ?? 0) + 1);
    try {
      await this.waitForDomainDelay(task.domain);
      const result = await this.runWithRetries(task);
      this.progress.completed.push(task.key);
      await this.saveProgress();
      return result;
    } finally {
      this.activeByDomain.set(task.domain, Math.max(0, (this.activeByDomain.get(task.domain) ?? 1) - 1));
    }
  }

  private async runWithRetries<T>(task: QueueTask<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.retryAttempts + 1; attempt += 1) {
      this.throwIfCancelled();
      try {
        return await task.run(attempt);
      } catch (error) {
        lastError = error;
        if (attempt > this.retryAttempts || !isRetryable(error)) {
          const message = error instanceof Error ? error.message : String(error);
          this.progress.failed.push({ key: task.key, message });
          await this.saveProgress();
          throw error;
        }
        await sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw lastError;
  }

  private async waitForDomainDelay(domain: string): Promise<void> {
    const elapsed = Date.now() - (this.lastStartedByDomain.get(domain) ?? 0);
    if (elapsed < this.requestDelayMs) {
      await sleep(this.requestDelayMs - elapsed);
    }
    this.lastStartedByDomain.set(domain, Date.now());
  }

  private async loadProgress(): Promise<void> {
    if (!this.progressPath) {
      return;
    }
    try {
      this.progress = JSON.parse(await readFile(this.progressPath, 'utf8')) as CatalogQueueProgress;
    } catch {
      this.progress = { completed: [], failed: [] };
    }
  }

  private async saveProgress(): Promise<void> {
    if (!this.progressPath) {
      return;
    }
    await mkdir(path.dirname(this.progressPath), { recursive: true });
    await writeFile(this.progressPath, `${JSON.stringify(this.progress, null, 2)}\n`);
  }

  private throwIfCancelled(): void {
    if (this.signal?.aborted) {
      throw new Error('Catalog queue cancelled');
    }
  }
}

function isRetryable(error: unknown): boolean {
  const status = typeof error === 'object' && error ? Number((error as { statusCode?: unknown }).statusCode) : NaN;
  const message = error instanceof Error ? error.message : String(error);
  return status === 429 || status >= 500 || /\b(?:429|5\d\d)\b/.test(message);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? Math.trunc(value) : min));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
