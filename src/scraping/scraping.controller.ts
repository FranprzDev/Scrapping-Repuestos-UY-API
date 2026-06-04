import { Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { CatalogScrapeRequestDto, SingleSiteCatalogScrapeRequestDto } from './dto/catalog-request.dto';
import { CrawlRequestDto, DomainProviderConfigDto, ExtractRequestDto, JobIdParamDto, ScrapeRequestDto } from './dto/scrape-request.dto';
import { CatalogScrapingService } from './catalog-scraping.service';
import { JobQueueService } from './jobs/job.queue';
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

  @Post('scraping/inventory/refresh')
  refreshInventory() {
    return this.catalogScrapingService.refreshCatalogInventory();
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
    <meta name="color-scheme" content="dark" />
    <title>Inventario | Scrapping Repuestos UY</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
    <style>
      :root {
        --bg: #08090d;
        --panel: rgba(15, 17, 24, 0.92);
        --panel-strong: #10141d;
        --line: rgba(255, 255, 255, 0.08);
        --line-strong: rgba(255, 255, 255, 0.12);
        --text: #f6f1ea;
        --muted: rgba(246, 241, 234, 0.72);
        --accent: #f2b84b;
        --accent-2: #7fd7c4;
        --danger: #ff8b7a;
        --success: #87e0ad;
        --shadow: 0 28px 90px rgba(0, 0, 0, 0.52);
      }

      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        min-height: 100%;
      }
      body {
        font-family: 'Manrope', system-ui, sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 20% 10%, rgba(242, 184, 75, 0.18), transparent 28%),
          radial-gradient(circle at 85% 15%, rgba(127, 215, 196, 0.14), transparent 25%),
          radial-gradient(circle at 50% 95%, rgba(255, 139, 122, 0.08), transparent 26%),
          linear-gradient(160deg, #050609 0%, #080b12 56%, #0d111a 100%);
        overflow-x: hidden;
      }
      body::before {
        content: '';
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
        background-size: 56px 56px;
        mask-image: linear-gradient(to bottom, rgba(0,0,0,0.9), transparent 92%);
      }
      .shell {
        position: relative;
        min-height: 100vh;
        padding: 24px;
      }
      .panel {
        max-width: 1600px;
        margin: 0 auto;
        border: 1px solid var(--line);
        border-radius: 26px;
        overflow: hidden;
        background: linear-gradient(180deg, rgba(16, 20, 28, 0.96), rgba(8, 10, 15, 0.96));
        box-shadow: var(--shadow);
      }
      .topbar {
        padding: 24px 26px 20px;
        border-bottom: 1px solid var(--line);
        display: grid;
        gap: 16px;
        background:
          linear-gradient(135deg, rgba(242, 184, 75, 0.08), transparent 28%),
          linear-gradient(225deg, rgba(127, 215, 196, 0.08), transparent 24%);
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--accent-2);
        letter-spacing: 0.15em;
        text-transform: uppercase;
        font-size: 0.74rem;
        font-weight: 800;
      }
      .eyebrow::before {
        content: '';
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: var(--accent);
        box-shadow: 0 0 0 6px rgba(242, 184, 75, 0.12);
      }
      .title-row {
        display: flex;
        gap: 16px;
        align-items: end;
        justify-content: space-between;
        flex-wrap: wrap;
      }
      h1 {
        margin: 0;
        font-family: 'Fraunces', Georgia, serif;
        font-size: clamp(2.2rem, 4vw, 3.9rem);
        letter-spacing: -0.05em;
        line-height: 0.95;
      }
      .lede {
        margin: 0;
        max-width: 78ch;
        color: var(--muted);
        font-size: 1rem;
        line-height: 1.75;
      }
      .hero-stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
      }
      .hero-stat {
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(255,255,255,0.03);
        border: 1px solid rgba(255,255,255,0.06);
      }
      .hero-stat .label {
        display: block;
        margin-bottom: 10px;
        color: var(--muted);
        text-transform: uppercase;
        font-size: 0.74rem;
        letter-spacing: 0.12em;
      }
      .hero-stat .value {
        font-family: 'Fraunces', Georgia, serif;
        font-size: 1.4rem;
        letter-spacing: -0.03em;
        line-height: 1.1;
      }
      .content {
        display: grid;
        grid-template-columns: 320px minmax(0, 1fr);
        min-height: calc(100vh - 150px);
      }
      .sidebar {
        border-right: 1px solid var(--line);
        padding: 20px;
        background: rgba(255,255,255,0.015);
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .card {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 20px;
        padding: 16px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.02);
      }
      .card h2 {
        margin: 0 0 12px;
        font-size: 0.8rem;
        text-transform: uppercase;
        letter-spacing: 0.14em;
        color: var(--accent-2);
      }
      .field-label {
        display: block;
        margin: 0 0 8px;
        color: var(--muted);
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 0.12em;
      }
      input, select, button {
        font: inherit;
      }
      input, select {
        width: 100%;
        border: 1px solid var(--line-strong);
        background: var(--panel-strong);
        color: var(--text);
        border-radius: 14px;
        padding: 12px 14px;
        outline: none;
      }
      input::placeholder {
        color: rgba(246,241,234,0.42);
      }
      input:focus, select:focus {
        border-color: rgba(242,184,75,0.6);
        box-shadow: 0 0 0 3px rgba(242,184,75,0.12);
      }
      .buttons {
        display: grid;
        gap: 10px;
      }
      button {
        border: 1px solid transparent;
        border-radius: 14px;
        padding: 12px 14px;
        cursor: pointer;
        font-weight: 800;
        transition: transform 180ms ease, box-shadow 180ms ease, border-color 180ms ease;
      }
      button:hover { transform: translateY(-1px); }
      .primary {
        background: linear-gradient(135deg, var(--accent), #f8d58a);
        color: #1a1407;
        box-shadow: 0 16px 30px rgba(242,184,75,0.18);
      }
      .secondary {
        background: rgba(255,255,255,0.03);
        border-color: var(--line);
        color: var(--text);
      }
      .mini-note {
        color: var(--muted);
        font-size: 0.9rem;
        line-height: 1.65;
      }
      .site-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .site-pill {
        padding: 10px 12px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: rgba(255,255,255,0.03);
        color: var(--text);
        font-size: 0.92rem;
      }
      .site-pill.ok {
        border-color: rgba(127, 215, 196, 0.25);
      }
      .main {
        min-width: 0;
        padding: 20px;
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .table-card {
        position: relative;
        overflow: hidden;
      }
      .table-wrap {
        overflow: auto;
        max-height: calc(100vh - 260px);
      }
      table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.92rem;
      }
      thead th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: #111621;
        border-bottom: 1px solid var(--line);
        text-align: left;
        padding: 14px 12px;
        white-space: nowrap;
      }
      tbody td {
        padding: 12px;
        border-bottom: 1px solid rgba(255,255,255,0.06);
        vertical-align: top;
      }
      tbody tr:hover {
        background: rgba(255,255,255,0.03);
      }
      .product-cell {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }
      .product-title {
        font-weight: 700;
        color: var(--text);
        text-decoration: none;
        overflow-wrap: anywhere;
      }
      .product-title:hover {
        text-decoration: underline;
      }
      .muted { color: var(--muted); }
      .right { text-align: right; white-space: nowrap; }
      .pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(255,255,255,0.04);
        border: 1px solid rgba(255,255,255,0.08);
        font-size: 0.78rem;
        color: var(--muted);
      }
      .pill::before {
        content: '';
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: var(--success);
      }
      .status {
        color: var(--muted);
        font-size: 0.92rem;
      }
      .status.error {
        color: var(--danger);
      }
      .loader {
        position: absolute;
        inset: 0;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(8, 10, 15, 0.7);
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
        padding: 14px 16px;
        border-radius: 16px;
        background: #111621;
        border: 1px solid var(--line);
        box-shadow: 0 18px 40px rgba(0,0,0,0.28);
      }
      .loader-spinner {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        border: 2px solid rgba(255,255,255,0.2);
        border-top-color: var(--accent);
        animation: spin 0.8s linear infinite;
      }
      .loader-text {
        font-weight: 700;
      }
      .empty {
        padding: 34px;
        text-align: center;
        color: var(--muted);
      }
      .skeleton {
        position: relative;
        overflow: hidden;
        background: #17202d;
        border-radius: 8px;
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
      .skeleton.name { height: 15px; width: 74%; }
      .skeleton.sub { height: 11px; width: 48%; margin-top: 8px; }
      .skeleton.small { height: 12px; width: 72px; }
      .skeleton.price { height: 14px; width: 78px; margin-left: auto; }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      @keyframes shimmer {
        100% { transform: translateX(100%); }
      }
      @media (max-width: 1200px) {
        .content {
          grid-template-columns: 1fr;
        }
        .sidebar {
          border-right: none;
          border-bottom: 1px solid var(--line);
        }
      }
      @media (max-width: 900px) {
        .hero-stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 640px) {
        .shell {
          padding: 12px;
        }
        .hero-stats {
          grid-template-columns: 1fr;
        }
        .topbar,
        .sidebar,
        .main {
          padding-left: 14px;
          padding-right: 14px;
        }
        .table-wrap {
          max-height: calc(100vh - 360px);
        }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel">
        <header class="topbar">
          <div class="eyebrow">Panel operativo</div>
          <div class="title-row">
            <div>
              <h1>Inventario en vivo</h1>
              <p class="lede">
                Vista funcional del inventario cargado en PostgreSQL. Buscá, filtrá por sitio y lanzá el refresco completo desde acá.
              </p>
            </div>
            <div class="pill" id="connectionPill">Conectado</div>
          </div>
          <div class="hero-stats">
            <div class="hero-stat">
              <span class="label">Productos visibles</span>
              <div class="value" id="visibleCount">0</div>
            </div>
            <div class="hero-stat">
              <span class="label">Total inventario</span>
              <div class="value" id="totalCount">0</div>
            </div>
            <div class="hero-stat">
              <span class="label">Última actualización</span>
              <div class="value" id="lastUpdated">Sin datos</div>
            </div>
            <div class="hero-stat">
              <span class="label">Estado</span>
              <div class="value" id="statusBadge">Listo</div>
            </div>
          </div>
        </header>

        <section class="content">
          <aside class="sidebar">
            <div class="card">
              <h2>Filtros</h2>
              <label class="field-label" for="search">Buscar</label>
              <input id="search" placeholder="Nombre, SKU, marca o sitio" />
              <div style="height: 12px"></div>
              <label class="field-label" for="siteFilter">Sitio</label>
              <select id="siteFilter">
                <option value="">Todos los sitios</option>
              </select>
            </div>

            <div class="card">
              <h2>Acciones</h2>
              <div class="buttons">
                <button id="refresh" class="primary">Actualizar inventario</button>
                <button id="reload" class="secondary">Recargar vista</button>
              </div>
              <p class="mini-note">El botón de actualización dispara el refresco completo y luego vuelve a leer el inventario.</p>
            </div>

            <div class="card">
              <h2>Sitios activos</h2>
              <div class="site-list">
                <div class="site-pill ok">Taxitor</div>
                <div class="site-pill ok">Acesur</div>
                <div class="site-pill ok">Chaparei</div>
                <div class="site-pill ok">Selvir</div>
              </div>
            </div>
          </aside>

          <section class="main">
            <div class="card table-card">
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
                      <th class="right">Precio</th>
                      <th>SKU</th>
                      <th>Sitio</th>
                      <th>Stock</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody id="rows">
                    <tr><td colspan="6" class="empty">Cargando inventario...</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        </section>
      </section>
    </main>

    <script>
      const state = {
        products: [],
        filtered: [],
        site: '',
      };

      const rows = document.getElementById('rows');
      const search = document.getElementById('search');
      const siteFilter = document.getElementById('siteFilter');
      const loader = document.getElementById('loader');
      const totalCount = document.getElementById('totalCount');
      const visibleCount = document.getElementById('visibleCount');
      const lastUpdated = document.getElementById('lastUpdated');
      const statusBadge = document.getElementById('statusBadge');
      const connectionPill = document.getElementById('connectionPill');

      document.getElementById('refresh').addEventListener('click', refreshInventory);
      document.getElementById('reload').addEventListener('click', loadInventory);
      search.addEventListener('input', applyFilters);
      siteFilter.addEventListener('change', () => {
        state.site = siteFilter.value;
        applyFilters();
      });

      function setStatus(text, isError = false) {
        statusBadge.textContent = text;
        statusBadge.className = isError ? 'status error' : 'status';
        connectionPill.textContent = isError ? 'Con error' : 'Conectado';
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
          if (!term) return true;
          const haystack = [
            product.productName,
            product.sku,
            product.brand,
            product.category,
            product.site,
            product.availability,
          ].map(normalize).join(' ');
          return haystack.includes(term);
        });
        renderRows();
        visibleCount.textContent = String(state.filtered.length);
      }

      function renderSiteOptions() {
        const sites = Array.from(new Set(state.products.map((product) => product.site).filter(Boolean))).sort();
        const current = siteFilter.value;
        siteFilter.innerHTML = '<option value="">Todos los sitios</option>' + sites.map((site) => '<option value="' + escapeHtml(site) + '">' + escapeHtml(site) + '</option>').join('');
        siteFilter.value = current;
      }

      function renderRows() {
        if (!state.filtered.length) {
          rows.innerHTML = '<tr><td colspan="6" class="empty">No hay productos para mostrar</td></tr>';
          return;
        }

        rows.innerHTML = state.filtered.map((product) => {
          const productName = escapeHtml(product.productName || 'Sin nombre');
          const url = product.sourceUrl
            ? '<a class="product-title" href="' + escapeAttr(product.sourceUrl) + '" target="_blank" rel="noreferrer">' + productName + '</a>'
            : '<span class="product-title">' + productName + '</span>';
          const priceCurrency = String(product.currency || '').trim().toUpperCase();
          const priceSuffix = priceCurrency && priceCurrency !== 'UYU' && priceCurrency !== 'UY$' && priceCurrency !== 'UY'
            ? ' <span class="muted">(' + escapeHtml(priceCurrency) + ')</span>'
            : '';
          return '<tr>' +
            '<td><div class="product-cell">' + url + (product.brand ? '<div class="muted">' + escapeHtml(product.brand) + '</div>' : '') + '</div></td>' +
            '<td class="right">' + escapeHtml(product.price || '-') + priceSuffix + '</td>' +
            '<td>' + escapeHtml(product.sku || '-') + '</td>' +
            '<td>' + escapeHtml(product.site || '-') + '</td>' +
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
        return escapeHtml(value).replaceAll(String.fromCharCode(96), '&#96;');
      }

      async function loadInventory() {
        setStatus('Cargando');
        showLoader();
        try {
          const url = state.site ? '/scraping/inventory?site=' + encodeURIComponent(state.site) : '/scraping/inventory';
          const response = await fetch(url);
          if (!response.ok) throw new Error('No se pudo leer el inventario');
          const data = await response.json();
          state.products = Array.isArray(data.products) ? data.products : [];
          renderSiteOptions();
          applyFilters();
          totalCount.textContent = String(data.total ?? state.products.length);
          lastUpdated.textContent = new Date().toLocaleString('es-AR');
          setStatus('Inventario cargado');
        } catch (error) {
          rows.innerHTML = '<tr><td colspan="6" class="empty">' + escapeHtml(error.message || 'Error al cargar inventario') + '</td></tr>';
          setStatus(error.message || 'Error al cargar inventario', true);
        } finally {
          hideLoader();
        }
      }

      async function refreshInventory() {
        setStatus('Actualizando');
        try {
          const response = await fetch('/scraping/inventory/refresh', { method: 'POST' });
          if (!response.ok) throw new Error('No se pudo iniciar la actualización');
          await response.json();
          await loadInventory();
          setStatus('Actualizado');
        } catch (error) {
          setStatus(error.message || 'Error al actualizar inventario', true);
        }
      }

      loadInventory();
    </script>
  </body>
</html>`;
}
