export function canonicalSiteKey(site: string): string {
  try {
    const url = new URL(site);
    const hostname = url.hostname.replace(/^www\./, '');
    const pathname = stripTrailingPagination(url.pathname);
    const normalizedPath = pathname.replace(/^\/+|\/+$/g, '');

    if (!normalizedPath) {
      return hostname;
    }

    return `${hostname}_${slugify(normalizedPath)}`;
  } catch {
    return slugify(site) || 'unknown-site';
  }
}

function stripTrailingPagination(pathname: string): string {
  return pathname.replace(/\/page-\d+\/?$/i, '/').replace(/\/+$/g, '/');
}

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
