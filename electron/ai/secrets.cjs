// API keys, encrypted with the OS keychain (Electron safeStorage → Windows DPAPI) and kept in the
// app's user-data folder. Keys never go back to the page: it only learns that one is saved and its
// last four characters.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const PROVIDERS = new Set(['claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'doubao']);

function file() { return path.join(app.getPath('userData'), 'model-keys.json'); }

function readAll() {
  try {
    const data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function writeAll(data) {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  const tmp = `${file()}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file());
  } catch {
    // Some machines redirect AppData through a filter driver and rename fails with EXDEV: write in place.
    fs.writeFileSync(file(), body, { encoding: 'utf8', mode: 0o600 });
    try { fs.unlinkSync(tmp); } catch { /* leave it */ }
  }
}

const hintOf = (key) => `••••${key.slice(-4)}`;

function available() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

/** { provider: '••••abcd' } for every saved key. */
function hints() {
  const out = {};
  for (const [id, entry] of Object.entries(readAll())) if (PROVIDERS.has(id) && entry && entry.hint) out[id] = entry.hint;
  return out;
}

function save(provider, key) {
  if (!PROVIDERS.has(provider)) throw new Error('未知的模型服务');
  // Keys copied from a web page or a chat often carry zero-width characters that trim() leaves in.
  const clean = String(key || '').replace(/[\u200b-\u200d\u2060\ufeff]/g, '').trim();
  if (clean.length < 8 || clean.length > 4096 || /\s/.test(clean)) throw new Error('密钥格式不对：应为一串不含空格的字符');
  // Keys are plain ASCII; anything else (中文, 全角符号, …) would fail later as a header error that blames the network.
  if (!/^[\x21-\x7e]+$/.test(clean)) throw new Error('密钥里有看不见的字符或中文、全角符号，请重新复制');
  if (!available()) throw new Error('系统加密不可用，无法安全保存密钥');
  const data = readAll();
  data[provider] = { hint: hintOf(clean), value: safeStorage.encryptString(clean).toString('base64'), savedAt: Date.now() };
  writeAll(data);
  return data[provider].hint;
}

function clear(provider) {
  const data = readAll();
  if (data[provider]) { delete data[provider]; writeAll(data); }
}

/** Main-process only. */
function get(provider) {
  const entry = readAll()[provider];
  if (!entry || !entry.value) return null;
  try { return safeStorage.decryptString(Buffer.from(entry.value, 'base64')); } catch { return null; }
}

module.exports = { hints, save, clear, get, available, PROVIDERS };
