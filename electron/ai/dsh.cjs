// DeepSeek Harness driver: `dsh --profile headless --json -` with the DeepSeek account (signed in once
// in the DSH desktop app or CLI). One process per turn; later turns pass --session-id.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCli, killTree, parseJson, summarizeInput, flattenOutput } = require('./proc.cjs');

/** spec: { exe, cwd, prompt, system, sessionId?, model?, env } */
function runDsh(spec, emit) {
  const model = /^[\w.-]{1,64}$/.test(spec.model || '') ? spec.model : 'deepseek-flash';
  const patch = path.join(os.tmpdir(), `firefly-dsh-${model}.yml`);
  fs.writeFileSync(patch, `- id: agent-default-model\n  name: "@deepseek-ai/dsh-agent-default-model"\n  config:\n    provider: deepseek-account\n    model: ${model}\n`, 'utf8');
  const args = ['--profile', 'headless', '--patch', patch, '--json'];
  if (spec.sessionId) args.push('--session-id', spec.sessionId);
  args.push('-');
  const input = spec.sessionId || !spec.system ? spec.prompt : `${spec.system}\n\n---\n\n${spec.prompt}`;

  let sessionId = spec.sessionId || null;
  let stderr = '';
  let text = '';
  let finalText = '';
  let truncated = false;
  let failure = '';
  let finished = false;
  let stopped = false;
  let seq = 0;
  const open = [];
  // DSH's step_end usage covers one step only: keep a running sum for the turn.
  const usage = { input: 0, output: 0, cached: 0 };
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
      if (ev.type === 'session' && ev.sessionId) { sessionId = ev.sessionId; emit({ type: 'session', sessionId }); }
      else if (ev.type === 'text' && ev.text) { text += ev.text; if (ev.truncated) truncated = true; emit({ type: 'text', text: ev.text }); }
      else if (ev.type === 'thinking' && ev.text) emit({ type: 'thinking', text: ev.text });
      else if (ev.type === 'final') finalText = ev.text || '';
      else if (ev.type === 'status' && ev.usage) {
        const u = ev.usage;
        usage.input += u.inputTokens || 0;
        usage.output += u.outputTokens || 0;
        usage.cached += u.cacheReadTokens || 0;
        emit({ type: 'usage', total: true, ...usage });
      } else if (ev.type === 'error') { failure = ev.message || 'DeepSeek Harness 出错'; emit({ type: 'notice', level: 'error', text: failure }); }
      // --json: tool_call {callId, tool, input}; tool_result {callId, status:'completed'|'error', result}.
      else if (ev.type === 'tool_call') {
        const callId = ev.callId || `dsh_${++seq}`;
        open.push(callId);
        const inp = ev.input || {};
        emit({ type: 'text-break' });
        emit({ type: 'tool', callId, name: ev.tool || 'tool', input: inp, title: (typeof inp.description === 'string' && inp.description) || summarizeInput(inp) });
      } else if (ev.type === 'tool_result') {
        const callId = ev.callId || open[0];
        const at = open.indexOf(callId);
        if (at >= 0) open.splice(at, 1);
        if (callId) emit({ type: 'tool-end', callId, ok: ev.status !== 'error', output: flattenOutput(ev.result ?? '') });
      }
    },
  });

  child.on('error', (e) => finish({ type: 'error', message: `无法启动 DeepSeek Harness：${e.message}`, code: 'SPAWN' }));
  child.on('close', (code) => {
    if (!text && finalText) { text = finalText; emit({ type: 'text', text: finalText }); }
    // Each text event is cut at 8 KiB; only `final` carries the whole answer.
    else if (truncated && finalText.length > text.length) {
      emit({ type: 'notice', level: 'info', text: '回复较长，下面是完整版本。' });
      emit({ type: 'text-break' });
      emit({ type: 'text', text: finalText });
      text = finalText;
    }
    if (stopped) { finish({ type: 'done', text, stopReason: 'interrupted', sessionId }); return; }
    if (code === 0) { finish({ type: 'done', text, sessionId }); return; }
    // A failed turn sends no error event: it exits 1 and says why on stderr as `dsh: CODE: message`.
    const lines = stderr.trim().split(/\r?\n/);
    const reason = [...lines].reverse().find((l) => /^dsh:/.test(l.trim()));
    const tail = reason ? reason.trim().replace(/^dsh:\s*/, '') : lines.slice(-6).join('\n');
    finish({ type: 'error', message: failure || (tail ? `DeepSeek Harness 这一轮失败（${code}）：${tail}` : `DeepSeek Harness 意外退出（${code}）`), code: `EXIT_${code}`, sessionId });
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

module.exports = { runDsh };
