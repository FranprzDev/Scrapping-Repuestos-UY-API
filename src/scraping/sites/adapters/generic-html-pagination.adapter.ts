import { BaseCatalogAdapter } from './base.adapter';

export class GenericHtmlPaginationAdapter extends BaseCatalogAdapter {
  readonly platform = 'generic-html' as const;
}
