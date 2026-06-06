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
  getInventory(
    @Query('site') site?: string,
    @Query('search') search?: string,
    @Query('priceState') priceState?: string,
    @Query('availability') availability?: string,
  ) {
    return this.catalogScrapingService.getCurrentInventory({
      site,
      search,
      priceState,
      availability,
    });
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
      html, body { margin: 0; min-height: 100%; }
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
      .shell {
        min-height: 100vh;
        padding: 24px;
        position: relative;
      }
      .panel {
        width: 100%;
        max-width: none;
        border: 1px solid var(--line);
        border-radius: 26px;
        overflow: hidden;
        box-shadow: var(--shadow);
        background: linear-gradient(180deg, rgba(16, 20, 28, 0.96), rgba(8, 10, 15, 0.96));
      }
      .topbar {
        padding: 24px 26px 20px;
        border-bottom: 1px solid var(--line);
        display: grid;
        gap: 16px;
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
      .main {
        min-width: 0;
        padding: 20px;
      }
      .card {
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 20px;
        padding: 16px;
      }
      .table-toolbar {
        display: grid;
        gap: 14px;
        margin-bottom: 16px;
      }
      .search-field { display: grid; gap: 8px; }
      .filters-row {
        display: grid;
        grid-template-columns: 1.2fr repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      .field { display: grid; gap: 8px; }
      .field-label {
        display: block;
        color: var(--muted);
        text-transform: uppercase;
        font-size: 0.75rem;
        letter-spacing: 0.12em;
      }
      input, select {
        width: 100%;
        border: 1px solid var(--line-strong);
        background: var(--panel-strong);
        color: var(--text);
        border-radius: 14px;
        padding: 12px 14px;
        outline: none;
        font: inherit;
      }
      input::placeholder { color: rgba(246,241,234,0.42); }
      input:focus, select:focus {
        border-color: rgba(242,184,75,0.6);
        box-shadow: 0 0 0 3px rgba(242,184,75,0.12);
      }
      .table-note {
        color: var(--muted);
        font-size: 0.9rem;
        line-height: 1.6;
      }
      .table-card {
        position: relative;
        overflow: hidden;
      }
      .table-wrap {
        overflow: auto;
        max-height: calc(100vh - 240px);
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
      tbody tr:hover { background: rgba(255,255,255,0.03); }
      .product-cell { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      .product-title {
        font-weight: 700;
        color: var(--text);
        text-decoration: none;
        overflow-wrap: anywhere;
      }
      .product-title:hover { text-decoration: underline; }
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
      .status { color: var(--muted); font-size: 0.92rem; }
      .status.error { color: var(--danger); }
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
      .loader.is-visible { display: flex; }
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
      .loader-text { font-weight: 700; }
      .empty { padding: 34px; text-align: center; color: var(--muted); }
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
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes shimmer { 100% { transform: translateX(100%); } }
      @media (max-width: 1200px) {
        .filters-row { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 900px) {
        .hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 640px) {
        .shell { padding: 12px; }
        .hero-stats { grid-template-columns: 1fr; }
        .main { padding-left: 14px; padding-right: 14px; }
        .table-wrap { max-height: calc(100vh - 340px); }
        .filters-row { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <section class="panel">
        <header class="topbar">
          <div class="eyebrow">Inventario</div>
          <div class="title-row">
            <div>
              <h1>Inventario en vivo</h1>
              <p class="lede">Inventario cargado en PostgreSQL con filtros por producto, estado y casa.</p>
            </div>
            <div class="pill" id="connectionPill">Conectado</div>
          </div>
          <div class="hero-stats">
            <div class="hero-stat">
              <span class="label">Resultados</span>
              <div class="value" id="visibleCount">0</div>
            </div>
            <div class="hero-stat">
              <span class="label">Total inventario</span>
              <div class="value" id="totalCount">0</div>
            </div>
            <div class="hero-stat">
              <span class="label">Ultima actualizacion</span>
              <div class="value" id="lastUpdated">Sin datos</div>
            </div>
            <div class="hero-stat">
              <span class="label">Estado</span>
              <div class="value" id="statusBadge">Listo</div>
            </div>
          </div>
        </header>

        <section class="main">
          <div class="card table-card">
            <div class="table-toolbar">
              <div class="search-field">
                <label class="field-label" for="search">Buscar productos</label>
                <input id="search" placeholder="Nombre, marca, categoria o descripcion" />
              </div>
              <div class="filters-row">
                <div class="field">
                  <label class="field-label" for="houseFilter">Casa</label>
                  <select id="houseFilter">
                    <option value="">Todas las casas</option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label" for="priceStateFilter">Estado precio</label>
                  <select id="priceStateFilter">
                    <option value="">Todos</option>
                    <option value="with-price">Con precio</option>
                    <option value="without-price">Sin precio</option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label" for="availabilityFilter">Estado producto</label>
                  <select id="availabilityFilter">
                    <option value="">Todos</option>
                    <option value="available">Disponible</option>
                    <option value="unavailable">Sin stock</option>
                    <option value="unknown">Desconocido</option>
                  </select>
                </div>
                <div class="field">
                  <label class="field-label">Nota</label>
                  <div class="table-note">La busqueda usa ILIKE en el backend para devolver productos reales.</div>
                </div>
              </div>
            </div>
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
                      <th>Casa</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody id="rows">
                    <tr><td colspan="4" class="empty">Cargando inventario...</td></tr>
                  </tbody>
                </table>
              </div>
          </div>
        </section>
      </section>
    </main>

    <script>
      const state = {
        search: '',
        house: '',
        priceState: '',
        availability: '',
      };

      const rows = document.getElementById('rows');
      const search = document.getElementById('search');
      const houseFilter = document.getElementById('houseFilter');
      const priceStateFilter = document.getElementById('priceStateFilter');
      const availabilityFilter = document.getElementById('availabilityFilter');
      const loader = document.getElementById('loader');
      const totalCount = document.getElementById('totalCount');
      const visibleCount = document.getElementById('visibleCount');
      const lastUpdated = document.getElementById('lastUpdated');
      const statusBadge = document.getElementById('statusBadge');
      const connectionPill = document.getElementById('connectionPill');

      let searchTimer;

      search.addEventListener('input', () => {
        state.search = search.value;
        queueLoadInventory();
      });
      houseFilter.addEventListener('change', () => {
        state.house = houseFilter.value;
        loadInventory();
      });
      priceStateFilter.addEventListener('change', () => {
        state.priceState = priceStateFilter.value;
        loadInventory();
      });
      availabilityFilter.addEventListener('change', () => {
        state.availability = availabilityFilter.value;
        loadInventory();
      });

      function queueLoadInventory() {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(loadInventory, 250);
      }

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

      function normalizeHouseLabel(site) {
        const value = String(site ?? '').toLowerCase();
        if (value.includes('chaparei')) return 'Chaparei';
        if (value.includes('taxitor')) return 'Taxitor';
        if (value.includes('acesur')) return 'Acesur';
        if (value.includes('selvir')) return 'Selvir';
        try {
          return new URL(site).hostname.replace(/^www\./, '');
        } catch {
          return String(site ?? '-');
        }
      }

      function renderHouseOptions() {
        const preferred = [
          { label: 'Taxitor', value: 'https://taxitor.uy/articulos/filtro/1/-/-/' },
          { label: 'Acesur', value: 'https://acesur.uy/escritorio/ofertas/INTERNET' },
          { label: 'Chaparei', value: 'https://www.chaparei.com/productos/?m=171' },
          { label: 'Selvir', value: 'https://www.selvir.com.uy/product-category/carroceria/' },
        ];
        const current = houseFilter.value;
        houseFilter.innerHTML = '<option value="">Todas las casas</option>' + preferred.map((item) => '<option value="' + escapeHtml(item.value) + '">' + escapeHtml(item.label) + '</option>').join('');
        houseFilter.value = current;
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

      function renderRows(products) {
        if (!products.length) {
          rows.innerHTML = '<tr><td colspan="4" class="empty">No hay productos para mostrar</td></tr>';
          return;
        }

        rows.innerHTML = products.map((product) => {
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
            '<td>' + escapeHtml(normalizeHouseLabel(product.site || '-')) + '</td>' +
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
          '</tr>'
        )).join('');
      }

      async function loadInventory() {
        setStatus('Cargando');
        showLoader();
        try {
          const params = new URLSearchParams();
          if (state.house) params.set('site', state.house);
          if (state.search.trim()) params.set('search', state.search.trim());
          if (state.priceState) params.set('priceState', state.priceState);
          if (state.availability) params.set('availability', state.availability);
          const response = await fetch('/scraping/inventory' + (params.toString() ? '?' + params.toString() : ''));
          if (!response.ok) throw new Error('No se pudo leer el inventario');
          const data = await response.json();
          const products = Array.isArray(data.products) ? data.products : [];
          renderHouseOptions();
          renderRows(products);
          totalCount.textContent = String(data.total ?? products.length);
          visibleCount.textContent = String(products.length);
          lastUpdated.textContent = new Date().toLocaleString('es-AR');
          setStatus('Inventario cargado');
        } catch (error) {
          rows.innerHTML = '<tr><td colspan="4" class="empty">' + escapeHtml(error.message || 'Error al cargar inventario') + '</td></tr>';
          setStatus(error.message || 'Error al cargar inventario', true);
        } finally {
          hideLoader();
        }
      }

      renderHouseOptions();
      loadInventory();
    </script>
  </body>
</html>`;
}
