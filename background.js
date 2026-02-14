// =============================================
// Motrix Download Manager - Background Service Worker
// =============================================

const DEFAULT_CONFIG = {
  enabled: true,
  rpcUrl: 'http://localhost:16800/jsonrpc',
  rpcSecret: '',
  fallbackToBrowser: true,
  showMotrixOnSuccess: true,   // 下载成功后是否调起 Motrix 到前台
  fileExtensions: '',  // 留空表示拦截所有，否则填写如 "zip,exe,dmg,iso,torrent"
  minFileSize: 0       // 最小文件大小（字节），0 表示不限制
};

const SKIP_URL_TTL_MS = 15000;
const skipUrlUntil = new Map();

function shouldSkipUrl(url) {
  const until = skipUrlUntil.get(url);
  if (!until) return false;
  if (Date.now() > until) {
    skipUrlUntil.delete(url);
    return false;
  }
  skipUrlUntil.delete(url);
  return true;
}

async function resumeBrowserDownload(url, filename) {
  skipUrlUntil.set(url, Date.now() + SKIP_URL_TTL_MS);
  const options = { url };
  if (filename) {
    options.filename = filename;
  }
  return chrome.downloads.download(options);
}

// 从 storage 读取配置
async function getConfig() {
  const result = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return result;
}

function getFriendlyRpcErrorMessage(err) {
  const msg = (err && err.message) ? err.message : String(err);

  if (/unauthorized/i.test(msg) || /401/.test(msg)) {
    return 'RPC 未授权：请检查 Motrix 的 RPC 授权密钥是否已设置，并与扩展中填写的密钥一致。';
  }

  if (/http\s*400/i.test(msg) || /\b400\b/.test(msg)) {
    return 'RPC 请求错误（HTTP 400）：请检查 RPC 地址是否正确（通常为 http://localhost:16800/jsonrpc），并确认 Motrix 的 RPC 功能已开启。';
  }

  if (/failed to fetch/i.test(msg) || /networkerror/i.test(msg) || /ecconnrefused/i.test(msg) || /connect/i.test(msg)) {
    return '无法连接 Motrix：请确认 Motrix 已启动，RPC 端口为 16800（或与你设置的 RPC 地址一致）。';
  }

  return msg;
}

async function postJsonRpc(rpcUrl, rpcBody) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rpcBody)
  });

  if (!response.ok) {
    let details = '';
    try {
      details = await response.text();
    } catch (e) {
      // ignore
    }
    const suffix = details ? `: ${details.substring(0, 200)}` : '';
    throw new Error(`HTTP ${response.status}${suffix}`);
  }

  return response.json();
}

async function bringMotrixToFront() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'openMotrix' });
    }
  } catch (e) {
    console.warn('[Motrix] 无法唤起 Motrix:', e);
  }
}

async function sendToastToActiveTab(data) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'showToast', data });
    }
  } catch (e) {
    // ignore - tab may not have content script
  }
}

async function setLastStatus(status) {
  const payload = {
    ...status,
    ts: Date.now()
  };

  await chrome.storage.local.set({ lastStatus: payload });

  // 更新扩展图标 badge
  const badgeMap = {
    success: { text: '✓', color: '#43a047' },
    warning: { text: '!', color: '#f9a825' },
    error:   { text: '✗', color: '#e53935' }
  };
  const badge = badgeMap[status.level];
  if (badge) {
    chrome.action.setBadgeText({ text: badge.text });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 6000);
  }

  // 发送 toast 到当前页面
  await sendToastToActiveTab(payload);

  // 通知 popup（如果打开的话）
  chrome.runtime.sendMessage({
    type: 'statusUpdate',
    status: payload
  }).catch(() => {});
}

// 构造 aria2 JSON-RPC 请求体
function buildRpcRequest(method, params) {
  return {
    jsonrpc: '2.0',
    id: Date.now().toString(),
    method,
    params
  };
}

// 发送请求到 Motrix / aria2
async function sendToAria2(url, filename, referrer) {
  const config = await getConfig();

  const options = {};
  if (filename) {
    options.out = filename;
  }
  if (referrer) {
    options.referer = referrer;
  }

  let params;
  if (config.rpcSecret) {
    params = [`token:${config.rpcSecret}`, [url], options];
  } else {
    params = [[url], options];
  }

  const rpcBody = buildRpcRequest('aria2.addUri', params);

  try {
    const data = await postJsonRpc(config.rpcUrl, rpcBody);

    if (data.error) {
      throw new Error(data.error.message || 'aria2 RPC 错误');
    }

    // 成功通知
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Motrix 下载已添加',
      message: filename || url.substring(0, 80)
    });

    await setLastStatus({
      level: 'success',
      title: 'Motrix 下载已添加',
      message: filename || url
    });

    // 调起 Motrix 到前台
    if (config.showMotrixOnSuccess) {
      bringMotrixToFront();
    }

    return data;
  } catch (err) {
    console.error('[Motrix] 发送到 aria2 失败:', err);
    const friendly = getFriendlyRpcErrorMessage(err);

    await setLastStatus({
      level: 'error',
      title: 'Motrix 下载失败',
      message: friendly
    });

    throw new Error(friendly);
  }
}

