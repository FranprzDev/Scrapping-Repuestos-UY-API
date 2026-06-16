export type CatalogJobSiteStage = 'queued' | 'discovering' | 'extracting' | 'saving' | 'done' | 'error';

export type CatalogJobSiteStatus = 'queued' | 'processing' | 'success' | 'error';

export interface CatalogJobSiteProgress {
  site: string;
  label: string;
  stage: CatalogJobSiteStage;
  status: CatalogJobSiteStatus;
  pagesUsedForExtract?: number;
  quantityScrapped?: number;
  rawProducts?: number;
  normalizedProducts?: number;
  message?: string;
  updatedAt: string;
}

export interface CatalogJobProgress {
  totalSites: number;
  completedSites: number;
  activeSite?: string;
  updatedAt: string;
  sites: CatalogJobSiteProgress[];
}

export interface CatalogJobProgressReporter {
  update(progress: CatalogJobProgress): Promise<void> | void;
}
