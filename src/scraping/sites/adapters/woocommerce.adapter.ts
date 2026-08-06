import { BaseCatalogAdapter } from './base.adapter';

export class WooCommerceAdapter extends BaseCatalogAdapter {
  readonly platform = 'woocommerce' as const;
}
