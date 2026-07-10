const STORAGE_KEY = 'ytShortsCollectorState';
const STORAGE_VERSION = 2;
const MAX_SCAN_HISTORY = 120;

const elements = {
  pageTitle: document.getElementById('pageTitle'),
  pageType: document.getElementById('pageType'),
  sortLabel: document.getElementById('sortLabel'),
  totalCount: document.getElementById('totalCount'),
  batchNo: document.getElementById('batchNo'),
  lastScanAt: document.getElementById('lastScanAt'),
  scanResult: document.getElementById('scanResult'),
  lastThumbnail: document.getElementById('lastThumbnail'),
  lastTitle: document.getElementById('lastTitle'),
  lastScrollY: document.getElementById('lastScrollY'),
  lastUrl: document.getElementById('lastUrl'),
  scanButton: document.getElementById('scanButton'),
  exportExcelButton: document.getElementById('exportExcelButton'),
  exportJsonButton: document.getElementById('exportJsonButton'),
  resetButton: document.getElementById('resetButton')
};

let currentTab = null;
let currentPageMeta = null;
let currentState = null;

function createEmptyStorage() {
  return { version: STORAGE_VERSION, datasets: {} };
}

function normalizePageMeta(pageMeta, contextKey = '') {
  const source = pageMeta && typeof pageMeta === 'object' ? pageMeta : {};
  return {
    platform: source.platform || '',
    pageTitle: source.pageTitle || '',
    pageType: source.pageType || 'unknown',
    sortLabel: source.sortLabel || '',
    channelName: source.channelName || '',
    channelUrl: source.channelUrl || '',
    baseUrl: source.baseUrl || '',
    contextKey: source.contextKey || contextKey
  };
}

function normalizeStoredItem(item, fallbackIndex = 0) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const url = item.url || '';
  const videoId = item.videoId || '';
  if (!url && !videoId) {
    return null;
  }

  const normalized = {
    captureIndex: Number.isFinite(item.captureIndex) && item.captureIndex > 0 ? item.captureIndex : fallbackIndex + 1,
    batchNo: Number.isFinite(item.batchNo) && item.batchNo >= 0 ? item.batchNo : 0,
    screenOrder: Number.isFinite(item.screenOrder) && item.screenOrder >= 0 ? item.screenOrder : fallbackIndex + 1,
    title: item.title || '',
    url,
    videoId,
    capturedAt: item.capturedAt || ''
  };

  if (item.publishedDate) {
    normalized.publishedDate = item.publishedDate;
  }
  if (item.thumbnailUrl) {
    normalized.thumbnailUrl = item.thumbnailUrl;
  }
  if (item.note) {
    normalized.note = item.note;
  }

  return normalized;
}

function normalizeScanHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  return {
    batchNo: Number.isFinite(entry.batchNo) && entry.batchNo >= 0 ? entry.batchNo : 0,
    scannedAt: entry.scannedAt || '',
    visibleCount: Number.isFinite(entry.visibleCount) && entry.visibleCount >= 0 ? entry.visibleCount : 0,
    addedCount: Number.isFinite(entry.addedCount) && entry.addedCount >= 0 ? entry.addedCount : 0,
    lastTitle: entry.lastTitle || '',
    lastUrl: entry.lastUrl || ''
  };
}

function normalizeLastCheckpoint(lastCheckpoint) {
  if (!lastCheckpoint || typeof lastCheckpoint !== 'object') {
    return null;
  }

  const url = lastCheckpoint.url || '';
  const videoId = lastCheckpoint.videoId || '';
  if (!url && !videoId) {
    return null;
  }

  const normalized = {
    title: lastCheckpoint.title || '',
    url,
    videoId,
    batchNo: Number.isFinite(lastCheckpoint.batchNo) && lastCheckpoint.batchNo >= 0 ? lastCheckpoint.batchNo : 0,
    screenOrder: Number.isFinite(lastCheckpoint.screenOrder) && lastCheckpoint.screenOrder >= 0 ? lastCheckpoint.screenOrder : 0,
    scrollY: Number.isFinite(lastCheckpoint.scrollY) ? lastCheckpoint.scrollY : null,
    capturedAt: lastCheckpoint.capturedAt || ''
  };

  if (lastCheckpoint.thumbnailUrl) {
    normalized.thumbnailUrl = lastCheckpoint.thumbnailUrl;
  }

  return normalized;
}

