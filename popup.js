// =============================================
// Motrix Download Manager - Popup Script
// =============================================

const DEFAULT_CONFIG = {
  enabled: true,
  rpcUrl: 'http://localhost:16800/jsonrpc',
  rpcSecret: '',
  fileExtensions: '',
  minFileSize: 0
};

// DOM 元素
const toggleEnabled = document.getElementById('toggleEnabled');
const statusBar = document.getElementById('statusBar');
const statusText = document.getElementById('statusText');
const rpcUrl = document.getElementById('rpcUrl');
const rpcSecret = document.getElementById('rpcSecret');
const testBtn = document.getElementById('testBtn');
const testResult = document.getElementById('testResult');
const fileExtensions = document.getElementById('fileExtensions');
const minFileSize = document.getElementById('minFileSize');
const manualUrl = document.getElementById('manualUrl');
const downloadBtn = document.getElementById('downloadBtn');
const downloadResult = document.getElementById('downloadResult');
const saveBtn = document.getElementById('saveBtn');

// 初始化：从 storage 加载配置
async function loadConfig() {
  const config = await chrome.storage.sync.get(DEFAULT_CONFIG);

  toggleEnabled.checked = config.enabled;
  rpcUrl.value = config.rpcUrl;
  rpcSecret.value = config.rpcSecret;
  fileExtensions.value = config.fileExtensions;
  minFileSize.value = config.minFileSize || '';

  updateStatusBar(config.enabled);
}

// 更新状态栏显示
function updateStatusBar(enabled) {
  if (enabled) {
    statusBar.classList.remove('disabled');
    statusText.textContent = '已启用 - 下载将被拦截';
  } else {
    statusBar.classList.add('disabled');
    statusText.textContent = '已禁用 - 浏览器正常下载';
  }
}

// 显示结果消息
function showResult(element, message, isSuccess) {
  element.textContent = message;
  element.className = isSuccess ? 'test-result show success' : 'test-result show error';

  setTimeout(() => {
    element.className = 'test-result';
    element.textContent = '';
  }, 5000);
}

// 开关切换
toggleEnabled.addEventListener('change', async () => {
  const enabled = toggleEnabled.checked;
  await chrome.storage.sync.set({ enabled });
  updateStatusBar(enabled);
});

// 测试连接
testBtn.addEventListener('click', async () => {
  const url = rpcUrl.value.trim();
  if (!url) {
    showResult(testResult, '请填写 RPC 地址', false);
    return;
  }

  testBtn.disabled = true;
  testBtn.textContent = '连接中...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'testConnection',
      rpcUrl: url,
      rpcSecret: rpcSecret.value.trim()
    });

    if (response.success) {
      showResult(testResult, `✅ 连接成功！aria2 版本: ${response.version}`, true);
    } else {
      showResult(testResult, `❌ 连接失败: ${response.error}`, false);
    }
  } catch (err) {
    showResult(testResult, `❌ 连接失败: ${err.message}`, false);
  } finally {
    testBtn.disabled = false;
    testBtn.innerHTML = '<span class="btn-icon">🔗</span>测试连接';
  }
});

// 手动下载
downloadBtn.addEventListener('click', async () => {
  const url = manualUrl.value.trim();
  if (!url) {
    showResult(downloadResult, '请输入下载链接', false);
    return;
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    showResult(downloadResult, '请输入有效的 HTTP/HTTPS 链接', false);
    return;
  }

  downloadBtn.disabled = true;
  downloadBtn.textContent = '发送中...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'addDownload',
      url: url
    });

    if (response.success) {
      showResult(downloadResult, '✅ 已发送到 Motrix！', true);
      manualUrl.value = '';
    } else {
      showResult(downloadResult, `❌ 发送失败: ${response.error}`, false);
    }
  } catch (err) {
    showResult(downloadResult, `❌ 发送失败: ${err.message}`, false);
  } finally {
    downloadBtn.disabled = false;
    downloadBtn.innerHTML = '<span class="btn-icon">⬇️</span>发送到 Motrix';
  }
});

// 保存设置
saveBtn.addEventListener('click', async () => {
  const config = {
    enabled: toggleEnabled.checked,
    rpcUrl: rpcUrl.value.trim() || DEFAULT_CONFIG.rpcUrl,
    rpcSecret: rpcSecret.value.trim(),
    fileExtensions: fileExtensions.value.trim(),
    minFileSize: parseInt(minFileSize.value) || 0
  };

  await chrome.storage.sync.set(config);

  saveBtn.textContent = '✅ 已保存';
  saveBtn.style.background = '#43a047';

  setTimeout(() => {
    saveBtn.textContent = '保存设置';
    saveBtn.style.background = '';
  }, 1500);
});

// 回车键触发手动下载
manualUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    downloadBtn.click();
  }
});

// 页面加载时读取配置
loadConfig();
