// Model access for the page: IPC handlers for keys, CLI detection / login, folders, and streamed
// runs. The page describes what to run; this process decides which program or URL that means, adds
// the key, and streams events back. Nothing here runs unless the user started it from the page.
const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const secrets = require('./secrets.cjs');
const { resolveCommand, forgetCommand, runOnce, isWin, spawnCli, killTree } = require('./proc.cjs');
const { streamOpenAI, streamAnthropic } = require('./api.cjs');
const { runClaude } = require('./claude.cjs');
const { runCodex } = require('./codex.cjs');
const { runAcp } = require('./acp.cjs');
const { runDsh } = require('./dsh.cjs');
const skills = require('./skills.cjs');
const browser = require('./browser.cjs');

/** The programs this app may start. The page picks a driver id; the binary and fixed args live here. */
const DRIVERS = {
  'claude-code': { bin: 'claude', label: 'Claude Code', login: ['auth', 'login'], loginHint: '按提示在浏览器里登录 Claude 账号。' },
  codex: { bin: 'codex', label: 'Codex', login: ['login'], loginHint: '按提示在浏览器里登录 ChatGPT 账号。' },
  kimi: { bin: 'kimi', label: 'Kimi Code', acpArgs: ['acp'], login: ['login'], loginHint: '按提示在浏览器里登录 Kimi 账号；如果命令不认识 login，直接运行 kimi 后输入 /login。' },
  qwen: { bin: 'qwen', label: 'Qwen Code', acpArgs: ['--acp'], login: null, loginHint: 'Qwen Code 使用阿里云百炼的 API Key，在萤火里保存密钥即可。' },
  mcode: { bin: 'mcode', label: 'MiniMax Code', acpArgs: ['acp'], login: ['login'], loginHint: '按提示在浏览器里登录 MiniMax 账号（海外账号请改用 mcode login --region global）。' },
  dsh: { bin: 'dsh', label: 'DeepSeek Harness', login: null, loginHint: '请在 DeepSeek Harness 桌面版里登录 DeepSeek 账号，登录状态会共享给命令行。' },
};

/** Where the DeepSeek Harness desktop app keeps its CLI when it is not on PATH. */
function dshCandidates() {
  const rel = path.join('resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  // Only places a normal user cannot plant a dsh.cmd for someone else; anything else goes in 命令路径.
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DeepSeek Harness'),
  ].filter(Boolean);
  return roots.map((r) => path.join(r, rel));
}

/** CLIs that AIROOM installed for its members live under its data folder, off PATH:
 *  <data>/members/<bin>/<version>/node_modules/.bin/<bin>.cmd — newest version first. */
function managedCandidates(bin) {
  const roots = [process.env.AIROOM_DATA_DIR, process.env.APPDATA && path.join(process.env.APPDATA, 'AIROOM', 'data')].filter(Boolean);
  const out = [];
  for (const root of roots) {
    const dir = path.join(root, 'members', bin);
    let versions = [];
    try { versions = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) out.push(path.join(dir, v, 'node_modules', '.bin', `${bin}.cmd`));
  }
  return out;
}

