// =============================================
// Motrix Download Manager - Background Service Worker
// =============================================

const DEFAULT_CONFIG = {
  enabled: true,
  rpcUrl: 'http://localhost:16800/jsonrpc',
  rpcSecret: '',
  fileExtensions: '',  // 留空表示拦截所有，否则填写如 "zip,exe,dmg,iso,torrent"
  minFileSize: 0       // 最小文件大小（字节），0 表示不限制
};

// 从 storage 读取配置
async function getConfig() {
  const result = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return result;
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
    const response = await fetch(config.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rpcBody)
    });

    const data = await response.json();

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

    return data;
  } catch (err) {
    console.error('[Motrix] 发送到 aria2 失败:', err);

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Motrix 下载失败',
      message: `无法连接 Motrix，请确认已启动。\n${err.message}`
    });

    throw err;
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
  const filename = downloadItem.filename
    ? downloadItem.filename.split(/[/\\]/).pop()
    : extractFilename(url);

  if (!shouldIntercept(url, filename, config)) {
    return;
  }

  // 检查最小文件大小
  if (config.minFileSize > 0 && downloadItem.fileSize > 0 && downloadItem.fileSize < config.minFileSize) {
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
  sendToAria2(url, filename, referrer);
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

  sendToAria2(url, filename, referrer);
});

// =============================================
// 监听来自 popup 的消息
// =============================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'testConnection') {
    testConnection(message.rpcUrl, message.rpcSecret)
      .then(result => sendResponse({ success: true, version: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // 异步响应
  }

  if (message.type === 'addDownload') {
    const filename = extractFilename(message.url);
    sendToAria2(message.url, filename, '')
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ success: false, error: err.message }));
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

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rpcBody)
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  return data.result.version;
}
