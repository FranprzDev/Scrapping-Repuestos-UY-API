import { Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CatalogScrapeRequestDto, SingleSiteCatalogScrapeRequestDto } from './dto/catalog-request.dto';
import { CrawlRequestDto, DomainProviderConfigDto, ExtractRequestDto, JobIdParamDto, ScrapeRequestDto } from './dto/scrape-request.dto';
import { JobQueueService } from './jobs/job.queue';
import { CatalogScrapingService } from './catalog-scraping.service';
import { ScrapingService } from './scraping.service';

@Controller()
export class ScrapingController {
  constructor(
    @Inject(ScrapingService)
    private readonly scrapingService: ScrapingService,
    @Inject(JobQueueService)
    private readonly jobQueueService: JobQueueService,
    @Inject(CatalogScrapingService)
    private readonly catalogScrapingService: CatalogScrapingService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  home() {
    return renderInventoryPage();
  }

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'Scrapping-Repuestos-UY-API',
      mode: 'hybrid-provider',
    };
  }

  @Post('scraping/scrape')
  async scrape(@Body() payload: ScrapeRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('scrape', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.scrape(payload, config.provider);
  }

  @Post('scraping/crawl')
  async crawl(@Body() payload: CrawlRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('crawl', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.crawl(payload, config.provider);
  }

  @Post('scraping/extract')
  async extract(@Body() payload: ExtractRequestDto, @Query() config: DomainProviderConfigDto) {
    if (config.async === 'true') {
      return this.jobQueueService.enqueue('extract', {
        ...payload,
        providerOverride: config.provider,
      });
    }

    return this.scrapingService.extract(payload, config.provider);
  }

  @Post('scraping/catalog/run')
  runCatalog(@Body() payload: CatalogScrapeRequestDto) {
    return this.catalogScrapingService.scrapeCatalogWithPrices(payload);
  }

  @Post('scraping/quick-run')
  quickRunSingleSite(@Body() payload: SingleSiteCatalogScrapeRequestDto) {
    return this.catalogScrapingService.scrapeSingleSiteAndReturnInventory(payload);
  }

  @Post('start-scrapping-uy')
  startScrappingUy(@Body() payload: CatalogScrapeRequestDto) {
    return this.catalogScrapingService.startScrappingUy(payload);
  }

  @Get('scraping/inventory')
  getInventory(@Query('site') site?: string) {
    return this.catalogScrapingService.getCurrentInventory(site);
  }

  @Get('scraping/runs')
  listRuns(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    const normalized = Number.isFinite(parsed) ? parsed : undefined;
    return this.catalogScrapingService.listRuns(normalized);
  }

  @Get('scraping/runs/:runId')
  async getRunById(@Param('runId') runId: string) {
    const run = await this.catalogScrapingService.getRunById(runId);
    if (!run) {
      throw new NotFoundException('Run no encontrado');
    }

    return run;
  }

  @Get('scraping/jobs/:id')
  async getJob(@Param() params: JobIdParamDto) {
    const job = await this.jobQueueService.findById(params.id);

    if (!job) {
      throw new NotFoundException('Job no encontrado');
    }

    return job;
  }
}

function renderInventoryPage(): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Scrapping Repuestos UY</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1220;
      --panel: #111827;
      --panel-soft: #0f172a;
      --text: #e5e7eb;
      --muted: #94a3b8;
      --line: #243041;
      --accent: #4f8cff;
      --accent-soft: #172554;
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .wrap {
      max-width: 1600px;
      margin: 0 auto;
      padding: 24px;
    }
    .layout {
      display: flex;
      gap: 18px;
      align-items: flex-start;
    }
    .sidebar {
      width: 360px;
      flex: 0 0 360px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .content {
      flex: 1 1 auto;
      min-width: 0;
    }
    .sidebar-card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .title-block {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 18px 16px;
    }
    h1 {
      font-size: 22px;
      margin: 0 0 8px;
    }
    button, select, input {
      font: inherit;
    }
    button {
      border: 1px solid var(--accent);
      background: var(--accent);
      color: white;
      padding: 10px 14px;
      border-radius: 8px;
      cursor: pointer;
      width: 100%;
    }
    button.secondary {
      background: var(--panel-soft);
      color: var(--text);
      border-color: var(--line);
    }
    input, select {
      border: 1px solid var(--line);
      background: var(--panel-soft);
      color: var(--text);
      border-radius: 8px;
      padding: 12px 14px;
      min-width: 0;
      width: 100%;
    }
    input {
      font-size: 16px;
      font-weight: 600;
      height: 48px;
      box-shadow: 0 1px 0 rgba(22, 32, 42, 0.02) inset;
    }
    .meta {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 14px;
    }
    .field-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: -4px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
      position: relative;
    }
    .table-wrap {
      overflow: auto;
      max-height: calc(100vh - 190px);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    thead th {
      position: sticky;
      top: 0;
      background: #0f172a;
      border-bottom: 1px solid var(--line);
      text-align: left;
      padding: 12px;
      white-space: nowrap;
      z-index: 1;
    }
    tbody td {
      padding: 12px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
    }
    tbody tr:hover {
      background: #162033;
    }
    .name {
      font-weight: 600;
      color: var(--text);
      text-decoration: none;
    }
    .name:hover {
      text-decoration: underline;
    }
    .product-cell {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .product-title {
      font-weight: 600;
      color: var(--text);
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    .product-title:hover {
      text-decoration: underline;
    }
    .site-line {
      color: var(--muted);
      font-size: 12px;
    }
    .muted {
      color: var(--muted);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
    }
    .empty {
      padding: 40px;
      text-align: center;
      color: var(--muted);
    }
    .right {
      text-align: right;
      white-space: nowrap;
    }
    .source {
      color: var(--muted);
      word-break: break-word;
      max-width: 360px;
    }
    .error {
      color: #fca5a5;
    }
    .loader {
      position: absolute;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: rgba(11, 18, 32, 0.72);
      backdrop-filter: blur(2px);
      z-index: 2;
    }
    .loader.is-visible {
      display: flex;
    }
    .loader-card {
      display: flex;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 10px;
      padding: 14px 16px;
      min-width: 240px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
    }
    .loader-spinner {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2px solid var(--line);
      border-top-color: var(--accent);
      animation: spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    .loader-text {
      color: var(--text);
      font-size: 14px;
      font-weight: 600;
    }
    .skeleton {
      position: relative;
      overflow: hidden;
      background: #162033;
      border-radius: 6px;
      min-height: 14px;
    }
    .skeleton::after {
      content: '';
      position: absolute;
      inset: 0;
      transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
      animation: shimmer 1.1s infinite;
    }
    .skeleton.name { height: 16px; width: 78%; }
    .skeleton.sub { height: 12px; width: 42%; margin-top: 8px; }
    .skeleton.price { height: 14px; width: 62px; margin-left: auto; }
    .skeleton.small { height: 12px; width: 70px; }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes shimmer {
      100% { transform: translateX(100%); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="layout">
      <aside class="sidebar">
        <div class="title-block">
          <h1>Scrapping Repuestos UY</h1>
          <div class="meta">
            <span id="status">Listo</span>
            <span id="count">0 productos</span>
            <span id="updated">Sin actualizar</span>
          </div>
        </div>
        <div class="sidebar-card">
          <div class="field-label">Buscar productos</div>
          <input id="search" placeholder="Nombre, SKU o marca" />
          <select id="siteFilter">
            <option value="">Todos los sitios</option>
          </select>
          <button id="refresh">Actualizar inventario</button>
        </div>
      </aside>

      <main class="content">
        <div class="panel">
          <div id="loader" class="loader" aria-live="polite" aria-busy="true">
            <div class="loader-card">
              <div class="loader-spinner"></div>
              <div class="loader-text">Cargando inventario</div>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Producto</th>
              <th>Precio (UYU)</th>
              <th>SKU</th>
              <th>Stock</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody id="rows">
                <tr><td colspan="5" class="empty">Cargando inventario...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  </div>

  <script>
    const state = {
      products: [],
      filtered: [],
      site: '',
    };

    const rows = document.getElementById('rows');
    const search = document.getElementById('search');
    const siteFilter = document.getElementById('siteFilter');
    const status = document.getElementById('status');
    const count = document.getElementById('count');
    const updated = document.getElementById('updated');
    const loader = document.getElementById('loader');

    document.getElementById('refresh').addEventListener('click', () => loadInventory());

    search.addEventListener('input', applyFilters);
    siteFilter.addEventListener('change', () => {
      state.site = siteFilter.value;
      applyFilters();
      renderSiteOptions();
    });

    function setStatus(text, isError = false) {
      status.textContent = text;
      status.className = isError ? 'error' : '';
    }

    function showLoader() {
      loader.classList.add('is-visible');
      rows.innerHTML = renderSkeletonRows();
    }

    function hideLoader() {
      loader.classList.remove('is-visible');
    }

    function normalize(value) {
      return String(value ?? '').toLowerCase();
    }

    function applyFilters() {
      const term = normalize(search.value).trim();
      state.filtered = state.products.filter((product) => {
        if (state.site && normalize(product.site) !== normalize(state.site)) {
          return false;
        }
        if (!term) {
          return true;
        }
        const haystack = [
          product.productName,
          product.sku,
          product.brand,
          product.category,
          product.site,
        ].map(normalize).join(' ');
        return haystack.includes(term);
      });
      renderRows();
      count.textContent = state.filtered.length + ' productos';
    }

    function renderSiteOptions() {
      const sites = Array.from(new Set(state.products.map((product) => product.site).filter(Boolean))).sort();
      const current = siteFilter.value;
      siteFilter.innerHTML = '<option value="">Todos los sitios</option>' + sites.map((site) => '<option value="' + escapeHtml(site) + '">' + escapeHtml(site) + '</option>').join('');
      siteFilter.value = current;
    }

    function renderRows() {
      if (!state.filtered.length) {
        rows.innerHTML = '<tr><td colspan="5" class="empty">No hay productos para mostrar</td></tr>';
        return;
      }

      rows.innerHTML = state.filtered.map((product) => {
        const productName = escapeHtml(product.productName || 'Sin nombre');
        const url = product.sourceUrl ? '<a class="product-title" href="' + escapeAttr(product.sourceUrl) + '" target="_blank" rel="noreferrer">' + productName + '</a>' : '<span class="product-title">' + productName + '</span>';
        const priceCurrency = String(product.currency || '').trim().toUpperCase();
        const priceSuffix = priceCurrency && priceCurrency !== 'UYU' && priceCurrency !== 'UY$' && priceCurrency !== 'UY' ? ' <span class="muted">(' + escapeHtml(priceCurrency) + ')</span>' : '';
        return '<tr>' +
          '<td><div class="product-cell">' + url + (product.brand ? '<div class="muted">' + escapeHtml(product.brand) + '</div>' : '') + '</div></td>' +
          '<td class="right">' + escapeHtml(product.price || '-') + priceSuffix + '</td>' +
          '<td>' + escapeHtml(product.sku || '-') + '</td>' +
          '<td>' + escapeHtml(product.stock || '-') + '</td>' +
          '<td>' + escapeHtml(formatAvailability(product.availability)) + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderSkeletonRows() {
      return Array.from({ length: 7 }).map(() => (
        '<tr>' +
          '<td><div class="skeleton name"></div><div class="skeleton sub"></div></td>' +
          '<td class="right"><div class="skeleton price"></div></td>' +
          '<td><div class="skeleton small"></div></td>' +
          '<td><div class="skeleton small"></div></td>' +
          '<td><div class="skeleton small"></div></td>' +
        '</tr>'
      )).join('');
    }

    function formatAvailability(value) {
      const text = String(value ?? '').trim().toLowerCase();
      if (text === 'in_stock' || text === 'in stock' || text === 'available' || text === 'available now') {
        return 'en stock';
      }
      if (text === 'out_of_stock' || text === 'out of stock' || text === 'unavailable') {
        return 'sin stock';
      }
      if (text === 'unknown') {
        return 'desconocido';
      }
      return text ? text.replaceAll('_', ' ') : '-';
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function escapeAttr(value) {
      return escapeHtml(value).replaceAll('\`', '&#96;');
    }

    async function loadInventory() {
      setStatus('Cargando inventario...');
      showLoader();
      try {
        const url = state.site ? '/scraping/inventory?site=' + encodeURIComponent(state.site) : '/scraping/inventory';
        const response = await fetch(url);
        if (!response.ok) throw new Error('No se pudo leer el inventario');
        const data = await response.json();
        state.products = Array.isArray(data.products) ? data.products : [];
        renderSiteOptions();
        applyFilters();
        updated.textContent = data.total + ' productos totales';
        setStatus('Inventario cargado');
      } catch (error) {
        rows.innerHTML = '<tr><td colspan="5" class="empty error">' + escapeHtml(error.message || 'Error al cargar inventario') + '</td></tr>';
        setStatus(error.message || 'Error al cargar inventario', true);
      } finally {
        hideLoader();
      }
    }

    loadInventory();
  </script>
</body>
</html>`;
}