function exeFor(driverId, custom) {
  const d = DRIVERS[driverId];
  if (!d) return null;
  if (custom) return fs.existsSync(custom) && /\.(cmd|exe|bat)$/i.test(custom) ? custom : null;
  const found = resolveCommand(d.bin);
  if (found) return found;
  const extra = [...managedCandidates(d.bin), ...(driverId === 'dsh' ? dshCandidates() : [])];
  return extra.find((p) => fs.existsSync(p)) || null;
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/** Only small, known reasoning settings may ride along in an API request body. */
function cleanExtra(extra) {
  if (!extra || typeof extra !== 'object') return undefined;
  const out = {};
  if (typeof extra.reasoning_effort === 'string' && EFFORTS.has(extra.reasoning_effort)) out.reasoning_effort = extra.reasoning_effort;
  if (typeof extra.enable_thinking === 'boolean') out.enable_thinking = extra.enable_thinking;
  if (typeof extra.reasoning_split === 'boolean') out.reasoning_split = extra.reasoning_split;
  const t = extra.thinking;
  if (t && typeof t === 'object' && ['enabled', 'disabled', 'adaptive', 'between_tools'].includes(t.type)) {
    out.thinking = { type: t.type };
    if (typeof t.budget_tokens === 'number' && t.budget_tokens > 0 && t.budget_tokens < 200000) out.thinking.budget_tokens = Math.floor(t.budget_tokens);
    if (t.display === 'summarized' || t.display === 'omitted') out.thinking.display = t.display;
  }
  const o = extra.output_config;
  if (o && typeof o === 'object' && typeof o.effort === 'string' && EFFORTS.has(o.effort)) out.output_config = { effort: o.effort };
  return Object.keys(out).length ? out : undefined;
}

const ENV_KEYS = /^(ANTHROPIC_(BASE_URL|MODEL|DEFAULT_(FABLE|OPUS|SONNET|HAIKU)_MODEL|SMALL_FAST_MODEL)|OPENAI_(BASE_URL|MODEL)|KIMI_MODEL_(NAME|BASE_URL|PROVIDER_TYPE|MAX_CONTEXT_SIZE)|API_TIMEOUT_MS|CLAUDE_CODE_(DISABLE_NONESSENTIAL_TRAFFIC|MAX_OUTPUT_TOKENS|SUBAGENT_MODEL|AUTO_COMPACT_WINDOW|MAX_CONTEXT_TOKENS|EFFORT_LEVEL))$/;
const KEY_ENVS = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'KIMI_MODEL_API_KEY']);

function safeBaseUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol === 'https:') return u.toString().replace(/\/+$/, '');
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.toString().replace(/\/+$/, '');
  } catch { /* fall through */ }
  return null;
}

function workspaceRoot() { return path.join(app.getPath('userData'), 'workspaces'); }

function checkDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/** Replace every occurrence of a secret in an event's strings. */
function scrub(value, secret) {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join('••••');
  if (Array.isArray(value)) return value.map((v) => scrub(v, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secret)]));
  return value;
}

/* ───────────── streamed runs ───────────── */

const streams = new Map(); // id → { ctl, sender }
let streamSeq = 0;

