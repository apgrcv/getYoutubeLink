const PAGE_READY_WAIT_MS = 250;
const DATE_LABEL_CLASS = 'yt-shorts-collector-published-date';
const DATE_STYLE_ID = 'yt-shorts-collector-style';
const MAX_FETCH_CONCURRENCY = 4;

const publishedDateCache = new Map();
const pendingDateRequests = new Map();
const pendingEnhancementQueue = [];
const queuedUrls = new Set();

let activeFetchCount = 0;
let enhanceTimer = null;
let pageObserver = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(urlLike) {
  try {
    const url = new URL(urlLike, window.location.origin);
    if (url.pathname.startsWith('/shorts/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        return `${window.location.origin}/shorts/${parts[1]}`;
      }
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
    if (parsed.pathname.startsWith('/shorts/')) {
      return parsed.pathname.split('/').filter(Boolean)[1] || '';
    }
    return parsed.searchParams.get('v') || '';
  } catch (error) {
    const match = url.match(/\/shorts\/([^?&#/]+)/);
    return match ? match[1] : '';
  }
}

function getText(selectors, root = document) {
  for (const selector of selectors) {
    const node = root.querySelector(selector);
    if (node && node.textContent) {
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (text) {
        return text;
      }
    }
  }
  return '';
}

function formatPublishedDate(value) {
  if (!value) {
    return '';
  }
  const normalized = String(value).trim();
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

function injectDateStyles() {
  if (document.getElementById(DATE_STYLE_ID)) {
    return;
  }
  const style = document.createElement('style');
  style.id = DATE_STYLE_ID;
  style.textContent = `
    .${DATE_LABEL_CLASS} {
      display: block;
      margin-top: 4px;
      color: #606060;
      font-size: 1.2rem;
      line-height: 1.4rem;
    }

    .${DATE_LABEL_CLASS}[data-state="loading"] {
      color: #909090;
    }
  `;
  document.head.appendChild(style);
}

function getPublishedDateFromCard(card, anchor) {
  const candidates = [
    getText(['#metadata-line span', '.metadata-line span', '#details #text'], card),
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
}

function getActiveSortLabel() {
  const candidates = Array.from(document.querySelectorAll('yt-chip-cloud-chip-renderer, yt-chip-cloud-chip-view-model, button'));
  for (const candidate of candidates) {
    const selected =
      candidate.getAttribute('aria-selected') === 'true' ||
      candidate.classList.contains('iron-selected') ||
      candidate.hasAttribute('selected');
    if (!selected) {
      continue;
    }
    const text = candidate.textContent.replace(/\s+/g, ' ').trim();
    if (text) {
      return text;
    }
  }
  return '未识别';
}

function getChannelName() {
  const selectors = [
    'ytd-channel-name #text',
    '#channel-name #text',
    'yt-formatted-string.ytd-channel-name',
    'meta[itemprop="name"]'
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (!node) {
      continue;
    }
    const text = (node.getAttribute && node.getAttribute('content')) || node.textContent;
    if (text) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return '';
}

function getChannelUrl() {
  const canonical = document.querySelector('link[rel="canonical"]');
  if (canonical && canonical.href) {
    return canonical.href;
  }
  return `${window.location.origin}${window.location.pathname}`;
}

function getPageMeta() {
  const pathname = window.location.pathname;
  const isShortsPage = pathname.includes('/shorts');
  const sortLabel = getActiveSortLabel();
  const baseUrl = `${window.location.origin}${pathname}`;
  return {
    pageTitle: document.title.replace(/^\(\d+\)\s*/, '').trim(),
    pageUrl: window.location.href,
    baseUrl,
    pageType: isShortsPage ? 'shorts' : 'unknown',
    sortLabel,
    channelName: getChannelName(),
    channelUrl: getChannelUrl(),
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
    contextKey: `${baseUrl}::${sortLabel}`
  };
}

function isVisible(rect) {
  if (!rect || rect.width < 40 || rect.height < 40) {
    return false;
  }
  return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}

function pickCardElement(anchor) {
  return (
    anchor.closest('ytd-rich-grid-media') ||
    anchor.closest('ytd-rich-item-renderer') ||
    anchor.closest('ytd-reel-item-renderer') ||
    anchor.closest('ytm-shorts-lockup-view-model') ||
    anchor.closest('ytd-grid-video-renderer') ||
    anchor
  );
}

function getAnchorCandidates() {
  return Array.from(document.querySelectorAll('a[href*="/shorts/"]'));
}

function findTitleNode(card, anchor) {
  return (
    card.querySelector('#video-title') ||
    card.querySelector('span#video-title') ||
    card.querySelector('yt-formatted-string#video-title') ||
    card.querySelector('h3') ||
    anchor
  );
}

function getDateLabel(card, anchor) {
  const existing = card.querySelector(`.${DATE_LABEL_CLASS}`);
  if (existing) {
    return existing;
  }
  const label = document.createElement('div');
  label.className = DATE_LABEL_CLASS;
  label.dataset.state = 'loading';
  const titleNode = findTitleNode(card, anchor);
  if (titleNode.parentElement) {
    titleNode.insertAdjacentElement('afterend', label);
  } else {
    card.appendChild(label);
  }
  return label;
}

function renderPublishedDate(card, anchor, publishedDate, state = 'ready') {
  const label = getDateLabel(card, anchor);
  label.dataset.state = state;
  label.textContent = publishedDate ? `发布时间：${publishedDate}` : '发布时间：未知';
}

function makeRecord(card, anchor, index, pageMeta) {
  const rect = card.getBoundingClientRect();
  const normalizedUrl = normalizeUrl(anchor.href);
  const videoId = extractVideoId(normalizedUrl);
  const title =
    getText([
      '#video-title',
      'span#video-title',
      'h3',
      'yt-formatted-string#video-title',
      'a#video-title-link'
    ], card) ||
    anchor.getAttribute('title') ||
    anchor.getAttribute('aria-label') ||
    `Short ${videoId || index + 1}`;
  const img = card.querySelector('img');
  const thumbnailUrl = (img && (img.src || img.getAttribute('src'))) || '';
  const publishedDate = getPublishedDateFromCard(card, anchor);

  return {
    screenOrder: index + 1,
    visibleTop: Math.round(rect.top),
    visibleLeft: Math.round(rect.left),
    videoId,
    title: title.replace(/\s+/g, ' ').trim(),
    url: normalizedUrl,
    thumbnailUrl,
    publishedDate,
    pageType: pageMeta.pageType,
    sortLabel: pageMeta.sortLabel,
    channelName: pageMeta.channelName,
    channelUrl: pageMeta.channelUrl,
    sourcePage: pageMeta.baseUrl
  };
}

async function fetchPublishedDateByUrl(url) {
  if (!url) {
    return '';
  }
  try {
    const response = await fetch(url, {
      credentials: 'same-origin'
    });
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
    const scriptText = html.match(/"datePublished":"([^"]+)"/);
    return scriptText ? formatPublishedDate(scriptText[1]) : '';
  } catch (error) {
    return '';
  }
}

function getCachedPublishedDate(url) {
  if (!url) {
    return Promise.resolve('');
  }
  if (publishedDateCache.has(url)) {
    return Promise.resolve(publishedDateCache.get(url));
  }
  if (pendingDateRequests.has(url)) {
    return pendingDateRequests.get(url);
  }
  const request = fetchPublishedDateByUrl(url)
    .then((publishedDate) => {
      publishedDateCache.set(url, publishedDate || '');
      return publishedDate || '';
    })
    .finally(() => {
      pendingDateRequests.delete(url);
    });
  pendingDateRequests.set(url, request);
  return request;
}

async function enrichPublishedDates(items) {
  const enriched = await Promise.all(
    items.map(async (item) => {
      if (item.publishedDate) {
        publishedDateCache.set(item.url, item.publishedDate);
        return item;
      }
      const publishedDate = await getCachedPublishedDate(item.url);
      return {
        ...item,
        publishedDate
      };
    })
  );
  return enriched;
}

function collectShortCardEntries() {
  const entries = [];
  const seenUrls = new Set();
  for (const anchor of getAnchorCandidates()) {
    const url = normalizeUrl(anchor.href);
    if (!url || seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);
    entries.push({
      url,
      anchor,
      card: pickCardElement(anchor)
    });
  }
  return entries;
}

function processEnhancementQueue() {
  while (activeFetchCount < MAX_FETCH_CONCURRENCY && pendingEnhancementQueue.length > 0) {
    const entry = pendingEnhancementQueue.shift();
    queuedUrls.delete(entry.url);
    activeFetchCount += 1;

    getCachedPublishedDate(entry.url)
      .then((publishedDate) => {
        if (entry.card.isConnected) {
          renderPublishedDate(entry.card, entry.anchor, publishedDate, publishedDate ? 'ready' : 'empty');
        }
      })
      .finally(() => {
        activeFetchCount -= 1;
        processEnhancementQueue();
      });
  }
}

function enhanceShortCards() {
  if (!window.location.pathname.includes('/shorts')) {
    return;
  }
  injectDateStyles();

  for (const entry of collectShortCardEntries()) {
    const directPublishedDate = getPublishedDateFromCard(entry.card, entry.anchor);
    if (directPublishedDate) {
      publishedDateCache.set(entry.url, directPublishedDate);
      renderPublishedDate(entry.card, entry.anchor, directPublishedDate, 'ready');
      continue;
    }

    if (publishedDateCache.has(entry.url)) {
      renderPublishedDate(entry.card, entry.anchor, publishedDateCache.get(entry.url), publishedDateCache.get(entry.url) ? 'ready' : 'empty');
      continue;
    }

    renderPublishedDate(entry.card, entry.anchor, '', 'loading');
    if (!queuedUrls.has(entry.url)) {
      pendingEnhancementQueue.push(entry);
      queuedUrls.add(entry.url);
    }
  }

  processEnhancementQueue();
}

function scheduleEnhanceShortCards(delay = 200) {
  window.clearTimeout(enhanceTimer);
  enhanceTimer = window.setTimeout(() => {
    enhanceShortCards();
  }, delay);
}

function initPageEnhancer() {
  injectDateStyles();
  scheduleEnhanceShortCards(PAGE_READY_WAIT_MS);

  if (!pageObserver && document.body) {
    pageObserver = new MutationObserver(() => {
      scheduleEnhanceShortCards(250);
    });
    pageObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  document.addEventListener('yt-navigate-finish', () => {
    scheduleEnhanceShortCards(PAGE_READY_WAIT_MS);
  });
  window.addEventListener('load', () => {
    scheduleEnhanceShortCards(PAGE_READY_WAIT_MS);
  });
  window.addEventListener(
    'scroll',
    () => {
      scheduleEnhanceShortCards(120);
    },
    { passive: true }
  );
}

async function scanVisibleShorts() {
  await wait(PAGE_READY_WAIT_MS);
  const pageMeta = getPageMeta();
  const seenUrls = new Set();
  const rows = [];

  for (const anchor of getAnchorCandidates()) {
    const card = pickCardElement(anchor);
    const rect = card.getBoundingClientRect();
    if (!isVisible(rect)) {
      continue;
    }
    const url = normalizeUrl(anchor.href);
    if (!url || seenUrls.has(url)) {
      continue;
    }
    seenUrls.add(url);
    rows.push({ card, anchor, rect });
  }

  rows.sort((left, right) => {
    const topDiff = left.rect.top - right.rect.top;
    if (Math.abs(topDiff) > 6) {
      return topDiff;
    }
    return left.rect.left - right.rect.left;
  });

  const items = rows.map((entry, index) => makeRecord(entry.card, entry.anchor, index, pageMeta));
  const enrichedItems = await enrichPublishedDates(items);

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
    scanVisibleShorts()
      .then((payload) => sendResponse(payload))
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || String(error) });
      });
    return true;
  }

  return false;
});

if (!window.__ytShortsCollectorPageEnhancerInitialized) {
  window.__ytShortsCollectorPageEnhancerInitialized = true;
  initPageEnhancer();
}
