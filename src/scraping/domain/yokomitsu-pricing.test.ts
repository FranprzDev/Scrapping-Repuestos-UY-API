import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { verifiedYokomitsuDetailProduct, normalizeYokomitsuCostPrice } from './yokomitsu-pricing';

const url = 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/demo/41049/item';
const detail = (sku: string, panel: string) =>
  '<div class="producto-info"><span id="code-product">' + sku + '</span>' +
  '<div id="prices-product">' + panel + '</div></div>';

test('five supplier costs include VAT exactly once', () => {
  const cases: Array<[string,string,string]> = [
    ['7170623001', '$1.261', '1538.42'],
    ['7149803002', '$3.137', '3827.14'],
    ['8170625070', '$703', '857.66'],
    ['7183011201', '$1.237', '1509.14'],
    ['7174571313', '$682', '832.04'],
  ];
  for (const [sku, amount, expected] of cases) {
    const panel = '<div class="precio-oferta"><span class="ticket2">-38%</span><h2>' +
      amount + ' <span><del>$9.999</del></span></h2></div><span>+IVA</span>';
    assert.deepEqual(verifiedYokomitsuDetailProduct(detail(sku, panel), url, sku), { sku, price: expected });
  }
});

test('without +IVA the final price is not charged VAT twice', () => {
  assert.equal(verifiedYokomitsuDetailProduct(detail('7174571313','<h3>$832,04</h3>'),url,'7174571313')?.price,'832.04');
  assert.equal(normalizeYokomitsuCostPrice('$U 1.261,50 +IVA'),'1539.03');
});

test('unverified headings and mismatched SKU do not supply a price', () => {
  assert.equal(verifiedYokomitsuDetailProduct(detail('SKU-1','<div class="ticket2">-38%</div>'),url,'SKU-1'),undefined);
  assert.equal(verifiedYokomitsuDetailProduct(detail('SKU-1','<h3>$682</h3>'),url,'SKU-2'),undefined);
  assert.equal(verifiedYokomitsuDetailProduct(detail('SKU-1','<h3>US$682</h3>'),url,'SKU-1'),undefined);
  assert.equal(verifiedYokomitsuDetailProduct(detail('SKU-1','<h3>$0</h3>'),url,'SKU-1'),undefined);
  assert.equal(verifiedYokomitsuDetailProduct(detail('SKU-1','<h3>$682</h3>'),'https://example.com/v2/producto-detalle/x','SKU-1'),undefined);
  assert.equal(verifiedYokomitsuDetailProduct('<article data-codprod="OTHER"></article><div id="prices-product"><h3>$682</h3></div>',url,null),undefined);
  assert.equal(verifiedYokomitsuDetailProduct(detail('SKU-1','<h3>$682</h3>') + detail('SKU-1','<h3>$682</h3>'),url,'SKU-1'),undefined);
});

test('discount and old crossed price cannot override current price', () => {
  const html = '<article class="producto-detalle" data-codprod="7183011201"><p>Precio: $38</p></article>' +
    '<div id="prices-product"><div class="precio-oferta"><span class="ticket2">-38%</span>' +
    '<h2>$1.237 <span>$1.989</span></h2></div><span>+IVA</span></div>';
  assert.equal(verifiedYokomitsuDetailProduct(html,url,'7183011201')?.price,'1509.14');
  assert.equal(verifiedYokomitsuDetailProduct(html.replace('prices-product','misc'),url,'7183011201'),undefined);
});