function startStream(sender, spec) {
  const id = `s${Date.now().toString(36)}${(++streamSeq).toString(36)}`;
  const emit = (ev) => { if (!sender.isDestroyed()) sender.send('ai:event', { id, ...ev }); };
  const entry = { ctl: null, sender };
  streams.set(id, entry);
  const end = () => { streams.delete(id); };

  const fail = (message, code = 'CONFIG') => { setImmediate(() => { emit({ type: 'error', message, code }); end(); }); return id; };
  const provider = String(spec.provider || '');
  if (!secrets.PROVIDERS.has(provider)) return fail('未知的模型服务。');

  if (spec.driver === 'api-openai' || spec.driver === 'api-anthropic') {
    const baseUrl = safeBaseUrl(spec.baseUrl);
    if (!baseUrl) return fail('服务地址必须是 https:// 开头。');
    const key = secrets.get(provider);
    if (!key) return fail('还没有保存这个服务的 API Key。');
    if (!spec.model) return fail('请先选择模型。');
    const ac = new AbortController();
    entry.ctl = { stop: () => ac.abort(), interrupt: () => ac.abort() };
    const run = spec.driver === 'api-openai' ? streamOpenAI : streamAnthropic;
    run({ ...spec, baseUrl, extraBody: cleanExtra(spec.extraBody) }, key, emit, ac.signal)
      .then((r) => emit({ type: 'done', text: r.text, stopReason: r.stopReason }))
      .catch((e) => {
        if (e.code === 'ABORTED') emit({ type: 'done', text: '', stopReason: 'interrupted' });
        else emit({ type: 'error', message: e.message || String(e), code: e.code || 'API_ERROR' });
      })
      .finally(end);
    return id;
  }

  const driverId = spec.driver === 'acp' ? spec.acp : spec.driver === 'claude-compat' ? 'claude-code' : spec.driver;
  const drv = DRIVERS[driverId];
  if (!drv || (spec.driver === 'acp' && !drv.acpArgs)) return fail('未知的命令行工具。');
  const exe = exeFor(driverId, spec.path);
  if (!exe) return fail(`找不到 ${drv.label} 命令。请先安装，或在「模型接入」里填写它的路径。`, 'ENOENT');
  const cwd = checkDir(spec.cwd);
  if (!cwd) return fail('工作文件夹不存在，请重新选择。', 'ENOENT');

  const env = {};
  for (const [k, v] of Object.entries(spec.env || {})) {
    if (ENV_KEYS.test(k) && typeof v === 'string' && v.length < 2000) env[k] = v;
  }
  let emitOut = emit;
  if (spec.keyEnv) {
    if (!KEY_ENVS.has(spec.keyEnv)) return fail('不支持的密钥变量。');
    const key = secrets.get(provider);
    if (!key) return fail('这个方式需要 API Key，请先在「模型接入」里保存。');
    env[spec.keyEnv] = key;
    // The agent's shell inherits the key; never let it come back to the page (tool output, text…).
    emitOut = (ev) => emit(scrub(ev, key));
  }
  if (spec.sessionId && !/^[\w.:-]{1,100}$/.test(String(spec.sessionId))) return fail('会话 ID 格式不对。');
  if (env.ANTHROPIC_BASE_URL && !safeBaseUrl(env.ANTHROPIC_BASE_URL)) return fail('服务地址必须是 https:// 开头。');
  if (env.OPENAI_BASE_URL && !safeBaseUrl(env.OPENAI_BASE_URL)) return fail('服务地址必须是 https:// 开头。');
  if (spec.driver === 'claude-compat') {
    // Another vendor's endpoint: keep its sessions and settings apart from the user's own Claude Code.
    const dir = path.join(app.getPath('userData'), 'claude-compat', provider);
    fs.mkdirSync(dir, { recursive: true });
    env.CLAUDE_CONFIG_DIR = dir;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    // Never forward the user's own Anthropic credentials to another vendor's endpoint.
    env.ANTHROPIC_API_KEY = '';
    env.CLAUDE_CODE_OAUTH_TOKEN = '';
    env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  }
  // DeepSeek Harness has no per-call approvals: chat and 只读 run it in its read-only mode.
  if (driverId === 'dsh' && (spec.access === 'chat' || spec.readOnly)) env.DSH_PERMISSION_MODE = 'read-only';
  if (spec.effort && !EFFORTS.has(String(spec.effort))) return fail('不支持的强度档位。');
  // Model names go on the command line: letters, digits and . _ - : / [ ] only.
  if (spec.model && !/^[\w.\-:/[\]]{1,100}$/.test(String(spec.model))) return fail('模型名里有不支持的字符。');
  const common = { exe, cwd, prompt: String(spec.prompt || ''), system: spec.system ? String(spec.system) : '', sessionId: spec.sessionId || undefined, model: spec.model || undefined, effort: spec.effort || undefined, env };
  const emitCli = emitOut;
  const tail = () => end();
  // 浏览器控制: hand the agent the firefly-browser MCP server (not in chat, not for DSH).
  const ep = spec.browser && spec.access !== 'chat' && !spec.readOnly && driverId !== 'dsh' ? browser.getEndpoint() : null;
  const mcp = ep ? browser.mcpLaunch(ep) : null;
  try {
    if (driverId === 'claude-code') {
      const allow = (spec.allow || []).filter((t) => /^[\w*:().\- ]{1,80}$/.test(t));
      const deny = (spec.deny || []).filter((t) => /^[\w*:().\- ]{1,80}$/.test(t));
      // The skills folder lives outside the working folder: let Claude Code read it.
      const addDirs = spec.skills ? [skills.root()] : [];
      entry.ctl = runClaude({ ...common, access: spec.access === 'chat' ? 'chat' : 'work', allow, deny, addDirs, mcpConfig: mcp ? claudeMcpFile(mcp) : undefined }, emitCli);
    } else if (driverId === 'codex') {
      entry.ctl = runCodex({ ...common, sandbox: spec.sandbox, webSearch: !!spec.webSearch, mcp }, emitCli);
    } else if (driverId === 'dsh') {
      entry.ctl = runDsh(common, emitCli);
    } else {
      entry.ctl = runAcp({ ...common, args: drv.acpArgs, access: spec.access === 'chat' ? 'chat' : 'work', label: drv.label, mcp }, emitCli);
    }
    entry.ctl.done.then(tail);
  } catch (e) {
    return fail(`启动失败：${e.message}`, 'SPAWN');
  }
  return id;
}

