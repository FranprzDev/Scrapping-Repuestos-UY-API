import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogSite } from './catalog-sites';

test('Container uses its ASP.NET catalog routes and page parameter', () => {
  const site = getCatalogSite('container');

  assert.ok(site);
  assert.equal(site.enabled, true);
  assert.equal(site.platform, 'generic-html');
  assert.deepEqual(site.paginationStrategy, {
    type: 'page-param',
    param: 'page',
    start: 1,
    maxPages: 1100,
  });
  assert.ok(site.productUrlPatterns.some((pattern) => pattern.test(
    'https://container.com.uy/Home/SearchById?filter=RL13HC-RC52LS',
  )));
  assert.ok(site.categoryUrlPatterns.some((pattern) => pattern.test(
    'https://container.com.uy/Home/Index?page=2&filter=&familia=&modelo=',
  )));
});
