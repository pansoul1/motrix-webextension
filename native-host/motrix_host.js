#!/usr/bin/env node
// =============================================
// Motrix Download Manager - Native Messaging Host
// 通过 Chrome Native Messaging 启动 Motrix，避免浏览器协议弹窗
// =============================================

const { execFile, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// --- Chrome Native Messaging 协议 ---

function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let headerBuf = Buffer.alloc(0);
    let msgLen = -1;
    let bodyBuf = Buffer.alloc(0);

    process.stdin.on('data', (chunk) => {
      let offset = 0;

      // 读取 4 字节长度前缀
      if (msgLen === -1) {
        const need = 4 - headerBuf.length;
        const slice = chunk.slice(0, need);
        headerBuf = Buffer.concat([headerBuf, slice]);
        offset = slice.length;

        if (headerBuf.length < 4) return;
        msgLen = headerBuf.readUInt32LE(0);
        if (msgLen === 0) {
          resolve({});
          return;
        }
      }

      // 读取消息体
      const remaining = chunk.slice(offset);
      bodyBuf = Buffer.concat([bodyBuf, remaining]);

      if (bodyBuf.length >= msgLen) {
        try {
          resolve(JSON.parse(bodyBuf.slice(0, msgLen).toString('utf8')));
        } catch (e) {
          reject(new Error('Invalid JSON: ' + e.message));
        }
      }
    });

    process.stdin.on('end', () => {
      if (msgLen === -1) {
        reject(new Error('stdin closed before message received'));
      }
    });

    // 超时保护
    setTimeout(() => reject(new Error('read timeout')), 5000);
  });
}

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  const buf = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(header);
  process.stdout.write(buf);
}

// --- 查找 Motrix 可执行文件 ---

function findMotrix() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'AppData', 'Local', 'Programs', 'Motrix', 'Motrix.exe'),
    'C:\\Program Files\\Motrix\\Motrix.exe',
    'C:\\Program Files (x86)\\Motrix\\Motrix.exe',
    path.join(home, 'AppData', 'Local', 'Motrix', 'Motrix.exe'),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (e) {
      // ignore
    }
  }

  // 尝试从注册表查找 motrix:// 协议处理器路径
  try {
    const { execSync } = require('child_process');
    const regOutput = execSync(
      'reg query "HKCU\\Software\\Classes\\motrix\\shell\\open\\command" /ve',
      { encoding: 'utf8', timeout: 3000 }
    );
    const match = regOutput.match(/"([^"]+\.exe)"/i);
    if (match && fs.existsSync(match[1])) {
      return match[1];
    }
  } catch (e) {
    // ignore
  }

  return null;
}

// --- 启动 Motrix ---

function launchMotrix() {
  return new Promise((resolve) => {
    const motrixPath = findMotrix();

    if (motrixPath) {
      const motrixDir = path.dirname(motrixPath);
      // Use 'start' command via cmd.exe — this matches how Windows launches apps
      // on double-click and works reliably with Electron apps
      exec(`start "" "${motrixPath}"`, {
        cwd: motrixDir,
        timeout: 10000,
        windowsHide: true
      }, (err) => {
        if (err) {
          resolve({ success: false, error: 'Failed to launch: ' + err.message, path: motrixPath });
        } else {
          resolve({ success: true, method: 'exe', path: motrixPath });
        }
      });
    } else {
      // Fallback: use protocol handler via shell (no browser popup from native process)
      exec('start motrix://', { timeout: 5000 }, (err) => {
        if (err) {
          resolve({ success: false, error: 'Motrix not found and protocol launch failed' });
        } else {
          resolve({ success: true, method: 'protocol' });
        }
      });
    }
  });
}

// --- 主流程 ---

async function main() {
  try {
    const msg = await readMessage();

    if (msg.action === 'launch') {
      const result = await launchMotrix();
      sendMessage(result);
    } else {
      sendMessage({ success: false, error: 'Unknown action: ' + (msg.action || '(none)') });
    }
  } catch (e) {
    try {
      sendMessage({ success: false, error: e.message });
    } catch (_) {
      // stdout may be closed
    }
  }

  process.exit(0);
}

main();