/** Claude Code reads MCP servers from a JSON file (--mcp-config); a temp file avoids quoting JSON through cmd.exe. */
function claudeMcpFile(mcp) {
  const file = path.join(os.tmpdir(), `firefly-mcp-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'firefly-browser': { type: 'stdio', command: mcp.command, args: mcp.args, env: mcp.env } } }), 'utf8');
  return file;
}

/* ───────────── live model lists ───────────── */

const modelCache = new Map(); // driver → { at, list }

/** Codex knows which models the signed-in account can use and their effort levels (app-server model/list). */
function codexModels(exe) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { killTree(child); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => finish(null), 20000);
    const send = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch { /* closed */ } };
    child = spawnCli(exe, ['app-server'], {
      cwd: os.homedir(),
      onLine: (line) => {
        let ev; try { ev = JSON.parse(line); } catch { return; }
        if (ev.id === 1) { send({ jsonrpc: '2.0', method: 'initialized', params: {} }); send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} }); }
        else if (ev.id === 2) {
          const data = (ev.result && ev.result.data) || [];
          finish(data.filter((m) => !m.hidden && typeof m.id === 'string').map((m) => ({
            id: m.id,
            label: String(m.displayName || m.id),
            note: String(m.description || '').slice(0, 80),
            efforts: (m.supportedReasoningEfforts || []).map((e) => String(e.reasoningEffort || e)).filter((e) => EFFORTS.has(e)),
            defaultEffort: EFFORTS.has(m.defaultReasoningEffort) ? m.defaultReasoningEffort : undefined,
            isDefault: !!m.isDefault,
          })));
        }
      },
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'FireflyHarness', title: '萤火', version: '2.0.0' } } });
  });
}

async function listModels({ driver, path: custom, fresh }) {
  if (driver !== 'codex') return null;
  const hit = modelCache.get(driver);
  if (hit && !fresh && Date.now() - hit.at < 3_600_000) return hit.list;
  const exe = exeFor(driver, custom);
  if (!exe) return null;
  const list = await codexModels(exe);
  if (list && list.length) modelCache.set(driver, { at: Date.now(), list });
  return list;
}

/* ───────────── detection & login ───────────── */

async function detect({ driver, path: custom }) {
  const d = DRIVERS[driver === 'claude-compat' ? 'claude-code' : driver];
  if (!d) return { found: false, detail: '未知的命令行工具' };
  forgetCommand(d.bin);
  const exe = exeFor(driver === 'claude-compat' ? 'claude-code' : driver, custom);
  if (!exe) return { found: false, detail: custom ? '这个路径不存在，或不是可执行文件' : `PATH 里没有找到 ${d.bin}` };
  const cwd = os.tmpdir();
  const v = await runOnce(exe, ['--version'], { cwd, timeoutMs: 20000 });
  const version = (v.out || v.err).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const out = { found: true, path: exe, version: version.slice(0, 80), login: 'unknown' };
  if (driver === 'claude-code') {
    const s = await runOnce(exe, ['auth', 'status', '--json'], { cwd, timeoutMs: 20000 });
    try {
      const j = JSON.parse(s.out);
      out.login = j.loggedIn ? 'yes' : 'no';
      out.account = [j.authMethod && j.authMethod !== 'none' ? j.authMethod : '', j.email || j.account || ''].filter(Boolean).join(' · ');
    } catch { /* older versions: unknown */ }
  } else if (driver === 'codex') {
    const s = await runOnce(exe, ['login', 'status'], { cwd, timeoutMs: 20000 });
    const text = `${s.out}\n${s.err}`;
    if (/not logged in/i.test(text)) out.login = 'no';
    else if (/logged in/i.test(text)) { out.login = 'yes'; out.account = (text.match(/logged in using ([^\r\n]+)/i) || [])[1] || ''; }
  } else if (driver === 'claude-compat') {
    out.login = 'n/a';
  }
  return out;
}

function openLogin({ driver, path: custom }) {
  const d = DRIVERS[driver];
  if (!d) return { ok: false, error: '未知的命令行工具' };
  if (!d.login) return { ok: false, error: d.loginHint };
  const exe = exeFor(driver, custom);
  if (!exe) return { ok: false, error: `找不到 ${d.bin} 命令` };
  if (!isWin) return { ok: false, error: `请在终端运行：${d.bin} ${d.login.join(' ')}` };
  // A small PowerShell script in a visible console: the user signs in there themselves. Not a .cmd:
  // cmd.exe reads batch files by byte offset, so Chinese lines after `chcp 65001` come out garbled
  // and half a line can even run as a command.
  const file = path.join(os.tmpdir(), `firefly-login-${driver}.ps1`);
  fs.writeFileSync(file, loginScript(d, exe), 'utf8');
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${file}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true, command: `${d.bin} ${d.login.join(' ')}` };
}

/** The login window's script: UTF-8 with a BOM (what Windows PowerShell 5.1 needs), every value a
    single-quoted literal so nothing in a path or a hint can run as code. */
function loginScript(d, exe) {
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const lines = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$Host.UI.RawUI.WindowTitle = ${ps(`${d.label} 登录 - 萤火`)}`,
    `Write-Host ${ps(d.loginHint)} -ForegroundColor Cyan`,
    `Write-Host ${ps('完成后关闭这个窗口，回到萤火点「检测」。')}`,
    'Write-Host',
    `& ${ps(exe)} ${d.login.map(ps).join(' ')}`,
    '$code = $LASTEXITCODE',
    'Write-Host',
    `if ($code -eq 0) { Write-Host ${ps('登录命令已结束。上面显示已登录（Logged in）的话，就可以关闭窗口，回到萤火点「检测」。')} -ForegroundColor Green }`,
    `else { Write-Host (${ps('登录命令退出（代码 ')} + $code + ${ps('）。如果上面已经显示登录成功，可以忽略；否则请再试一次。')}) -ForegroundColor Yellow }`,
    `Write-Host ${ps('提示：命令结束时如果出现 Assertion failed 之类的英文，是这个命令行工具退出时自己的提示，不影响登录结果。')} -ForegroundColor DarkGray`,
    'Write-Host',
    `[void](Read-Host ${ps('按回车关闭这个窗口')})`,
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** A tiny round trip that proves the connection works. */
function test(sender, spec) {
  return new Promise((settle) => {
    const started = Date.now();
    let text = '';
    let model = '';
    let timer;
    const resolve = (r) => { clearTimeout(timer); settle(r); };
    const isCli = !String(spec.driver).startsWith('api-');
    let cwd = spec.cwd;
    if (isCli) {
      cwd = path.join(workspaceRoot(), '_connection-test');
      fs.mkdirSync(cwd, { recursive: true });
    }
    const id = startStream({
      isDestroyed: () => false,
      send: (_ch, ev) => {
        if (ev.type === 'text') text += ev.text;
        else if (ev.type === 'model') model = ev.model;
        else if (ev.type === 'done') resolve({ ok: true, text: (text || ev.text || '').trim().slice(0, 200), ms: Date.now() - started, model });
        else if (ev.type === 'error') resolve({ ok: false, error: ev.message, code: ev.code, ms: Date.now() - started });
      },
    }, { ...spec, cwd, access: 'chat', sandbox: 'read-only', prompt: '连通性测试：请只回复两个字母 OK。', messages: [{ role: 'user', content: '连通性测试：请只回复两个字母 OK。' }], maxTokens: 64, system: '' });
    timer = setTimeout(() => {
      const s = streams.get(id);
      if (s && s.ctl) s.ctl.stop();
      resolve({ ok: false, error: '超过 2 分钟没有完成', code: 'ETIMEDOUT', ms: Date.now() - started });
    }, 120_000);
  });
}

/* ───────────── IPC ───────────── */

/** Only the app's own page may call the model / skills / browser handlers. */
const APP_URL = require('node:url').pathToFileURL(path.join(__dirname, '..', '..', 'dist', 'index.html')).href;
function fromApp(e) {
  const url = e && e.senderFrame && e.senderFrame.url;
  return typeof url === 'string' && url.split('#')[0] === APP_URL;
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('拒绝：调用不是来自萤火页面');
    return fn(e, ...args);
  });
}

