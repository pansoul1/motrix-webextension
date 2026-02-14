// =============================================
// Motrix Download Manager - In-page Toast
// =============================================

(function () {
  // 防止重复注入
  if (window.__motrixToastInjected) return;
  window.__motrixToastInjected = true;

  // 创建 toast 容器
  const container = document.createElement('div');
  container.id = 'motrix-toast-container';
  container.style.cssText = `
    position: fixed;
    bottom: 16px;
    left: 16px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column-reverse;
    gap: 8px;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;
  document.documentElement.appendChild(container);

  const LEVEL_STYLES = {
    success: {
      bg: '#f0fdf4',
      border: '#86efac',
      icon: '✅',
      titleColor: '#166534'
    },
    warning: {
      bg: '#fffbeb',
      border: '#fcd34d',
      icon: '⚠️',
      titleColor: '#92400e'
    },
    error: {
      bg: '#fef2f2',
      border: '#fca5a5',
      icon: '❌',
      titleColor: '#991b1b'
    }
  };

  function showToast(data) {
    const level = LEVEL_STYLES[data.level] || LEVEL_STYLES.error;

    const toast = document.createElement('div');
    toast.style.cssText = `
      pointer-events: auto;
      max-width: 380px;
      padding: 12px 16px;
      background: ${level.bg};
      border: 1px solid ${level.border};
      border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      display: flex;
      gap: 10px;
      align-items: flex-start;
      opacity: 0;
      transform: translateX(-60px);
      transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    `;

    const icon = document.createElement('span');
    icon.textContent = level.icon;
    icon.style.cssText = 'font-size: 18px; flex-shrink: 0; line-height: 1.4;';

    const body = document.createElement('div');
    body.style.cssText = 'flex: 1; min-width: 0;';

    const title = document.createElement('div');
    title.textContent = data.title || '';
    title.style.cssText = `
      font-size: 13px;
      font-weight: 700;
      color: ${level.titleColor};
      margin-bottom: 2px;
      line-height: 1.4;
    `;

    const msg = document.createElement('div');
    msg.textContent = data.message || '';
    msg.style.cssText = `
      font-size: 12px;
      color: #374151;
      line-height: 1.4;
      word-break: break-word;
    `;

    body.appendChild(title);
    if (data.message) body.appendChild(msg);

    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      cursor: pointer;
      font-size: 14px;
      color: #9ca3af;
      flex-shrink: 0;
      line-height: 1;
      padding: 2px;
    `;
    closeBtn.addEventListener('click', () => dismissToast(toast));

    toast.appendChild(icon);
    toast.appendChild(body);
    toast.appendChild(closeBtn);
    container.appendChild(toast);

    // 动画入场
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    });

    // 自动消失
    const duration = data.level === 'success' ? 4000 : 8000;
    setTimeout(() => dismissToast(toast), duration);
  }

  function dismissToast(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-60px)';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 350);
  }

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'showToast') {
      showToast(message.data);
    }
    if (message && message.type === 'openMotrix') {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      iframe.src = 'motrix://';
      document.body.appendChild(iframe);
      setTimeout(() => iframe.remove(), 1000);
    }
  });
})();
