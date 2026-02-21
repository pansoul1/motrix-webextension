// =============================================
// Motrix Download Manager - Background Service Worker
// =============================================

const DEFAULT_CONFIG = {
  enabled: true,
  rpcUrl: 'http://localhost:16800/jsonrpc',
  rpcSecret: '',
  fallbackToBrowser: true,
  showMotrixOnSuccess: true,
  fileExtensions: '',
  minFileSize: 0
};

const SKIP_URL_TTL_MS = 15000;
const skipUrlUntil = new Map();

// 等待最终文件名的下载项 { downloadId -> { url, referrer, config } }
const pendingDownloads = new Map();
const PENDING_TIMEOUT_MS = 8000;

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

async function getConfig() {
  const result = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return result;
}

// 通过 HEAD 请求尝试从 Content-Disposition 或最终 URL 获取真实文件名
async function resolveFilename(url) {
  try {
    const resp = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(5000)
    });

    // 优先从 Content-Disposition 解析
    const cd = resp.headers.get('content-disposition');
    if (cd) {
      // filename*=UTF-8''xxx 格式
      const utf8Match = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)?''(.+?)(?:;|$)/i);
      if (utf8Match) {
        return decodeURIComponent(utf8Match[1].trim());
      }
      // filename="xxx" 或 filename=xxx
      const match = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
      if (match) {
        return match[1].trim();
      }
    }

    // 从最终重定向后的 URL 提取
    const finalUrl = resp.url || url;
    if (finalUrl !== url) {
      const name = extractFilename(finalUrl);
      if (name && !looksLikeSlug(name)) {
        return name;
      }
    }
  } catch (e) {
    // HEAD 请求失败不影响主流程
  }
  return '';
}

// 判断文件名是否看起来像 URL slug（无扩展名、含连字符的路径段）
function looksLikeSlug(name) {
  if (!name) return true;
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === name.length - 1) return true;
  const ext = name.substring(dotIdx + 1);
  // 扩展名超过 10 个字符大概率不是真实扩展名
  if (ext.length > 10) return true;
  return false;
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
    // 优先通过 content script 用隐藏 iframe 触发（不会切走当前页面）
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && tab.url && /^https?:/.test(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'openMotrix' });
        return;
      } catch (e) {
        // content script 可能未注入，走备选方案
      }
    }

    // 备选：创建临时标签页触发 motrix:// 协议，然后关闭
    const tempTab = await chrome.tabs.create({ url: 'motrix://', active: false });
    setTimeout(() => {
      chrome.tabs.remove(tempTab.id).catch(() => {});
    }, 2000);
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

// 检测 RPC 连接失败是否属于"Motrix 未启动"（网络不可达）
function isConnectionError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  return /failed to fetch|networkerror|econnrefused|net::err_connection_refused|connect/i.test(msg);
}

// 尝试启动 Motrix 并等待 RPC 可用
async function launchMotrixAndWait(rpcUrl, rpcSecret) {
  // 通过 content script 用 motrix:// 协议启动
  await bringMotrixToFront();

  await setLastStatus({
    level: 'warning',
    title: '正在启动 Motrix…',
    message: '检测到 Motrix 未运行，正在尝试启动，请稍候'
  });

  // 轮询等待 RPC 可用，最多等 15 秒（间隔 1.5s 检测一次）
  const MAX_WAIT = 15000;
  const INTERVAL = 1500;
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT) {
    await new Promise(r => setTimeout(r, INTERVAL));
    try {
      let params = [];
      if (rpcSecret) params = [`token:${rpcSecret}`];
      const body = buildRpcRequest('aria2.getVersion', params);
      const data = await postJsonRpc(rpcUrl, body);
      if (data.result) return true;
    } catch (e) {
      // 还没启动好，继续等
    }
  }

  return false;
}

