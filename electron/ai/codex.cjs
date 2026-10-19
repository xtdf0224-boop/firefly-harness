// Codex driver: `codex exec --json`, prompt on stdin, one process per turn (later turns resume the
// thread). Codex exec cannot ask for approval mid-run: it follows the sandbox it was started with.
const { spawnCli, killTree, parseJson } = require('./proc.cjs');

/** An MCP tool result as text: its text parts, images as a placeholder. */
function mcpText(result) {
  if (!result) return '';
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts.map((c) => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[截图]' : '')).filter(Boolean).join('\n');
  return (text || JSON.stringify(result)).slice(0, 6000);
}

/** Codex wraps every command as `"…\powershell.exe" -Command "<script>"`: show the script itself. */
function unwrapShell(command) {
  const text = String(command || '');
  const m = text.match(/^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+([\s\S]+)$/i);
  if (!m) return text;
  let inner = m[1].trim();
  if (inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1);
  return inner;
}

/**
 * spec: { exe, cwd, prompt, system, sessionId?, model?, sandbox: 'read-only'|'workspace-write'|'danger-full-access', webSearch }
 */
function runCodex(spec, emit) {
  const common = ['--json', '--skip-git-repo-check', '-c', 'approval_policy="never"'];
  if (spec.webSearch) common.push('-c', 'web_search="live"');
  if (spec.sandbox === 'danger-full-access') common.push('--dangerously-bypass-approvals-and-sandbox');
  else common.push('-c', `sandbox_mode="${spec.sandbox === 'workspace-write' ? 'workspace-write' : 'read-only'}"`);
  if (spec.model) common.push('-m', spec.model);
  if (spec.effort) common.push('-c', `model_reasoning_effort="${spec.effort}"`);
  if (spec.mcp) {
    // TOML literal strings ('…') need no escaping for Windows paths.
    const lit = (v) => `'${String(v).replace(/'/g, '')}'`;
    common.push('-c', `mcp_servers.firefly_browser.command=${lit(spec.mcp.command)}`);
    common.push('-c', `mcp_servers.firefly_browser.args=[${spec.mcp.args.map(lit).join(',')}]`);
    common.push('-c', `mcp_servers.firefly_browser.env={${Object.entries(spec.mcp.env).map(([k, v]) => `${k}=${lit(v)}`).join(',')}}`);
  }
  const args = spec.sessionId ? ['exec', 'resume', ...common, spec.sessionId, '-'] : ['exec', ...common, '-C', spec.cwd, '-'];
  const input = spec.sessionId || !spec.system ? spec.prompt : `${spec.system}\n\n---\n\n${spec.prompt}`;

  let sessionId = spec.sessionId || null;
  let stderr = '';
  let text = '';
  let failure = '';
  let sandboxHint = false;
  let finished = false;
  let stopped = false;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const finish = (ev) => { if (finished) return; finished = true; emit(ev); resolveDone(); };

  const child = spawnCli(spec.exe, args, {
    cwd: spec.cwd,
    env: spec.env,
    onErr: (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); },
    onLine: (line) => {
      const ev = parseJson(line);
      if (!ev) return;
      if (ev.type === 'thread.started' && ev.thread_id) { sessionId = ev.thread_id; emit({ type: 'session', sessionId }); return; }
      if (ev.type === 'turn.completed' && ev.usage) {
        const u = ev.usage;
        emit({ type: 'usage', total: true, input: u.input_tokens || 0, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0), cached: u.cached_input_tokens || 0 });
        return;
      }
      if (ev.type === 'turn.failed' || ev.type === 'error') {
        failure = (ev.error && ev.error.message) || ev.message || 'Codex 出错';
        emit({ type: 'notice', level: 'error', text: failure });
        return;
      }
      if (!/^item\./.test(ev.type)) return;
      const it = ev.item || {};
      const end = ev.type === 'item.completed';
      switch (it.type) {
        case 'agent_message':
          if (end && it.text) {
            const chunk = text ? `\n\n${it.text}` : it.text;
            text += chunk;
            emit({ type: 'text', text: it.text });
            emit({ type: 'text-break' });
          }
          break;
        case 'reasoning':
          if (end && it.text) emit({ type: 'thinking', text: it.text });
          break;
        case 'command_execution':
          if (ev.type === 'item.started') emit({ type: 'tool', callId: it.id, name: 'shell', input: { command: unwrapShell(it.command) }, title: unwrapShell(it.command).slice(0, 160) });
          else if (end) {
            const output = String(it.aggregated_output || '').slice(-6000);
            emit({ type: 'tool-end', callId: it.id, ok: it.status !== 'failed' && (it.exit_code === undefined || it.exit_code === 0), output, exitCode: it.exit_code });
            if (!sandboxHint && spec.sandbox !== 'danger-full-access' && /helper_unknown_error|Failed to create unified exec process|sandbox/i.test(output)) {
              sandboxHint = true;
              emit({ type: 'notice', level: 'warn', text: 'Codex 的 Windows 沙箱在这台电脑上没能启动，命令没有执行。可以在「模型接入 › GPT › 高级」里把 Codex 沙箱改为「不使用沙箱」（只在你信任的工作文件夹里这样做）。' });
            }
          }
          break;
        case 'file_change':
          if (end) {
            const files = (it.changes || []).map((c) => `${c.kind === 'add' ? '新增' : c.kind === 'delete' ? '删除' : '修改'} ${c.path}`);
            emit({ type: 'tool', callId: it.id, name: 'apply_patch', input: { changes: it.changes || [] }, title: files.join('，').slice(0, 160) || '修改文件' });
            emit({ type: 'tool-end', callId: it.id, ok: it.status !== 'failed', output: files.join('\n') });
          }
          break;
        case 'mcp_tool_call':
          if (ev.type === 'item.started') emit({ type: 'tool', callId: it.id, name: `${it.server || 'mcp'}.${it.tool || 'tool'}`, input: it.arguments || {}, title: it.tool || 'MCP 工具' });
          else if (end) emit({ type: 'tool-end', callId: it.id, ok: it.status !== 'failed' && !(it.result && it.result.isError), output: mcpText(it.result) || (it.error && it.error.message) || '' });
          break;
        case 'web_search':
          if (ev.type === 'item.started') emit({ type: 'tool', callId: it.id, name: 'web_search', input: { query: it.query }, title: it.query || '网页搜索' });
          else if (end) emit({ type: 'tool-end', callId: it.id, ok: true, output: it.query ? `搜索：${it.query}` : '' });
          break;
        case 'todo_list':
          emit({ type: 'plan', entries: (it.items || []).map((x) => ({ text: String(x.text || ''), status: x.completed ? 'completed' : 'pending' })) });
          break;
        case 'error':
          if (end && it.message) emit({ type: 'notice', level: 'warn', text: it.message });
          break;
        default: break;
      }
    },
  });

  child.on('error', (e) => finish({ type: 'error', message: `无法启动 Codex：${e.message}`, code: 'SPAWN' }));
  child.on('close', (code) => {
    if (stopped) { finish({ type: 'done', text, stopReason: 'interrupted', sessionId }); return; }
    if (code === 0 && !failure) { finish({ type: 'done', text, sessionId }); return; }
    const tail = stderr.trim().split(/\r?\n/).filter((l) => !/^\s*$/.test(l)).slice(-6).join('\n');
    finish({ type: 'error', message: failure || (tail ? `Codex 退出（${code}）：${tail}` : `Codex 意外退出（${code}）`), code: `EXIT_${code}`, sessionId });
  });
  child.stdin.end(input, 'utf8');

  return {
    done,
    send: null,
    answer: null,
    interrupt() { if (!finished) { stopped = true; killTree(child); } },
    stop() { if (!finished) { stopped = true; killTree(child); } },
  };
}

module.exports = { runCodex };