function register() {
  // The bridge the browser MCP server calls back to (127.0.0.1, random port and token).
  browser.startBridge().catch(() => {});
  handle('browser:open', () => browser.open());
  handle('browser:clear', () => browser.clearData());
  handle('ai:info', () => ({
    encryption: secrets.available(),
    keys: secrets.hints(),
    workspaceRoot: workspaceRoot(),
    platform: process.platform,
  }));
  handle('ai:key:save', (_e, provider, key) => {
    try { return { ok: true, hint: secrets.save(String(provider), key) }; } catch (e) { return { ok: false, error: e.message }; }
  });
  handle('ai:key:clear', (_e, provider) => { secrets.clear(String(provider)); return { ok: true }; });
  handle('ai:detect', (_e, req) => detect(req || {}));
  handle('ai:models', (_e, req) => listModels(req || {}).catch(() => null));
  handle('ai:login', (_e, req) => openLogin(req || {}));
  handle('ai:test', (e, spec) => test(e.sender, spec || {}));
  handle('ai:folder:pick', async (e, start) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: '选择工作文件夹', defaultPath: checkDir(start) || undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  handle('ai:folder:workspace', (_e, name) => {
    const safe = String(name || 'task').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'task';
    const dir = path.join(workspaceRoot(), safe);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  handle('ai:folder:open', (_e, dir) => (checkDir(dir) ? shell.openPath(dir) : '文件夹不存在'));
  handle('ai:start', (e, spec) => startStream(e.sender, spec || {}));
  handle('ai:input', (_e, id, text) => {
    const s = streams.get(id);
    if (!s || !s.ctl || !s.ctl.send) return false;
    s.ctl.send(String(text));
    return true;
  });
  handle('ai:answer', (_e, id, requestId, decision, input) => {
    const s = streams.get(id);
    if (!s || !s.ctl || !s.ctl.answer) return false;
    s.ctl.answer(String(requestId), decision === 'allow' ? 'allow' : 'deny', input);
    return true;
  });
  handle('skills:list', () => { try { return skills.list(); } catch (e) { return { root: '', skills: [], error: e.message }; } });
  handle('skills:import', (e) => skills.importSkill(e.sender));
  handle('skills:import:confirm', (_e, token) => skills.confirmImport(token));
  handle('skills:create', (_e, name) => { try { return skills.createSkill(name); } catch (e) { return { ok: false, error: e.message }; } });
  handle('skills:examples', () => { try { return skills.installExamples(); } catch (e) { return { ok: false, error: e.message }; } });
  handle('skills:enable', (_e, folder, enabled) => skills.setEnabled(String(folder), !!enabled));
  handle('skills:remove', (_e, folder) => skills.removeSkill(folder).catch((e) => ({ ok: false, error: e.message })));
  handle('skills:open', (_e, folder) => {
    const dir = folder ? skills.folderPath(folder) : skills.root();
    return dir ? shell.openPath(dir) : '找不到这个技能';
  });
  handle('ai:stop', (_e, id, how) => {
    const s = streams.get(id);
    if (!s || !s.ctl) return false;
    if (how === 'interrupt') s.ctl.interrupt(); else s.ctl.stop();
    return true;
  });
}

function stopAll() {
  for (const s of streams.values()) { try { s.ctl && s.ctl.stop(); } catch { /* gone */ } }
  streams.clear();
}

module.exports = { register, stopAll };
