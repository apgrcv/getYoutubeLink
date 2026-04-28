const PAGE_READY_WAIT_MS = 250;
const DATE_LABEL_CLASS = 'link-collector-published-date';
const DATE_STYLE_ID = 'link-collector-style';
const MAX_FETCH_CONCURRENCY = 4;

const publishedDateCache = new Map();
const pendingDateRequests = new Map();
const pendingEnhancementQueue = [];
const queuedUrls = new Set();
const tiktokStateDateCache = new Map();

let parsedTikTokStateKey = '';

let activeFetchCount = 0;
let enhanceTimer = null;
let pageObserver = null;
let enhancerInitialized = false;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getText(selectors, root = document) {
  for (const selector of selectors) {
    const node = root.querySelector(selector);
    if (!node) {
      continue;
    }
    const rawText = (node.getAttribute && node.getAttribute('content')) || node.textContent;
    if (!rawText) {
      continue;
    }
    const text = rawText.replace(/\s+/g, ' ').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

function normalizeUrl(urlLike) {
  try {
    const url = new URL(urlLike, window.location.origin);

    if (url.hostname.includes('youtube.com')) {
      if (url.pathname.startsWith('/shorts/')) {
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length >= 2) {
          return `${url.origin}/shorts/${parts[1]}`;
        }
      }
      return `${url.origin}${url.pathname}`;
    }

    if (url.hostname.includes('tiktok.com')) {
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    }

    return `${url.origin}${url.pathname}`;
  } catch (error) {
    return '';
  }
}

function extractVideoId(url) {
  if (!url) {
    return '';
  }

  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.hostname.includes('youtube.com')) {
      if (parsed.pathname.startsWith('/shorts/')) {
        return parsed.pathname.split('/').filter(Boolean)[1] || '';
      }
      return parsed.searchParams.get('v') || '';
    }

    if (parsed.hostname.includes('tiktok.com')) {
      const match = parsed.pathname.match(/\/video\/(\d+)/);
      return match ? match[1] : '';
    }
  } catch (error) {
    // Ignore URL parsing errors and fall through to regex parsing.
  }

  const youtubeMatch = url.match(/\/shorts\/([^?&#/]+)/);
  if (youtubeMatch) {
    return youtubeMatch[1];
  }

  const tiktokMatch = url.match(/\/video\/(\d+)/);
  return tiktokMatch ? tiktokMatch[1] : '';
}

function formatPublishedDate(value) {
  if (value === null || value === undefined || value === '') {
    return '';
  }

  const normalized = String(value).trim();
  if (!normalized) {
    return '';
  }

  if (/^\d{10,13}$/.test(normalized)) {
    const numericValue = Number(normalized);
    const milliseconds = normalized.length === 13 ? numericValue : numericValue * 1000;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }

  const isoMatch = normalized.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const slashMatch = normalized.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashMatch) {
    return `${slashMatch[1]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[3].padStart(2, '0')}`;
  }

  const textDateMatch = normalized.match(/([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (textDateMatch) {
    const parsed = new Date(textDateMatch[1]);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
  }

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return '';
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function walkObjectTree(node, visitor, seen = new WeakSet()) {
  if (!node || typeof node !== 'object') {
    return;
  }
  if (seen.has(node)) {
    return;
  }
  seen.add(node);
  visitor(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      walkObjectTree(item, visitor, seen);
    }
    return;
  }

  for (const value of Object.values(node)) {
    walkObjectTree(value, visitor, seen);
  }
}

function decodeTikTokPublishedDateFromVideoId(videoId) {
  if (!videoId || !/^\d+$/.test(String(videoId))) {
    return '';
  }

  try {
    const seconds = Number(BigInt(String(videoId)) >> 32n);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return '';
    }
    return formatPublishedDate(String(seconds));
  } catch (error) {
    return '';
  }
}

function parseTikTokStateDates() {
  if (!window.location.hostname.includes('tiktok.com')) {
    return;
  }
  const currentStateKey = `${window.location.origin}${window.location.pathname}`;
  if (parsedTikTokStateKey === currentStateKey) {
    return;
  }
  parsedTikTokStateKey = currentStateKey;
  tiktokStateDateCache.clear();

  const stateScript = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const parsed = safeJsonParse(stateScript?.textContent || '');
  if (!parsed) {
    return;
  }

  walkObjectTree(parsed, (node) => {
    const candidateIds = [
      node?.id,
      node?.awemeId,
      node?.itemId,
      node?.group_id,
      node?.video?.id
    ];
    const candidateTimes = [
      node?.createTime,
      node?.create_time,
      node?.itemStruct?.createTime,
      node?.itemStruct?.create_time
    ];

    const publishedDate = candidateTimes.map((value) => formatPublishedDate(value)).find(Boolean);
    if (!publishedDate) {
      return;
    }

    for (const candidateId of candidateIds) {
      if (!candidateId) {
        continue;
      }
      const normalizedId = String(candidateId).trim();
      if (normalizedId) {
        tiktokStateDateCache.set(normalizedId, publishedDate);
      }
    }
  });
}

function getTikTokPublishedDate(videoId) {
  parseTikTokStateDates();
  const normalizedId = String(videoId || '').trim();
  if (!normalizedId) {
    return '';
  }

  if (tiktokStateDateCache.has(normalizedId)) {
    return tiktokStateDateCache.get(normalizedId) || '';
  }

  return decodeTikTokPublishedDateFromVideoId(normalizedId);
}

function isVisible(rect) {
  if (!rect || rect.width < 40 || rect.height < 40) {
    return false;
  }
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function getCanonicalUrl() {
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && canonical.href) {
    return canonical.href;
  }
  return `${window.location.origin}${window.location.pathname}`;
}

function getMetaContent(nameOrProperty, attr = 'name') {
  const selector = `meta[${attr}="${nameOrProperty}"]`;
  return document.querySelector(selector)?.getAttribute('content') || '';
}

function injectDateStyles() {
  if (document.getElementById(DATE_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = DATE_STYLE_ID;
  style.textContent = `
    .${DATE_LABEL_CLASS} {
      display: block;
      margin-top: 6px;
      font-size: 12px;
      line-height: 1.4;
      letter-spacing: 0.01em;
    }

    .${DATE_LABEL_CLASS}[data-platform="youtube"] {
      color: #606060;
    }

    .${DATE_LABEL_CLASS}[data-platform="tiktok"] {
      margin-top: 8px;
      padding: 0 2px;
      color: rgba(255, 255, 255, 0.92);
      font-size: 11px;
      line-height: 1.5;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
    }

    .${DATE_LABEL_CLASS}[data-state="loading"] {
      color: rgba(255, 255, 255, 0.6);
    }

    .${DATE_LABEL_CLASS}[data-platform="youtube"][data-state="loading"] {
      color: #909090;
    }
  `;
  document.head.appendChild(style);
}

function findSortLabelBySelection(candidates) {
  for (const candidate of candidates) {
    const selected =
      candidate.getAttribute('aria-selected') === 'true' ||
      candidate.getAttribute('aria-pressed') === 'true' ||
      candidate.classList.contains('iron-selected') ||
      candidate.classList.contains('active') ||
      candidate.classList.contains('selected') ||
      candidate.hasAttribute('selected');
    if (!selected) {
      continue;
    }
    const text = candidate.textContent.replace(/\s+/g, ' ').trim();
    if (text) {
      return text;
    }
  }
  return '';
}

const youtubeAdapter = {
  name: 'youtube',
  label: 'YouTube',
  matchesLocation() {
    return window.location.hostname.includes('youtube.com') && window.location.pathname.includes('/shorts');
  },
  getActiveSortLabel() {
    const candidates = Array.from(
      document.querySelectorAll('yt-chip-cloud-chip-renderer, yt-chip-cloud-chip-view-model, button')
    );
    return findSortLabelBySelection(candidates) || '未识别';
  },
  getChannelName() {
    return (
      getText([
        'ytd-channel-name #text',
        '#channel-name #text',
        'yt-formatted-string.ytd-channel-name',
        'meta[itemprop="name"]'
      ]) || ''
    );
  },
  getChannelUrl() {
    return getCanonicalUrl();
  },
  getPageMeta() {
    const pathname = window.location.pathname;
    const baseUrl = `${window.location.origin}${pathname}`;
    const sortLabel = this.getActiveSortLabel();
    return {
      platform: this.name,
      pageTitle: document.title.replace(/^\(\d+\)\s*/, '').trim(),
      pageUrl: window.location.href,
      baseUrl,
      pageType: 'youtube-shorts',
      sortLabel,
      channelName: this.getChannelName(),
      channelUrl: this.getChannelUrl(),
      scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
      contextKey: `${this.name}::${baseUrl}::${sortLabel}`
    };
  },
  pickCardElement(anchor) {
    return (
      anchor.closest('ytd-rich-grid-media') ||
      anchor.closest('ytd-rich-item-renderer') ||
      anchor.closest('ytd-reel-item-renderer') ||
      anchor.closest('ytm-shorts-lockup-view-model') ||
      anchor.closest('ytd-grid-video-renderer') ||
      anchor
    );
  },
  getAnchorCandidates() {
    return Array.from(document.querySelectorAll('a[href*="/shorts/"]'));
  },
  collectEntries() {
    const entries = [];
    const seenUrls = new Set();

    for (const anchor of this.getAnchorCandidates()) {
      const url = normalizeUrl(anchor.href);
      if (!url || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      entries.push({
        platform: this.name,
        url,
        anchor,
        card: this.pickCardElement(anchor)
      });
    }

    return entries;
  },
  getDirectPublishedDate(card, anchor) {
    const candidates = [
      getText(['#metadata-line span', '.metadata-line span', '#details #text', 'time', '[datetime]'], card),
      anchor.getAttribute('aria-label') || '',
      anchor.getAttribute('title') || ''
    ];

    for (const candidate of candidates) {
      const publishedDate = formatPublishedDate(candidate);
      if (publishedDate) {
        return publishedDate;
      }
    }

    return '';
  },
  getTitle(card, anchor, fallbackLabel) {
    const title =
      getText(
        ['#video-title', 'span#video-title', 'h3', 'yt-formatted-string#video-title', 'a#video-title-link'],
        card
      ) ||
      anchor.getAttribute('title') ||
      anchor.getAttribute('aria-label') ||
      fallbackLabel;

    return title.replace(/\s+/g, ' ').trim();
  },
  getThumbnailUrl(card) {
    const img = card.querySelector('img');
    return (img && (img.src || img.getAttribute('src'))) || '';
  },
  insertLabel(entry, label) {
    const titleNode =
      entry.card.querySelector('#video-title') ||
      entry.card.querySelector('span#video-title') ||
      entry.card.querySelector('yt-formatted-string#video-title') ||
      entry.card.querySelector('h3') ||
      entry.anchor;

    if (titleNode.parentElement) {
      titleNode.insertAdjacentElement('afterend', label);
      return;
    }

    entry.card.appendChild(label);
  },
  async fetchPublishedDate(url) {
    try {
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) {
        return '';
      }

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const candidates = [
        doc.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content'),
        doc.querySelector('meta[property="og:video:release_date"]')?.getAttribute('content'),
        doc.querySelector('script[type="application/ld+json"]')?.textContent || ''
      ];

      for (const candidate of candidates) {
        const publishedDate = formatPublishedDate(candidate);
        if (publishedDate) {
          return publishedDate;
        }
      }

      const scriptMatch = html.match(/"datePublished":"([^"]+)"/);
      return scriptMatch ? formatPublishedDate(scriptMatch[1]) : '';
    } catch (error) {
      return '';
    }
  }
};

const tiktokAdapter = {
  name: 'tiktok',
  label: 'TikTok',
  matchesLocation() {
    return (
      window.location.hostname.includes('tiktok.com') &&
      /^\/@[^/]+\/?$/.test(window.location.pathname)
    );
  },
  getActiveSortLabel() {
    const candidates = Array.from(document.querySelectorAll('button'));
    const matchingButtons = candidates.filter((button) => {
      const text = button.textContent.replace(/\s+/g, ' ').trim();
      return text === '最新' || text === '热门' || text === '最旧' || text === 'Latest' || text === 'Popular' || text === 'Oldest';
    });

    return findSortLabelBySelection(matchingButtons) || '未识别';
  },
  getChannelName() {
    const heading =
      document.querySelector('h1') ||
      document.querySelector('h2');
    if (heading?.textContent) {
      const text = heading.textContent.replace(/\s+/g, ' ').trim();
      if (text) {
        return text;
      }
    }

    const title = document.title.replace(/\s*\|.*$/, '').trim();
    return title || getMetaContent('og:title', 'property').replace(/\s*\|.*$/, '').trim();
  },
  getChannelUrl() {
    return getCanonicalUrl();
  },
  getPageMeta() {
    const baseUrl = `${window.location.origin}${window.location.pathname.replace(/\/+$/, '')}`;
    const sortLabel = this.getActiveSortLabel();
    return {
      platform: this.name,
      pageTitle: document.title.replace(/^\(\d+\)\s*/, '').trim(),
      pageUrl: window.location.href,
      baseUrl,
      pageType: 'tiktok-profile-videos',
      sortLabel,
      channelName: this.getChannelName(),
      channelUrl: this.getChannelUrl(),
      scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
      contextKey: `${this.name}::${baseUrl}::${sortLabel}`
    };
  },
  pickCardElement(anchor) {
    return (
      anchor.closest('[data-e2e*="user-post-item"]') ||
      anchor.closest('[data-e2e*="user-post"]') ||
      anchor.parentElement ||
      anchor
    );
  },
  getAnchorCandidates() {
    return Array.from(document.querySelectorAll('a[href*="/video/"]')).filter((anchor) => {
      const href = anchor.getAttribute('href') || '';
      return /\/@[^/]+\/video\/\d+/.test(href);
    });
  },
  collectEntries() {
    const entries = [];
    const seenUrls = new Set();

    for (const anchor of this.getAnchorCandidates()) {
      const url = normalizeUrl(anchor.href);
      if (!url || seenUrls.has(url)) {
        continue;
      }
      seenUrls.add(url);
      entries.push({
        platform: this.name,
        url,
        anchor,
        card: this.pickCardElement(anchor)
      });
    }

    return entries;
  },
  getDirectPublishedDate(card, anchor) {
    const videoId = extractVideoId(anchor.href || '');
    const candidates = [
      getText(['time', '[datetime]'], card),
      anchor.getAttribute('aria-label') || '',
      anchor.getAttribute('title') || '',
      getTikTokPublishedDate(videoId)
    ];

    for (const candidate of candidates) {
      const publishedDate = formatPublishedDate(candidate);
      if (publishedDate) {
        return publishedDate;
      }
    }

    return '';
  },
  getTitle(card, anchor, fallbackLabel) {
    const title =
      anchor.getAttribute('aria-label') ||
      anchor.getAttribute('title') ||
      getText(['img[alt]'], card) ||
      fallbackLabel;

    return title.replace(/\s+/g, ' ').trim();
  },
  getThumbnailUrl(card) {
    const img = card.querySelector('img');
    return (img && (img.src || img.getAttribute('src'))) || '';
  },
  getLabelHost(entry) {
    const cardParent = entry.card.parentElement;
    if (cardParent && cardParent.children.length === 1) {
      return {
        host: cardParent,
        mode: 'after-card'
      };
    }

    if (entry.card && entry.card !== entry.anchor) {
      return {
        host: entry.card,
        mode: 'append'
      };
    }

    if (entry.anchor.parentElement) {
      return {
        host: entry.anchor.parentElement,
        mode: 'after-anchor'
      };
    }

    return {
      host: entry.card,
      mode: 'append'
    };
  },
  insertLabel(entry, label) {
    const target = this.getLabelHost(entry);
    if (!target || !target.host) {
      entry.card.appendChild(label);
      return;
    }

    target.host.style.overflow = 'visible';

    if (target.mode === 'after-card') {
      entry.card.insertAdjacentElement('afterend', label);
      return;
    }

    if (target.mode === 'after-anchor') {
      entry.anchor.insertAdjacentElement('afterend', label);
      return;
    }

    target.host.appendChild(label);
  },
  async fetchPublishedDate(url) {
    return getTikTokPublishedDate(extractVideoId(url));
  }
};

const adapters = [youtubeAdapter, tiktokAdapter];

function getActiveAdapter() {
  return adapters.find((adapter) => adapter.matchesLocation()) || null;
}

function getPageMeta() {
  const adapter = getActiveAdapter();
  if (!adapter) {
    const baseUrl = `${window.location.origin}${window.location.pathname}`;
    return {
      platform: 'unknown',
      pageTitle: document.title.replace(/^\(\d+\)\s*/, '').trim(),
      pageUrl: window.location.href,
      baseUrl,
      pageType: 'unknown',
      sortLabel: '-',
      channelName: '',
      channelUrl: getCanonicalUrl(),
      scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
      contextKey: `unknown::${baseUrl}`
    };
  }
  return adapter.getPageMeta();
}

function makeRecord(entry, index, pageMeta) {
  const rect = entry.card.getBoundingClientRect();
  const videoId = extractVideoId(entry.url);
  const titleFallback =
    pageMeta.platform === 'youtube' ? `Short ${videoId || index + 1}` : `TikTok ${videoId || index + 1}`;

  return {
    screenOrder: index + 1,
    visibleTop: Math.round(rect.top),
    visibleLeft: Math.round(rect.left),
    videoId,
    title: entry.adapter.getTitle(entry.card, entry.anchor, titleFallback),
    url: entry.url,
    thumbnailUrl: entry.adapter.getThumbnailUrl(entry.card),
    publishedDate: entry.adapter.getDirectPublishedDate(entry.card, entry.anchor),
    pageType: pageMeta.pageType,
    sortLabel: pageMeta.sortLabel,
    channelName: pageMeta.channelName,
    channelUrl: pageMeta.channelUrl,
    sourcePage: pageMeta.baseUrl,
    platform: pageMeta.platform
  };
}

function getDateLabel(entry) {
  const existing = entry.card.querySelector(`.${DATE_LABEL_CLASS}`);
  if (existing) {
    return existing;
  }

  const label = document.createElement('div');
  label.className = DATE_LABEL_CLASS;
  label.dataset.state = 'loading';
  label.dataset.platform = entry.platform;
  entry.adapter.insertLabel(entry, label);
  return label;
}

function renderPublishedDate(entry, publishedDate, state = 'ready') {
  const label = getDateLabel(entry);
  label.dataset.state = state;
  label.dataset.platform = entry.platform;
  label.textContent = publishedDate ? `发布时间：${publishedDate}` : '发布时间：未知';
}

function getCacheKey(platform, url) {
  return `${platform}::${url}`;
}

function getCachedPublishedDate(entry) {
  const cacheKey = getCacheKey(entry.platform, entry.url);
  if (publishedDateCache.has(cacheKey)) {
    return Promise.resolve(publishedDateCache.get(cacheKey));
  }
  if (pendingDateRequests.has(cacheKey)) {
    return pendingDateRequests.get(cacheKey);
  }

  const request = entry.adapter
    .fetchPublishedDate(entry.url)
    .then((publishedDate) => {
      publishedDateCache.set(cacheKey, publishedDate || '');
      return publishedDate || '';
    })
    .finally(() => {
      pendingDateRequests.delete(cacheKey);
    });

  pendingDateRequests.set(cacheKey, request);
  return request;
}

async function enrichPublishedDates(items, entriesByUrl) {
  const enriched = await Promise.all(
    items.map(async (item) => {
      if (item.publishedDate) {
        publishedDateCache.set(getCacheKey(item.platform, item.url), item.publishedDate);
        return item;
      }

      const entry = entriesByUrl.get(item.url);
      if (!entry) {
        return item;
      }

      const publishedDate = await getCachedPublishedDate(entry);
      return {
        ...item,
        publishedDate
      };
    })
  );

  return enriched;
}

function processEnhancementQueue() {
  while (activeFetchCount < MAX_FETCH_CONCURRENCY && pendingEnhancementQueue.length > 0) {
    const entry = pendingEnhancementQueue.shift();
    queuedUrls.delete(getCacheKey(entry.platform, entry.url));
    activeFetchCount += 1;

    getCachedPublishedDate(entry)
      .then((publishedDate) => {
        if (entry.card.isConnected) {
          renderPublishedDate(entry, publishedDate, publishedDate ? 'ready' : 'empty');
        }
      })
      .finally(() => {
        activeFetchCount -= 1;
        processEnhancementQueue();
      });
  }
}

function enhanceVisibleCards() {
  const adapter = getActiveAdapter();
  if (!adapter) {
    return;
  }

  injectDateStyles();

  for (const entry of adapter.collectEntries()) {
    entry.adapter = adapter;
    const directPublishedDate = adapter.getDirectPublishedDate(entry.card, entry.anchor);
    const cacheKey = getCacheKey(entry.platform, entry.url);

    if (directPublishedDate) {
      publishedDateCache.set(cacheKey, directPublishedDate);
      renderPublishedDate(entry, directPublishedDate, 'ready');
      continue;
    }

    if (publishedDateCache.has(cacheKey)) {
      const cachedDate = publishedDateCache.get(cacheKey);
      renderPublishedDate(entry, cachedDate, cachedDate ? 'ready' : 'empty');
      continue;
    }

    renderPublishedDate(entry, '', 'loading');

    if (!queuedUrls.has(cacheKey)) {
      pendingEnhancementQueue.push(entry);
      queuedUrls.add(cacheKey);
    }
  }

  processEnhancementQueue();
}

function scheduleEnhanceVisibleCards(delay = 200) {
  window.clearTimeout(enhanceTimer);
  enhanceTimer = window.setTimeout(() => {
    enhanceVisibleCards();
  }, delay);
}

function initPageEnhancer() {
  if (enhancerInitialized) {
    return;
  }
  enhancerInitialized = true;

  injectDateStyles();
  scheduleEnhanceVisibleCards(PAGE_READY_WAIT_MS);

  if (!pageObserver && document.body) {
    pageObserver = new MutationObserver(() => {
      scheduleEnhanceVisibleCards(250);
    });
    pageObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  document.addEventListener('yt-navigate-finish', () => {
    scheduleEnhanceVisibleCards(PAGE_READY_WAIT_MS);
  });
  window.addEventListener('load', () => {
    scheduleEnhanceVisibleCards(PAGE_READY_WAIT_MS);
  });
  window.addEventListener(
    'scroll',
    () => {
      scheduleEnhanceVisibleCards(120);
    },
    { passive: true }
  );
}

async function scanVisibleItems() {
  await wait(PAGE_READY_WAIT_MS);

  const adapter = getActiveAdapter();
  const pageMeta = getPageMeta();
  if (!adapter) {
    return {
      ok: true,
      pageMeta,
      visibleCount: 0,
      items: []
    };
  }

  const rows = [];
  const entriesByUrl = new Map();

  for (const rawEntry of adapter.collectEntries()) {
    const card = rawEntry.card;
    const rect = card.getBoundingClientRect();
    if (!isVisible(rect)) {
      continue;
    }

    const entry = {
      ...rawEntry,
      adapter,
      rect
    };

    entriesByUrl.set(entry.url, entry);
    rows.push(entry);
  }

  rows.sort((left, right) => {
    const topDiff = left.rect.top - right.rect.top;
    if (Math.abs(topDiff) > 6) {
      return topDiff;
    }
    return left.rect.left - right.rect.left;
  });

  const items = rows.map((entry, index) => makeRecord(entry, index, pageMeta));
  const enrichedItems = await enrichPublishedDates(items, entriesByUrl);

  return {
    ok: true,
    pageMeta,
    visibleCount: enrichedItems.length,
    items: enrichedItems
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    return false;
  }

  if (message.action === 'ping') {
    sendResponse({ ok: true, pageMeta: getPageMeta() });
    return false;
  }

  if (message.action === 'scanVisible') {
    scanVisibleItems()
      .then((payload) => sendResponse(payload))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  return false;
});

initPageEnhancer();