// 从 URL 中解析文件名
function extractFilename(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const parts = pathname.split('/');
    const last = parts[parts.length - 1];
    if (last) {
      return decodeURIComponent(last);
    }
  } catch (e) {
    // ignore
  }
  return '';
}

// 判断是否应该拦截该 URL
function shouldIntercept(url, filename, config) {
  // 过滤 blob: 和 data: 协议
  if (url.startsWith('blob:') || url.startsWith('data:')) {
    return false;
  }

  // 只拦截 http/https
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return false;
  }

  // 如果设置了扩展名过滤
  if (config.fileExtensions && config.fileExtensions.trim()) {
    const extensions = config.fileExtensions
      .split(',')
      .map(ext => ext.trim().toLowerCase().replace(/^\./, ''));

    const name = filename || extractFilename(url);
    const dotIndex = name.lastIndexOf('.');
    if (dotIndex === -1) {
      return false; // 没有扩展名，不拦截
    }
    const fileExt = name.substring(dotIndex + 1).toLowerCase();
    if (!extensions.includes(fileExt)) {
      return false;
    }
  }

  return true;
}

// =============================================
// 监听下载事件
// =============================================
chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const config = await getConfig();

  // 未启用拦截
  if (!config.enabled) {
    return;
  }

  const url = downloadItem.url;
  if (shouldSkipUrl(url)) {
    return;
  }
  const filename = downloadItem.filename
    ? downloadItem.filename.split(/[/\\]/).pop()
    : extractFilename(url);

  if (!shouldIntercept(url, filename, config)) {
    return;
  }

  // 检查最小文件大小
  const minBytes = (config.minFileSize || 0) * 1024;
  if (minBytes > 0 && downloadItem.fileSize > 0 && downloadItem.fileSize < minBytes) {
    return;
  }

  // 取消浏览器下载
  try {
    await chrome.downloads.cancel(downloadItem.id);
    // 从下载列表中移除记录
    chrome.downloads.erase({ id: downloadItem.id });
  } catch (e) {
    console.warn('[Motrix] 取消下载失败:', e);
  }

  // 发送到 Motrix
  const referrer = downloadItem.referrer || '';
  try {
    await sendToAria2(url, filename, referrer);
  } catch (err) {
    if (config.fallbackToBrowser) {
      try {
        await resumeBrowserDownload(url, filename);

        await setLastStatus({
          level: 'warning',
          title: '已恢复浏览器下载',
          message: err.message
        });

        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Motrix 不可用，已恢复浏览器下载',
          message: err.message
        });
      } catch (e) {
        console.error('[Motrix] 恢复浏览器下载失败:', e);
      }
    } else {
      await setLastStatus({
        level: 'error',
        title: 'Motrix 下载失败',
        message: err.message
      });

      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Motrix 下载失败',
        message: err.message
      });
    }
  }
});

// =============================================
// 右键菜单：使用 Motrix 下载链接
// =============================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'motrix-download-link',
    title: '使用 Motrix 下载此链接',
    contexts: ['link']
  });

  chrome.contextMenus.create({
    id: 'motrix-download-image',
    title: '使用 Motrix 下载此图片',
    contexts: ['image']
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  let url = '';

  if (info.menuItemId === 'motrix-download-link') {
    url = info.linkUrl;
  } else if (info.menuItemId === 'motrix-download-image') {
    url = info.srcUrl;
  }

  if (!url) return;

  const filename = extractFilename(url);
  const referrer = info.pageUrl || '';

  try {
    await sendToAria2(url, filename, referrer);
  } catch (err) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Motrix 下载失败',
      message: err.message
    });
  }
});

// =============================================
// 监听来自 popup 的消息
// =============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'testConnection') {
    testConnection(message.rpcUrl, message.rpcSecret)
      .then(result => sendResponse({ success: true, version: result }))
      .catch(err => sendResponse({ success: false, error: getFriendlyRpcErrorMessage(err) }));
    return true; // 异步响应
  }

  if (message.type === 'addDownload') {
    const filename = extractFilename(message.url);
    sendToAria2(message.url, filename, '')
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: getFriendlyRpcErrorMessage(err) }));
    return true;
  }
});

// 测试连接 aria2
async function testConnection(rpcUrl, rpcSecret) {
  let params = [];
  if (rpcSecret) {
    params = [`token:${rpcSecret}`];
  }

  const rpcBody = buildRpcRequest('aria2.getVersion', params);

  const data = await postJsonRpc(rpcUrl, rpcBody);

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.result.version;
}
