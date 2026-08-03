import { canonicalizeYaguaronProductUrl } from './yaguaron';

export interface YaguaronListingProgress {
  discovered: number;
  newInListing: number;
  uniqueInListing: number;
  reachedDeclaredTotal: boolean;
  noNewInThisListing: boolean;
}

export function addYaguaronListingProducts(
  found: string[],
  listingProducts: Set<string>,
  globalProducts: Set<string>,
  declaredTotal?: number,
): YaguaronListingProgress {
  const beforeListingCount = listingProducts.size;

  for (const url of found) {
    const canonical = canonicalizeYaguaronProductUrl(url) ?? url;
    listingProducts.add(canonical);
    globalProducts.add(canonical);
  }

  return {
    discovered: found.length,
    newInListing: listingProducts.size - beforeListingCount,
    uniqueInListing: listingProducts.size,
    reachedDeclaredTotal: Boolean(declaredTotal && listingProducts.size >= declaredTotal),
    noNewInThisListing: listingProducts.size === beforeListingCount,
  };
}