function normalizeDataset(dataset, contextKey = '') {
  const source = dataset && typeof dataset === 'object' ? dataset : {};
  const items = Array.isArray(source.items)
    ? source.items
        .map((item, index) => normalizeStoredItem(item, index))
        .filter(Boolean)
        .sort((left, right) => left.captureIndex - right.captureIndex)
    : [];

  const scanHistory = Array.isArray(source.scanHistory)
    ? source.scanHistory
        .map((entry) => normalizeScanHistoryEntry(entry))
        .filter(Boolean)
        .slice(-MAX_SCAN_HISTORY)
    : [];

  return {
    pageMeta: normalizePageMeta(source.pageMeta, contextKey),
    items,
    batchNo: Number.isFinite(source.batchNo) && source.batchNo >= 0 ? source.batchNo : 0,
    lastScanAt: source.lastScanAt || '',
    scanHistory,
    lastCheckpoint: normalizeLastCheckpoint(source.lastCheckpoint)
  };
}

function normalizeStorageState(rawState) {
  const source = rawState && typeof rawState === 'object' ? rawState : {};
  const rawDatasets = source.datasets && typeof source.datasets === 'object' ? source.datasets : {};
  const datasets = {};

  for (const [contextKey, dataset] of Object.entries(rawDatasets)) {
    datasets[contextKey] = normalizeDataset(dataset, contextKey);
  }

  return {
    version: STORAGE_VERSION,
    datasets
  };
}

function makeStoredRecord(row, batchNo, captureIndex, capturedAt) {
  const record = {
    captureIndex,
    batchNo,
    screenOrder: Number.isFinite(row.screenOrder) && row.screenOrder >= 0 ? row.screenOrder : captureIndex,
    title: row.title || '',
    url: row.url || '',
    videoId: row.videoId || '',
    capturedAt
  };

  if (row.publishedDate) {
    record.publishedDate = row.publishedDate;
  }
  if (row.thumbnailUrl) {
    record.thumbnailUrl = row.thumbnailUrl;
  }

  return record;
}

function isQuotaError(error) {
  const message = String(error && error.message ? error.message : error || '');
  return /QUOTA_BYTES|quota/i.test(message);
}

function getStorage() {
  return chrome.storage.local.get(STORAGE_KEY).then((result) => {
    return normalizeStorageState(result[STORAGE_KEY] || createEmptyStorage());
  });
}

function setStorage(state) {
  return chrome.storage.local.set({ [STORAGE_KEY]: normalizeStorageState(state) });
}

function sanitizeFilename(input) {
  return (input || 'short-video-links')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(isoString) {
  if (!isoString) {
    return '尚未采集';
  }
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return isoString;
  }
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch (error) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  }
}

async function sendToPage(message) {
  if (!currentTab || !currentTab.id) {
    throw new Error('未找到当前标签页。');
  }
  await ensureContentScript(currentTab.id);
  return chrome.tabs.sendMessage(currentTab.id, message);
}

function getDataset(storage, contextKey) {
  return storage.datasets[contextKey] || null;
}

function getFileBaseName(pageMeta) {
  const pieces = [
    pageMeta.channelName || 'channel',
    pageMeta.pageType || 'page',
    pageMeta.sortLabel || 'sort',
    new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  ];
  return sanitizeFilename(pieces.join('_'));
}

