// Agent Client Protocol driver (JSON-RPC 2.0 over stdio) for CLIs that speak it: Kimi Code
// (`kimi acp`) and Qwen Code (`qwen --acp`). One process per turn; a later turn reloads the session
// when the agent supports session/load. Permission requests come back to the workbench.
const { spawnCli, killTree, parseJson, flattenOutput } = require('./proc.cjs');

const KIND_TO_TOOL = { read: 'read_file', edit: 'write_file', delete: 'write_file', move: 'write_file', search: 'code_search', execute: 'shell', fetch: 'web_fetch', think: 'think' };
/** ACP reports MCP tools as kind "other" with the real name in the title (mcp__firefly-browser__browser_click). */
const toolName = (kind, title) => KIND_TO_TOOL[kind] || (title && /^[\w.-]+$/.test(title) ? title : kind || 'other');

/** ACP tool-call content → text (diffs become a compact unified-looking block). */
function acpContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    if (!c) return '';
    if (c.type === 'diff') return `--- ${c.path}\n+++ ${c.path}\n${String(c.oldText || '').split('\n').map((l) => `-${l}`).join('\n')}\n${String(c.newText || '').split('\n').map((l) => `+${l}`).join('\n')}`;
    if (c.type === 'content') return flattenOutput([c.content]);
    if (c.type === 'terminal') return `[终端 ${c.terminalId}]`;
    return flattenOutput([c]);
  }).filter(Boolean).join('\n').slice(0, 6000);
}

/**
 * spec: { exe, args, cwd, prompt, system, sessionId?, env, access: 'chat'|'work', label }
 */
