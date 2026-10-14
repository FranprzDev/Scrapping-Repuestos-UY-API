import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { verifiedDetailPrice, verifiedDetailProduct } from './yokomitsu-price-recovery.cli';
const ck = 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/ck/40578/amortiguador';
const vitara = 'https://www.yokomitsuparts.com.uy/v2/producto-detalle/grand-vitara/52286/amortiguador';
const card = (sku: string, panel: string) => '<html><body><article class="producto-detalle" data-codprod="' + sku + '"><h1>AMORTIGUADOR</h1></article><div id="prices-product">' + panel + '</div></body></html>';
test('offer discount badge, crossed price and +IVA', () => {
  const html = card('7183011201','<div class="precio-oferta"><div class="ticket2">-38%</div><h2>$1.237 <span>$1.989</span></h2></div><span>+IVA</span>');
  assert.equal(verifiedDetailPrice(html, ck, '7183011201'), '1509.14');
});
test('regular detail price includes IVA', () => {
  assert.equal(verifiedDetailPrice(card('7174571313','<h3>$682</h3><span>+IVA</span>'), vitara, '7174571313'), '832.04');
});
test('reject wrong product SKU and discount-only', () => {
  assert.equal(verifiedDetailPrice(card('OTHER','<h3>$682</h3><span>+IVA</span>'), vitara, '7174571313'), undefined);
  assert.equal(verifiedDetailPrice(card('7174571313','<div class="ticket2">-38%</div>'), vitara, '7174571313'), undefined);
});
test('reject non-supplier URLs and missing price panels', () => {
  assert.equal(verifiedDetailPrice(card('7174571313','<h3>$682</h3>'), 'https://attacker.example/v2/producto-detalle/1', '7174571313'), undefined);
  assert.equal(verifiedDetailPrice('<html><body><h2>$682</h2></body></html>', vitara, '7174571313'), undefined);
});
test('no IVA marker means final price', () => {
  assert.equal(verifiedDetailPrice(card('7174571313','<h3>$832.04</h3>'), vitara,'7174571313'), '832.04');
});

test('recovers missing SKU from detail page and verifies final price', () => {
  const html = card('7183011201','<div class="precio-oferta"><div class="ticket2">-38%</div><h2>$1.237 <span>$1.989</span></h2></div><span>+IVA</span>');
  assert.equal(verifiedDetailProduct(html, ck, null), undefined);
  const withDetailCode = html.replace('<div id="prices-product">', '<div class="producto-info"><span id="code-product">7183011201</span><div id="prices-product">');
  assert.deepEqual(verifiedDetailProduct(withDetailCode, ck, null), { sku: '7183011201', price: '1509.14' });
});
test('recovers missing SKU from #code-product in real Yokomitsu layout', () => {
  const html = '<div class="producto-info"><h4>AMORTIGUADOR</h4><span id="code-product">7174571313</span><div id="prices-product"><h3>$682</h3><span>+IVA</span></div></div>';
  assert.deepEqual(verifiedDetailProduct(html, vitara, null), { sku: '7174571313', price: '832.04' });
});
test('does not invent missing SKU or take unrelated card code', () => {
  assert.equal(verifiedDetailProduct('<div id="prices-product"><h3>$682</h3></div>', vitara, null), undefined);
  assert.equal(verifiedDetailProduct(card('OTHER','<h3>$682</h3>'), vitara, '7174571313'), undefined);
});
