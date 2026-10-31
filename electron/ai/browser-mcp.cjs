// MCP stdio server "firefly-browser", started by a CLI agent (Claude Code, Codex, Kimi / Qwen /
// MiniMax Code). It has no browser of its own: every tool call goes to the workbench over
// 127.0.0.1 (FF_BROWSER_URL + FF_BROWSER_TOKEN), which drives the 萤火浏览器 window.
// Runs as plain Node (Electron with ELECTRON_RUN_AS_NODE=1); no dependencies.
'use strict';

const URL_ = process.env.FF_BROWSER_URL;
const TOKEN = process.env.FF_BROWSER_TOKEN;

const ref = { type: 'integer', description: 'The element ref from the latest browser_snapshot (e.g. 12).' };
const element = { type: 'string', description: 'Human-readable description of the element, shown to the user when asking permission (e.g. "登录按钮").' };

const TOOLS = [
  { name: 'browser_navigate', description: 'Open a web page (http/https) in the 萤火浏览器 window and return a snapshot of it.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_snapshot', description: 'Read the current page: title, URL, the interactive elements with their refs, and the visible text. Call it again after the page changes.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_click', description: 'Click an element by ref (from browser_snapshot). Returns a new snapshot.', inputSchema: { type: 'object', properties: { ref, element }, required: ['ref', 'element'] } },
  { name: 'browser_type', description: 'Type text into an input / textarea / editable element by ref. Clears it first unless clear=false; submit=true presses Enter after typing.', inputSchema: { type: 'object', properties: { ref, element, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } }, required: ['ref', 'element', 'text'] } },
  { name: 'browser_press', description: 'Press a key in the page: Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp, PageDown, Home, End, Space.', inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'browser_scroll', description: 'Scroll the page one screen up or down and return a new snapshot.', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] } },
  { name: 'browser_back', description: 'Go back to the previous page.', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_screenshot', description: 'Take a screenshot of the visible part of the page (PNG).', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_wait', description: 'Wait a few seconds (0.2–10) for the page to finish something, then return a snapshot.', inputSchema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] } },
];

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

async function call(name, args) {
  if (!URL_ || !TOKEN) return { content: [{ type: 'text', text: '萤火浏览器没有连上（缺少 FF_BROWSER_URL / FF_BROWSER_TOKEN）。' }], isError: true };
  try {
    const res = await fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ff-token': TOKEN }, body: JSON.stringify({ tool: name, args: args || {} }) });
    if (!res.ok) return { content: [{ type: 'text', text: `萤火浏览器拒绝了请求（HTTP ${res.status}）。` }], isError: true };
    return await res.json();
  } catch (e) {
    return { content: [{ type: 'text', text: `连不上萤火工作台：${e.message}（工作台是否已关闭？）` }], isError: true };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'firefly-browser', version: '2.1.0' },
      instructions: 'Tools to drive the 萤火浏览器 window. Typical loop: browser_navigate → read the snapshot → browser_click / browser_type by ref → read the new snapshot. Refs change when the page changes.' } });
    return;
  }
  if (method === 'ping') { if (id !== undefined) send({ id, result: {} }); return; }
  if (method === 'tools/list') { send({ id, result: { tools: TOOLS } }); return; }
  if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS.some((t) => t.name === name)) { send({ id, result: { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true } }); return; }
    send({ id, result: await call(name, params.arguments) });
    return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => { if (msg.id !== undefined) send({ id: msg.id, error: { code: -32603, message: e.message } }); });
  }
});
process.stdin.on('end', () => process.exit(0));
