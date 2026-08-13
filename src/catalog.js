import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';

const DEFAULT_CATALOG_URL = 'https://www.satpricep.by/catalog/filter/clear/apply/';

function normalizeSpace(value = '') {
  return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(value = '') {
  return normalizeSpace(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length > 1);
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isLikelyProductUrl(rawUrl, baseUrl) {
  try {
    const url = new URL(rawUrl, baseUrl);
    if (url.hostname !== new URL(baseUrl).hostname) return false;
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'catalog') return false;
    if (segments.includes('filter')) return false;
    return segments.length >= 4;
  } catch {
    return false;
  }
}

async function fetchHtml(url, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36 SatpricepAICaller/1.0',
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'ru,en;q=0.8',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    const html = await response.text();
    if (/request is being verified|just a moment|cf-chl/i.test(html)) {
      throw new Error(`Антибот-защита не отдала содержимое страницы ${url}`);
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

function extractCatalogCards(html, pageUrl) {
  const $ = cheerio.load(html);
  const cards = [];

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href || !isLikelyProductUrl(href, pageUrl)) return;

    const url = new URL(href, pageUrl).toString();
    const anchorText = normalizeSpace($(element).text());
    const containerText = normalizeSpace(
      $(element)
        .closest('article, li, .item, .product, .catalog-item, .catalog__item, .catalog-list__item, .product-item')
        .text(),
    );
    const text = containerText.length >= anchorText.length ? containerText : anchorText;
    if (text.length < 15) return;

    cards.push({
      title: anchorText.slice(0, 300),
      url,
      text: text.slice(0, 5000),
    });
  });

  return uniqueBy(cards, (item) => item.url);
}

function extractPageKnowledge(html, url, fallbackTitle = '') {
  const $ = cheerio.load(html);
  $('script,style,noscript,svg,header,footer,nav,form,iframe').remove();

  const title = normalizeSpace($('h1').first().text()) || fallbackTitle || normalizeSpace($('title').text());
  const candidates = [
    'main',
    '.catalog-detail',
    '.product-detail',
    '.detail',
    '#content',
    '.content',
    'body',
  ];

  let text = '';
  for (const selector of candidates) {
    const candidate = normalizeSpace($(selector).first().text());
    if (candidate.length > text.length) text = candidate;
    if (candidate.length > 800) break;
  }

  return {
    title: title.slice(0, 500),
    url,
    text: text.slice(0, 30000),
  };
}

export class CatalogKnowledgeBase {
  constructor({
    catalogUrl = DEFAULT_CATALOG_URL,
    dataFile = path.resolve('data/catalog-knowledge.json'),
    maxPages = 20,
    maxProductPages = 200,
    fetchDelayMs = 120,
  } = {}) {
    this.catalogUrl = catalogUrl;
    this.dataFile = dataFile;
    this.maxPages = maxPages;
    this.maxProductPages = maxProductPages;
    this.fetchDelayMs = fetchDelayMs;
    this.documents = [];
    this.updatedAt = null;
  }

  async load() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.dataFile, 'utf8'));
      this.documents = Array.isArray(parsed.documents) ? parsed.documents : [];
      this.updatedAt = parsed.updatedAt || null;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.documents = [];
      this.updatedAt = null;
    }
    return this.status();
  }

  status() {
    const ageMs = this.updatedAt ? Date.now() - new Date(this.updatedAt).getTime() : null;
    return {
      source: this.catalogUrl,
      documents: this.documents.length,
      updatedAt: this.updatedAt,
      ageHours: ageMs == null ? null : Math.round((ageMs / 3600000) * 10) / 10,
    };
  }

  isFresh(maxAgeHours) {
    if (!this.updatedAt || !this.documents.length) return false;
    const ageMs = Date.now() - new Date(this.updatedAt).getTime();
    return ageMs <= maxAgeHours * 3600000;
  }

  async sync({ logger = console } = {}) {
    await fs.mkdir(path.dirname(this.dataFile), { recursive: true });

    const catalogDocs = [];
    const cards = [];

    for (let page = 1; page <= this.maxPages; page += 1) {
      const pageUrl = new URL(this.catalogUrl);
      if (page > 1) pageUrl.searchParams.set('PAGEN_1', String(page));
      const html = await fetchHtml(pageUrl.toString());
      const pageCards = extractCatalogCards(html, pageUrl.toString());
      const pageDoc = extractPageKnowledge(html, pageUrl.toString(), `Каталог — страница ${page}`);
      catalogDocs.push({ ...pageDoc, kind: 'catalog_page' });

      if (pageCards.length === 0) break;
      cards.push(...pageCards);

      const hasNext = html.includes(`PAGEN_1=${page + 1}`);
      if (!hasNext) break;
    }

    const uniqueCards = uniqueBy(cards, (item) => item.url).slice(0, this.maxProductPages);
    const productDocs = [];

    for (const [index, card] of uniqueCards.entries()) {
      let doc = {
        title: card.title,
        url: card.url,
        text: card.text,
        kind: 'product_card',
      };
      try {
        const html = await fetchHtml(card.url);
        const detail = extractPageKnowledge(html, card.url, card.title);
        if (detail.text.length >= card.text.length) {
          doc = { ...detail, kind: 'product_page' };
        }
      } catch (error) {
        logger.warn?.({ url: card.url, error: error.message }, 'Не удалось загрузить карточку товара; использую текст каталога');
      }
      productDocs.push(doc);
      if (this.fetchDelayMs > 0 && index < uniqueCards.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, this.fetchDelayMs));
      }
    }

    const now = new Date().toISOString();
    this.documents = uniqueBy([...productDocs, ...catalogDocs], (item) => `${item.kind}:${item.url}`)
      .filter((item) => item.text && item.text.length > 20)
      .map((item) => ({ ...item, fetchedAt: now, source: 'satpricep.by' }));
    this.updatedAt = now;

    await fs.writeFile(
      this.dataFile,
      JSON.stringify(
        {
          source: this.catalogUrl,
          updatedAt: now,
          documents: this.documents,
        },
        null,
        2,
      ),
    );

    return this.status();
  }

  search(query, { limit = 5, maxChars = 4500 } = {}) {
    const queryTokens = tokenize(query);
    if (!queryTokens.length || !this.documents.length) return [];

    const scored = this.documents.map((doc) => {
      const title = normalizeSpace(doc.title).toLowerCase();
      const text = normalizeSpace(doc.text).toLowerCase();
      let score = 0;
      for (const token of queryTokens) {
        if (title.includes(token)) score += 8;
        if (text.includes(token)) score += 2;
      }
      const phrase = normalizeSpace(query).toLowerCase();
      if (phrase.length > 3 && title.includes(phrase)) score += 20;
      if (phrase.length > 6 && text.includes(phrase)) score += 6;
      return { doc, score };
    });

    return scored
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ doc, score }) => {
        const plain = normalizeSpace(doc.text);
        const lower = plain.toLowerCase();
        const firstHit = queryTokens
          .map((token) => lower.indexOf(token))
          .filter((index) => index >= 0)
          .sort((a, b) => a - b)[0];
        const start = Math.max(0, (firstHit ?? 0) - 500);
        const snippet = plain.slice(start, start + maxChars);
        return {
          title: doc.title,
          url: doc.url,
          snippet,
          score,
          fetchedAt: doc.fetchedAt,
        };
      });
  }
}