function buildExcelHtml(dataset) {
  const pageMeta = dataset.pageMeta || {};
  const headers = [
    '序号',
    '频道名',
    '频道页面',
    '页面类型',
    '排序方式',
    '采集批次',
    '屏内顺序',
    '视频标题',
    '发布时间',
    '视频链接',
    '视频ID',
    '缩略图链接',
    '采集时间',
    '备注'
  ];

  const rows = dataset.items
    .slice()
    .sort((left, right) => left.captureIndex - right.captureIndex)
    .map((item) => {
      return [
        item.captureIndex,
        item.channelName || pageMeta.channelName || '',
        item.channelUrl || pageMeta.channelUrl || '',
        item.pageType || pageMeta.pageType || '',
        item.sortLabel || pageMeta.sortLabel || '',
        item.batchNo,
        item.screenOrder,
        item.title,
        item.publishedDate || '',
        item.url,
        item.videoId,
        item.thumbnailUrl,
        item.capturedAt,
        item.note || ''
      ];
    });

  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('');
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('');

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <style>
      table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; }
      th, td { border: 1px solid #999; padding: 6px 8px; font-size: 12px; vertical-align: top; }
      th { background: #f2e0cf; }
    </style>
  </head>
  <body>
    <table>
      <thead><tr>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  </body>
</html>`;
}

function downloadBlob(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  return chrome.downloads
    .download({ url, filename, saveAs: true })
    .finally(() => {
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    });
}

function renderState(pageMeta, dataset) {
  currentPageMeta = pageMeta;
  currentState = dataset;

  elements.pageTitle.textContent = pageMeta ? pageMeta.pageTitle || pageMeta.baseUrl : '未识别';
  elements.pageType.textContent = pageMeta ? pageMeta.pageType : '-';
  elements.sortLabel.textContent = pageMeta ? pageMeta.sortLabel : '-';
  elements.totalCount.textContent = dataset ? String(dataset.items.length) : '0';
  elements.batchNo.textContent = dataset ? String(dataset.batchNo || 0) : '0';
  elements.lastScanAt.textContent = dataset ? formatTime(dataset.lastScanAt) : '尚未采集';

  if (dataset && dataset.lastCheckpoint) {
    if (dataset.lastCheckpoint.thumbnailUrl) {
      elements.lastThumbnail.src = dataset.lastCheckpoint.thumbnailUrl;
      elements.lastThumbnail.classList.remove('hidden');
    } else {
      elements.lastThumbnail.removeAttribute('src');
      elements.lastThumbnail.classList.add('hidden');
    }
    elements.lastTitle.textContent = dataset.lastCheckpoint.title || '未命名视频';
    elements.lastScrollY.textContent = `滚动位置：${dataset.lastCheckpoint.scrollY ?? '-'}`;
    elements.lastUrl.textContent = dataset.lastCheckpoint.url || '-';
    elements.lastUrl.href = dataset.lastCheckpoint.url || '#';
  } else {
    elements.lastThumbnail.removeAttribute('src');
    elements.lastThumbnail.classList.add('hidden');
    elements.lastTitle.textContent = '暂无记录';
    elements.lastScrollY.textContent = '滚动位置：-';
    elements.lastUrl.textContent = '-';
    elements.lastUrl.href = '#';
  }
}

async function refreshPageState() {
  currentTab = await getActiveTab();
  const isSupportedTab =
    currentTab &&
    currentTab.url &&
    (currentTab.url.startsWith('https://www.youtube.com/') || currentTab.url.startsWith('https://www.tiktok.com/'));

  if (!isSupportedTab) {
    renderState(
      {
        pageTitle: '请先打开 YouTube 或 TikTok 页面',
        pageType: '-',
        sortLabel: '-'
      },
      null
    );
    elements.scanResult.textContent = '当前标签页不是受支持页面，请切到目标 YouTube Shorts 页面或 TikTok 主页视频列表后再操作。';
    return;
  }

  const pingResult = await sendToPage({ action: 'ping' });
  const storage = await getStorage();
  const dataset = getDataset(storage, pingResult.pageMeta.contextKey);
  renderState(pingResult.pageMeta, dataset);
}

function mergeScanResult(dataset, payload) {
  const now = new Date().toISOString();
  const items = Array.isArray(dataset.items) ? dataset.items.map((item, index) => normalizeStoredItem(item, index)).filter(Boolean) : [];
  const existing = new Map();
  for (const item of items) {
    const key = item.videoId || item.url;
    if (key) {
      existing.set(key, item);
    }
  }

  let addedCount = 0;
  const batchNo = (dataset.batchNo || 0) + 1;

  for (const row of payload.items) {
    const key = row.videoId || row.url;
    if (!key) {
      continue;
    }

    if (existing.has(key)) {
      const target = existing.get(key);
      if (!target.title && row.title) {
        target.title = row.title;
      }
      if (!target.publishedDate && row.publishedDate) {
        target.publishedDate = row.publishedDate;
      }
      if (!target.thumbnailUrl && row.thumbnailUrl) {
        target.thumbnailUrl = row.thumbnailUrl;
      }
      continue;
    }

    const record = makeStoredRecord(row, batchNo, items.length + 1, now);
    items.push(record);
    existing.set(key, record);
    addedCount += 1;
  }

  const lastItem = payload.items[payload.items.length - 1] || null;

  return {
    ...dataset,
    pageMeta: normalizePageMeta(payload.pageMeta, payload.pageMeta.contextKey),
    batchNo,
    items,
    lastScanAt: now,
    scanHistory: [...(dataset.scanHistory || []), {
      batchNo,
      scannedAt: now,
      visibleCount: payload.visibleCount,
      addedCount,
      lastTitle: lastItem ? lastItem.title : '',
      lastUrl: lastItem ? lastItem.url : ''
    }].slice(-MAX_SCAN_HISTORY),
    lastCheckpoint: lastItem
      ? {
          title: lastItem.title,
          url: lastItem.url,
          videoId: lastItem.videoId,
          thumbnailUrl: lastItem.thumbnailUrl,
          batchNo,
          screenOrder: lastItem.screenOrder,
          scrollY: payload.pageMeta.scrollY,
          capturedAt: now
        }
      : dataset.lastCheckpoint || null
  };
}

async function handleScan() {
  elements.scanButton.disabled = true;
  try {
    const payload = await sendToPage({ action: 'scanVisible' });
    if (!payload.ok) {
      throw new Error(payload.error || '采集失败');
    }
    if (payload.pageMeta.pageType === 'unknown') {
      elements.scanResult.textContent = '当前页面暂不支持采集，请切到 YouTube Shorts 页面或 TikTok 主页视频列表后再试。';
      return;
    }

    const storage = await getStorage();
    const existingDataset = getDataset(storage, payload.pageMeta.contextKey) || {
      pageMeta: payload.pageMeta,
      items: [],
      batchNo: 0,
      scanHistory: [],
      lastCheckpoint: null
    };
    const merged = mergeScanResult(existingDataset, payload);
    storage.datasets[payload.pageMeta.contextKey] = merged;
    await setStorage(storage);
    renderState(payload.pageMeta, merged);
    elements.scanResult.textContent = `本次扫描到 ${payload.visibleCount} 个封面，新增 ${merged.scanHistory[merged.scanHistory.length - 1].addedCount} 条，总计 ${merged.items.length} 条。`;
  } catch (error) {
    if (isQuotaError(error)) {
      elements.scanResult.textContent = '采集失败：浏览器本地存储空间已满。请重新加载更新后的扩展后再试；如仍失败，可先导出并清空部分旧页面进度。';
    } else {
      elements.scanResult.textContent = `采集失败：${error.message || error}`;
    }
  } finally {
    elements.scanButton.disabled = false;
  }
}

async function handleExportExcel() {
  if (!currentPageMeta || !currentState || !currentState.items.length) {
    elements.scanResult.textContent = '当前页面还没有可导出的记录，请先采集。';
    return;
  }
  const filename = `exports/${getFileBaseName(currentPageMeta)}.xls`;
  await downloadBlob(buildExcelHtml(currentState), filename, 'application/vnd.ms-excel;charset=utf-8');
  elements.scanResult.textContent = `已导出 Excel 兼容表格：${filename}`;
}

async function handleExportJson() {
  if (!currentPageMeta || !currentState) {
    elements.scanResult.textContent = '当前页面没有可导出的进度数据。';
    return;
  }
  const filename = `exports/${getFileBaseName(currentPageMeta)}.json`;
  const payload = JSON.stringify(currentState, null, 2);
  await downloadBlob(payload, filename, 'application/json;charset=utf-8');
  elements.scanResult.textContent = `已导出 JSON 备份：${filename}`;
}

async function handleReset() {
  if (!currentPageMeta) {
    return;
  }
  const confirmed = window.confirm('确认清空当前页面的采集记录和断点吗？此操作不会删除已导出的文件。');
  if (!confirmed) {
    return;
  }
  const storage = await getStorage();
  delete storage.datasets[currentPageMeta.contextKey];
  await setStorage(storage);
  renderState(currentPageMeta, null);
  elements.scanResult.textContent = '已清空当前页面进度。';
}

elements.scanButton.addEventListener('click', handleScan);
elements.exportExcelButton.addEventListener('click', handleExportExcel);
elements.exportJsonButton.addEventListener('click', handleExportJson);
elements.resetButton.addEventListener('click', handleReset);

refreshPageState().catch((error) => {
  elements.scanResult.textContent = `初始化失败：${error.message || error}`;
});
