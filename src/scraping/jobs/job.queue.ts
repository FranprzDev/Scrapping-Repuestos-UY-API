import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProviderResult, ScrapingOperationPayload, ScrapingTask } from '../interfaces/scraping.types';
import { ScrapingService } from '../scraping.service';

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

@Injectable()
export class JobQueueService {
  private readonly jobs = new Map<string, ScrapingJob>();

  constructor(private readonly scrapingService: ScrapingService) {}

  enqueue(task: ScrapingTask, payload: ScrapingOperationPayload): ScrapingJob {
    const id = randomUUID();
    const now = new Date().toISOString();

    const job: ScrapingJob = {
      id,
      task,
      payload,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, job);
    void this.process(job.id);
    return job;
  }

  findById(id: string): ScrapingJob | undefined {
    return this.jobs.get(id);
  }

  private async process(id: string) {
    const job = this.jobs.get(id);
    if (!job) {
      return;
    }

    job.status = 'processing';
    job.updatedAt = new Date().toISOString();

    try {
      const providerOverride = typeof job.payload.providerOverride === 'string' ? job.payload.providerOverride : undefined;
      const payload = Object.fromEntries(Object.entries(job.payload).filter(([key]) => key !== 'providerOverride'));
      const result = await this.scrapingService.runTask(job.task, payload, providerOverride);

      job.status = 'done';
      job.result = result;
      job.provider = result.provider;
      job.updatedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      job.updatedAt = new Date().toISOString();
    }
  }
}
