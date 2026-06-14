import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { JobQueueService } from './job.queue';

test('conserva el progreso por sitio dentro del resultado final del job', async () => {
  let claimedCalls = 0;
  let storedResult: unknown = null;
  const updates: Array<{ sql: string; params: unknown[] }> = [];

  const postgresService = {
    async ensureJobsTable() {},
    async query(sql: string, params: unknown[] = []) {
      if (/SELECT result\s+FROM scraping_jobs/i.test(sql)) {
        return {
          rows: [
            {
              result: storedResult,
            },
          ],
        } as never;
      }

      if (/UPDATE scraping_jobs\s+SET result = \$2::jsonb/i.test(sql)) {
        storedResult = JSON.parse(String(params[1]));
        updates.push({ sql, params });
        return { rows: [] } as never;
      }

      if (/UPDATE scraping_jobs\s+SET status = 'done'/i.test(sql)) {
        storedResult = JSON.parse(String(params[2]));
        updates.push({ sql, params });
        return { rows: [] } as never;
      }

      if (/BEGIN|COMMIT|ROLLBACK/i.test(sql)) {
        return { rows: [] } as never;
      }

      return { rows: [] } as never;
    },
  };

  const service = new JobQueueService(
    {} as never,
    {
      async scrapeCatalogWithPrices() {
        return {
          provider: 'http',
          runId: 'run-1',
          sitesProcessed: 1,
        };
      },
    } as never,
    postgresService as never,
  );

  (service as any).claimNextQueuedJob = async () => {
    claimedCalls += 1;
    if (claimedCalls > 1) {
      return undefined;
    }

    return {
      id: 'job-1',
      task: 'catalog-run',
      payload: { urls: ['https://feyvi.com.uy/'] },
    };
  };

  (service as any).runClaimedJob = async (jobId: string) => {
    await (service as any).updateProcessingProgress(jobId, {
      site: 'https://feyvi.com.uy/',
      url: 'https://feyvi.com.uy/',
      status: 'success',
      timeWorkingMs: 321,
      quantityScrapped: 7,
      pagesUsedForExtract: 4,
      rawProducts: 8,
      normalizedProducts: 7,
    });

    return {
      provider: 'http',
      runId: 'run-1',
      sitesProcessed: 1,
    };
  };

  await (service as any).processNext();

  assert.equal(updates.length >= 2, true);
  assert.deepEqual(storedResult, {
    provider: 'http',
    runId: 'run-1',
    sitesProcessed: 1,
    progress: {
      sites: [
        {
          site: 'https://feyvi.com.uy/',
          url: 'https://feyvi.com.uy/',
          status: 'success',
          timeWorkingMs: 321,
          quantityScrapped: 7,
          pagesUsedForExtract: 4,
          rawProducts: 8,
          normalizedProducts: 7,
        },
      ],
    },
  });
});