function runAcp(spec, emit) {
  const label = spec.label || 'CLI';
  // ACP passes MCP servers as { name, command, args, env: [{ name, value }] }.
  const mcpServers = spec.mcp ? [{ name: 'firefly-browser', command: spec.mcp.command, args: spec.mcp.args, env: Object.entries(spec.mcp.env).map(([name, value]) => ({ name, value })) }] : [];
  let seq = 0;
  const pending = new Map();
  let sessionId = null;
  let stderr = '';
  let text = '';
  let finished = false;
  let stopped = false;
  let replaying = false;
  let fresh = true;
  const calls = new Map();
  const permissions = new Map(); // our requestId → rpc id + options
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const finish = (ev) => {
    if (finished) return;
    finished = true;
    for (const p of pending.values()) p.reject(new Error('closed'));
    pending.clear();
    emit(ev);
    resolveDone();
    setTimeout(() => killTree(child), 300);
  };

  const send = (obj) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`); } catch { /* closed */ } };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

  const onUpdate = (u) => {
    if (replaying || !u) return;
    const kind = u.sessionUpdate;
    const t = u.content && u.content.type === 'text' ? u.content.text : '';
    if (kind === 'agent_message_chunk' && t) { text += t; emit({ type: 'text', text: t }); }
    else if (kind === 'agent_thought_chunk' && t) emit({ type: 'thinking', text: t });
    else if (kind === 'tool_call') {
      calls.set(u.toolCallId, { kind: u.kind, title: u.title, input: u.rawInput });
      emit({ type: 'text-break' });
      emit({ type: 'tool', callId: u.toolCallId, name: toolName(u.kind, u.title), input: u.rawInput || {}, title: u.title || u.kind || '工具' });
      if (u.status === 'completed' || u.status === 'failed') emit({ type: 'tool-end', callId: u.toolCallId, ok: u.status === 'completed', output: acpContent(u.content) });
    } else if (kind === 'tool_call_update') {
      const old = calls.get(u.toolCallId);
      if (!old) {
        calls.set(u.toolCallId, { kind: u.kind, title: u.title, input: u.rawInput });
        emit({ type: 'tool', callId: u.toolCallId, name: toolName(u.kind, u.title), input: u.rawInput || {}, title: u.title || '工具' });
      }
      if (u.status === 'completed' || u.status === 'failed') emit({ type: 'tool-end', callId: u.toolCallId, ok: u.status === 'completed', output: acpContent(u.content) || (u.rawOutput ? flattenOutput(u.rawOutput) : '') });
    } else if (kind === 'plan' && Array.isArray(u.entries)) {
      emit({ type: 'plan', entries: u.entries.map((e) => ({ text: String(e.content || ''), status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending' })) });
    }
  };

  const child = spawnCli(spec.exe, spec.args || [], {
    cwd: spec.cwd,
    env: spec.env,
    onErr: (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); },
    onLine: (line) => {
      const msg = parseJson(line);
      if (!msg) return;
      if (msg.id !== undefined && !msg.method) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'ACP 错误'), { code: msg.error.code }));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'session/update') { onUpdate(msg.params && msg.params.update); return; }
      if (msg.method === 'session/request_permission' && msg.id !== undefined) {
        const p = msg.params || {};
        const options = Array.isArray(p.options) ? p.options : [];
        const allow = options.find((o) => o.kind === 'allow_once') || options.find((o) => o.kind === 'allow_always');
        const reject = options.find((o) => o.kind === 'reject_once') || options.find((o) => o.kind === 'reject_always');
        const reply = (optionId) => send({ id: msg.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
        if (spec.access === 'chat') { reply(reject && reject.optionId); return; }
        const tc = p.toolCall || {};
        const known = calls.get(tc.toolCallId) || {};
        const requestId = `acp_${msg.id}`;
        permissions.set(requestId, { reply, allow: allow && allow.optionId, reject: reject && reject.optionId });
        emit({ type: 'permission', requestId, callId: tc.toolCallId, name: toolName(tc.kind || known.kind, tc.title || known.title), input: tc.rawInput || known.input || {}, title: tc.title || known.title || '工具',
          paths: (Array.isArray(tc.locations) ? tc.locations : []).map((l) => l && l.path).filter((x) => typeof x === 'string') });
        return;
      }
      if (msg.method && msg.id !== undefined) {
        // We advertise no filesystem or terminal capability; the agent uses its own tools.
        send({ id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } });
      }
    },
  });

  child.on('error', (e) => finish({ type: 'error', message: `无法启动 ${label}：${e.message}`, code: 'SPAWN' }));
  child.on('close', (code) => {
    if (finished) return;
    if (stopped) { finish({ type: 'done', text, stopReason: 'interrupted', sessionId }); return; }
    const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    finish({ type: 'error', message: tail ? `${label} 退出（${code}）：${tail}` : `${label} 意外退出（${code}）`, code: `EXIT_${code}`, sessionId });
  });

  (async () => {
    try {
      const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'FireflyHarness', version: '2.1.0' } });
      const canLoad = !!(init && init.agentCapabilities && init.agentCapabilities.loadSession);
      if (spec.sessionId && canLoad) {
        replaying = true;
        try { await request('session/load', { sessionId: spec.sessionId, cwd: spec.cwd, mcpServers }); sessionId = spec.sessionId; fresh = false; }
        catch { sessionId = null; }
        replaying = false;
      }
      if (!sessionId) {
        const created = await request('session/new', { cwd: spec.cwd, mcpServers });
        sessionId = created && created.sessionId;
        if (!sessionId) throw new Error('没有拿到会话 ID');
        if (spec.sessionId) emit({ type: 'notice', level: 'warn', text: `${label} 不支持恢复上次的会话，已开始新会话。` });
      }
      emit({ type: 'session', sessionId });
      // A fresh session (never loaded, or load failed) needs the system prompt again.
      const prompt = fresh && spec.system ? `${spec.system}\n\n---\n\n${spec.prompt}` : spec.prompt;
      const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
      const reason = result && result.stopReason;
      if (reason === 'refusal') finish({ type: 'error', message: `${label} 拒绝了这次请求。`, code: 'REFUSAL', sessionId });
      else finish({ type: 'done', text, stopReason: stopped ? 'interrupted' : reason, sessionId });
    } catch (e) {
      if (finished) return;
      if (stopped) { finish({ type: 'done', text, stopReason: 'interrupted', sessionId }); return; }
      const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
      finish({ type: 'error', message: `${label}：${e.message}${tail ? `\n${tail}` : ''}`, code: e.code ? `ACP_${e.code}` : 'ACP', sessionId });
    }
  })();

  return {
    done,
    send: null,
    answer(requestId, decision) {
      const p = permissions.get(requestId);
      if (!p) return;
      permissions.delete(requestId);
      p.reply(decision === 'allow' ? p.allow : p.reject);
    },
    interrupt() {
      if (finished) return;
      stopped = true;
      for (const p of permissions.values()) p.reply(undefined);
      permissions.clear();
      if (sessionId) send({ method: 'session/cancel', params: { sessionId } });
      setTimeout(() => { if (!finished) killTree(child); }, 3000);
    },
    stop() { if (!finished) { stopped = true; killTree(child); } },
  };
}

module.exports = { runAcp };