// 发送请求到 Motrix / aria2（含自动启动重试）
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

  const attemptSend = async () => {
    const data = await postJsonRpc(config.rpcUrl, rpcBody);
    if (data.error) {
      throw new Error(data.error.message || 'aria2 RPC 错误');
    }
    return data;
  };

  try {
    let data;
    try {
      data = await attemptSend();
    } catch (firstErr) {
      // 如果是连接错误（Motrix 未启动），尝试自动启动后重试
      if (isConnectionError(firstErr)) {
        const launched = await launchMotrixAndWait(config.rpcUrl, config.rpcSecret);
        if (launched) {
          data = await attemptSend();
        } else {
          throw firstErr;
        }
      } else {
        throw firstErr;
      }
    }

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

// 实际执行拦截：取消浏览器下载 → 发送到 aria2
async function interceptDownload(downloadId, url, filename, referrer, config) {
  try {
    await chrome.downloads.cancel(downloadId);
    chrome.downloads.erase({ id: downloadId });
  } catch (e) {
    console.warn('[Motrix] 取消下载失败:', e);
  }

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
}

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const config = await getConfig();

  if (!config.enabled) return;

  const url = downloadItem.url;
  if (shouldSkipUrl(url)) return;

  // 只拦截 http/https，跳过 blob:/data:
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;
  if (url.startsWith('blob:') || url.startsWith('data:')) return;

  const referrer = downloadItem.referrer || '';

  // downloadItem.filename 在 onCreated 时通常为空，
  // 需要等 onChanged 事件拿到浏览器解析后的最终文件名
  const earlyName = downloadItem.filename
    ? downloadItem.filename.split(/[/\\]/).pop()
    : '';

  // 如果已经有一个看起来正常的文件名（有扩展名），直接处理
  if (earlyName && !looksLikeSlug(earlyName)) {
    if (!shouldIntercept(url, earlyName, config)) return;

    const minBytes = (config.minFileSize || 0) * 1024;
    if (minBytes > 0 && downloadItem.fileSize > 0 && downloadItem.fileSize < minBytes) return;

    await interceptDownload(downloadItem.id, url, earlyName, referrer, config);
    return;
  }

  // 文件名尚未确定，暂停浏览器下载并等待 onChanged 提供最终文件名
  try {
    await chrome.downloads.pause(downloadItem.id);
  } catch (e) {
    // 可能已经完成了，忽略
  }

  pendingDownloads.set(downloadItem.id, {
    url,
    referrer,
    config,
    urlFilename: extractFilename(url),
    timer: setTimeout(async () => {
      // 超时兜底：如果 onChanged 迟迟没给文件名，用 HEAD 请求解析
      const pending = pendingDownloads.get(downloadItem.id);
      if (!pending) return;
      pendingDownloads.delete(downloadItem.id);

      let filename = pending.urlFilename;
      const resolved = await resolveFilename(url);
      if (resolved && !looksLikeSlug(resolved)) {
        filename = resolved;
      }

      if (!shouldIntercept(url, filename, config)) {
        try { await chrome.downloads.resume(downloadItem.id); } catch (e) {}
        return;
      }

      const minBytes = (config.minFileSize || 0) * 1024;
      if (minBytes > 0 && downloadItem.fileSize > 0 && downloadItem.fileSize < minBytes) {
        try { await chrome.downloads.resume(downloadItem.id); } catch (e) {}
        return;
      }

      await interceptDownload(downloadItem.id, url, filename, referrer, config);
    }, PENDING_TIMEOUT_MS)
  });
});

// 监听下载项变化，获取浏览器解析后的最终文件名
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta.filename) return;

  const pending = pendingDownloads.get(delta.id);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingDownloads.delete(delta.id);

  const finalPath = delta.filename.current || '';
  const filename = finalPath.split(/[/\\]/).pop() || pending.urlFilename;

  const { url, referrer, config } = pending;

  if (!shouldIntercept(url, filename, config)) {
    try { await chrome.downloads.resume(delta.id); } catch (e) {}
    return;
  }

  const minBytes = (config.minFileSize || 0) * 1024;
  if (minBytes > 0) {
    try {
      const [item] = await chrome.downloads.search({ id: delta.id });
      if (item && item.fileSize > 0 && item.fileSize < minBytes) {
        try { await chrome.downloads.resume(delta.id); } catch (e) {}
        return;
      }
    } catch (e) {}
  }

  await interceptDownload(delta.id, url, filename, referrer, config);
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

  let filename = extractFilename(url);
  const referrer = info.pageUrl || '';

  // 如果从 URL 提取的文件名看起来不像真实文件名，尝试 HEAD 请求解析
  if (!filename || looksLikeSlug(filename)) {
    const resolved = await resolveFilename(url);
    if (resolved && !looksLikeSlug(resolved)) {
      filename = resolved;
    }
  }

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
    (async () => {
      let filename = extractFilename(message.url);
      if (!filename || looksLikeSlug(filename)) {
        const resolved = await resolveFilename(message.url);
        if (resolved && !looksLikeSlug(resolved)) {
          filename = resolved;
        }
      }
      return sendToAria2(message.url, filename, '');
    })()
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
