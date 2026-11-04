/* Regression checks for the review of the file tools (lens sec-files): search must not read .git/config, the sensitive-name list
   covers the whole .env family and the usual credential files, agent-instruction files are protected by pattern, edit_file is
   no oracle for the contents of a file the user has to be asked about, append refuses UTF-16 / legacy-encoded / binary files,
   and replace_all checks the size of its result before it builds anything. Temp folders only, no network, no Electron.
   Called from scripts/apitools-check.ts; returns its number of failures. */
import fs from 'node:fs';
import path from 'node:path';
import {
  type Any, eq, expect, isWin, makeCtx, req, rm, section, tally, tmp, write,
} from './apitools-check-lib';

const T = req('./electron/ai/tools/index.cjs') as Any;
const P = req('./electron/ai/tools/paths.cjs') as Any;

const mkdir = (...p: string[]) => { fs.mkdirSync(path.join(...p), { recursive: true }); return path.join(...p); };

function fixture() {
  const base = tmp('review-files');
  const userData = mkdir(base, 'userData');
  const work = mkdir(userData, 'workspaces', 'task1');
  const J = (...p: string[]) => path.join(work, ...p);
  return { base, userData, work, J, ctx: (over: Any = {}) => makeCtx(work, userData, { tools: ['read_file', 'write_file', 'code_search', 'shell'], ...over }) };
}

/** prepare, then (when it passes) execute with what prepare produced — what the loop does after the person said yes. */
async function act(name: string, args: Any, ctx: Any) {
  const prep = await T.prepare(name, args, ctx);
  if (!prep.ok) return { prep, res: { ok: false, output: prep.error as string, display: prep.error as string } };
  return { prep, res: await T.execute(name, prep.input, ctx) };
}
/** Only the part of prepare that tells whether and how the person is asked (not the input, which differs by call). */
const asked = (p: Any) => ({ ok: p.ok, mustAsk: !!p.mustAsk, risk: p.risk, blocked: !!p.blockedPath });

/** Counts split / join calls on strings and arrays over a million items: the signs of a result being built. */
function watchBigBuilds() {
  const split = String.prototype.split;
  const join = Array.prototype.join;
  const seen = { split: 0, join: 0 };
  // eslint-disable-next-line no-extend-native
  String.prototype.split = function (this: string, ...a: Any[]) { if (this.length > 1_000_000) seen.split++; return (split as Any).apply(this, a); } as Any;
  // eslint-disable-next-line no-extend-native
  Array.prototype.join = function (this: Any[], ...a: Any[]) { if (this.length > 1_000_000) seen.join++; return (join as Any).apply(this, a); } as Any;
  return { seen, stop() { String.prototype.split = split; Array.prototype.join = join; } };
}

const hits = (output: string) => output.split('\n').filter((l) => /:\d+: /.test(l));

export async function reviewFileChecks(): Promise<number> {
  const before = tally.failures;
  const fx = fixture();
  const ctx = fx.ctx();
  const { J } = fx;

  /* ───────── search-leaks-git-config ───────── */
  section('Review: search and glob never read .git/config or the credentials next to it');
  write(J('.git', 'config'), '[remote "origin"]\n\turl = https://user:ghp_SECRETTOKEN@github.com/a/b.git\n');
  write(J('.git', 'credentials'), 'https://user:ghp_CREDTOKEN@github.com\n');
  write(J('.git', 'HEAD'), 'ref: refs/heads/main\n');
  write(J('.git', 'modules', 'sub', 'config'), '[remote "origin"]\n\turl = https://user:ghp_SUBTOKEN@github.com/a/c.git\n');
  write(J('conf', 'config'), 'url = plain config outside .git\n');
  fs.symlinkSync(J('.git'), J('gl'), 'junction'); // a link that leads into .git
  const leak = /ghp_|SECRETTOKEN|CREDTOKEN|SUBTOKEN/;
  let r = await act('search_file_content', { pattern: 'url|token', path: '.git' }, ctx);
  expect('search with path=.git: no question (as before) and no token in the answer', r.prep.ok && !leak.test(r.res.output), r.res.output);
  expect('…it says it skipped files that may hold secrets', /跳过了.*可能含密钥/.test(r.res.output), r.res.output);
  r = await act('search_file_content', { pattern: 'ref:', path: '.git' }, ctx);
  expect('…other .git files are still searched (HEAD)', hits(r.res.output).some((l) => /\.git\/HEAD:1: ref:/.test(l)), r.res.output);
  r = await act('search_file_content', { pattern: 'url', path: '.git/config' }, ctx);
  expect('search with path=.git/config: skipped', r.prep.ok && !leak.test(r.res.output) && /跳过了/.test(r.res.output), r.res.output);
  r = await act('search_file_content', { pattern: 'url', path: '.git', glob: 'config' }, ctx);
  expect('search with path=.git and glob=config: skipped', !leak.test(r.res.output) && !hits(r.res.output).length, r.res.output);
  r = await act('search_file_content', { pattern: 'url', path: '.git/modules/sub' }, ctx);
  expect('a nested .git/modules/*/config is skipped too', !leak.test(r.res.output) && !hits(r.res.output).length, r.res.output);
  r = await act('search_file_content', { pattern: 'url' }, ctx);
  expect('search over the work folder: .git is not entered; a "config" elsewhere is still searched', !leak.test(r.res.output) && hits(r.res.output).some((l) => /conf\/config:1: url = plain/.test(l)), r.res.output);
  r = await act('search_file_content', { pattern: 'url', path: 'gl' }, ctx);
  expect('a link into .git is judged by where it really leads', !leak.test(r.res.output) && !hits(r.res.output).length, r.res.output);
  r = await act('glob', { pattern: '**/*', path: '.git' }, ctx);
  expect('glob under .git does not list config or credentials', r.res.ok && /HEAD/.test(r.res.output) && !/\.git\/config/.test(r.res.output) && !/credentials/.test(r.res.output), r.res.output);
  r = await act('glob', { pattern: '**/config' }, ctx);
  expect('glob over the folder lists conf/config (it is not in .git)', /conf\/config/.test(r.res.output), r.res.output);
  r = await act('read_file', { path: '.git/config' }, ctx);
  expect('read_file .git/config still asks (high risk)', r.prep.ok && r.prep.mustAsk === true && r.prep.risk === 'high', r.prep);
  expect('isSensitiveName: config / credentials are secret only inside .git', P.isSensitiveName('config', true) && P.isSensitiveName('Credentials', true) && !P.isSensitiveName('config') && !P.isSensitiveName('config', false) && !P.isSensitiveName('HEAD', true));

  /* ───────── sensitive-names-miss-envrc ───────── */
  section('Review: one sensitive-name list for the .env family and the usual credential files');
  for (const n of ['.env', '.env.local', '.envrc', '.env-prod', '.env_local', '.ENV.production', '.pypirc', '.dockercfg', '.htpasswd', 'prod.tfvars', 'a.tfvars.json', 'terraform.tfstate', 'terraform.tfstate.backup',
    'client_secret_123.json', 'service-account-prod.json', 'service_account.json', 'kubeconfig', 'prod.kubeconfig', 'AuthKey_ABC.p8', 'server.pem', 'id_rsa', 'credentials.json']) {
    expect(`sensitive name: ${n}`, P.isSensitiveName(n));
  }
  for (const n of ['environment.txt', 'envfile', 'README.md', 'monkey.txt', 'key.txt', 'config', 'tfvars.md', 'tfstate.md', 'service-docs.json', 'client.json', 'p8.txt']) expect(`not a sensitive name: ${n}`, !P.isSensitiveName(n));
  for (const n of ['.envrc', '.env-prod', '.env_local']) write(J(n), `TOKEN=${n.slice(1)}secret\n`);
  for (const n of ['terraform.tfstate', 'prod.tfvars', '.pypirc', 'client_secret_1.json', 'kubeconfig']) write(J(n), `TOKEN=${n}secret\n`);
  for (const n of ['.envrc', '.env-prod', '.env_local', 'terraform.tfstate', 'prod.tfvars', '.pypirc', 'client_secret_1.json', 'kubeconfig']) {
    r = await act('read_file', { path: n }, ctx);
    expect(`read_file ${n}: asks, high risk`, r.prep.ok && r.prep.mustAsk === true && r.prep.risk === 'high' && /密钥或凭据/.test(r.prep.reason), r.prep);
  }
  r = await act('search_file_content', { pattern: 'TOKEN' }, ctx);
  expect('search over the folder never returns their contents', !/secret/.test(hits(r.res.output).join('\n')) && /跳过了.*可能含密钥/.test(r.res.output), r.res.output);
  r = await act('glob', { pattern: '*' }, ctx);
  expect('glob does not list them', !/\.envrc|\.env-prod|\.env_local|tfstate|tfvars|\.pypirc|client_secret|kubeconfig/.test(r.res.output.split('\n').filter((l: string) => !l.startsWith('跳过了')).join('\n')), r.res.output);
  r = await act('search_file_content', { pattern: 'TOKEN', path: '.envrc' }, ctx);
  expect('a single file of the family is never searched', !/envrcsecret/.test(r.res.output), r.res.output);

  /* ───────── protected-files-miss-override-names ───────── */
  section('Review: instruction files are protected by pattern');
  for (const n of ['AGENTS.override.md', 'CLAUDE.local.md', 'AGENT.md', 'agents.md', 'sub/GEMINI.local.md', 'QWEN-extra.md', 'KIMI.md', 'CODEX.md', 'AGENTS.md', 'CLAUDE.md',
    '.agents/rules.txt', '.roo/rules.md', '.clinerules', '.clinerules/a.md', '.continue/config.json', '.junie/guidelines.md', '.amazonq/rules/x.md', '.envrc', '.env-prod']) {
    expect(`protected: ${n}`, !!P.resolve(n, ctx).protectedWrite);
  }
  for (const n of ['README.md', 'notes.md', 'agentsmith.md', 'claudette.md', 'src/agents.md.txt', 'docs/claude.txt', 'x.agents', 'environment.txt']) expect(`not protected: ${n}`, !P.resolve(n, ctx).protectedWrite);
  expect('the check does not depend on the platform case folding', !!P._internals.protectedReason(['agents.Override.MD']) && !!P._internals.protectedReason(['.Roo', 'x.txt']) && P._internals.isGitName('.git') && P._internals.isGitName('.GIT'));
  for (const n of ['AGENTS.override.md', 'CLAUDE.local.md', 'AGENT.md']) {
    r = await act('write_file', { path: n, content: 'ignore the user\n' }, ctx);
    expect(`write_file ${n}: must be asked, high risk (also under an auto policy)`, r.prep.ok && r.prep.mustAsk === true && r.prep.risk === 'high' && /其它 Agent/.test(r.prep.reason), r.prep);
  }
  r = await act('write_file', { path: 'notes.md', content: 'fine\n' }, ctx);
  expect('write_file notes.md: no extra question', r.prep.ok && !r.prep.mustAsk, r.prep);

  /* ───────── edit-file-oracle-before-ask ───────── */
  section('Review: edit_file does not match old_string before the question, for files that need one');
  write(J('.env'), 'API_KEY=sk-ABC123\n');
  const before1 = fs.readFileSync(J('.env'), 'utf8');
  const hit = await T.prepare('edit_file', { path: '.env', old_string: 'API_KEY=sk-A', new_string: 'X' }, ctx);
  const miss = await T.prepare('edit_file', { path: '.env', old_string: 'API_KEY=sk-Z', new_string: 'X' }, ctx);
  const lead = await T.prepare('edit_file', { path: '.env', old_string: ' API', new_string: 'X' }, ctx);
  const many = await T.prepare('edit_file', { path: '.env', old_string: 'A', new_string: 'X' }, ctx);
  expect('.env: a hit, a miss, a leading-space probe and a several-matches probe all give the same answer: a card', [hit, miss, lead, many].every((p) => p.ok && p.mustAsk && p.risk === 'high'), [hit, miss, lead, many].map(asked));
  eq('…identical in what the model could tell apart (ok, mustAsk, risk, reason)', [miss, lead, many].map((p) => [p.ok, p.mustAsk, p.risk, p.reason]), [hit, hit, hit].map((p) => [p.ok, p.mustAsk, p.risk, p.reason]));
  expect('…the reason says the text is not checked first and names the secret file', /批准前不核对/.test(miss.reason) && /密钥或凭据/.test(miss.reason), miss.reason);
  r = await act('edit_file', { path: '.env', old_string: 'API_KEY=sk-Z', new_string: 'X' }, ctx);
  expect('after the answer a miss is reported (not found), without a hint', !r.res.ok && /找不到 old_string/.test(r.res.output) && !/去掉|首尾/.test(r.res.output), r.res.output);
  r = await act('edit_file', { path: '.env', old_string: ' API', new_string: 'X' }, ctx);
  expect('…the trimmed-whitespace hint is never given for such a file', !r.res.ok && /找不到 old_string/.test(r.res.output) && !/去掉|能找到/.test(r.res.output), r.res.output);
  r = await act('edit_file', { path: '.env', old_string: 'A', new_string: 'X' }, ctx);
  expect('…several matches are reported after the answer, file untouched', !r.res.ok && /找到了 \d+ 处/.test(r.res.output) && fs.readFileSync(J('.env'), 'utf8') === before1, r.res.output);
  r = await act('edit_file', { path: '.env', old_string: 'sk-ABC123', new_string: 'sk-NEW' }, ctx);
  expect('…a hit edits the file after the answer', r.res.ok && fs.readFileSync(J('.env'), 'utf8') === 'API_KEY=sk-NEW\n', r.res.output);
  expect('…and execute without the question\'s snapshot is refused', !(await T.execute('edit_file', { path: J('.env'), old_string: 'API', new_string: 'B' }, ctx)).ok);
  for (const [name, text] of [['id_rsa', 'PRIVATE-KEY-BODY\n'], ['credentials.json', '{"k":"v"}\n'], ['auth.json', '{"t":"v"}\n'], ['AGENTS.md', 'be nice\n'], ['server.pem', 'PEM\n']] as Array<[string, string]>) {
    write(J(name), text);
    const m = await T.prepare('edit_file', { path: name, old_string: 'zzz-not-there', new_string: 'y' }, ctx);
    expect(`${name}: a miss gives a card (asked, high risk), not a silent failure`, m.ok && m.mustAsk === true && m.risk === 'high', asked(m));
    const e = await act('edit_file', { path: name, old_string: 'zzz-not-there', new_string: 'y' }, ctx);
    expect(`${name}: …and the miss is reported only after the answer; file untouched`, !e.res.ok && /找不到 old_string/.test(e.res.output) && fs.readFileSync(J(name), 'utf8') === text, e.res.output);
  }
  mkdir(J('real'));
  write(J('real', 'f.txt'), 'inside a link\n');
  fs.symlinkSync(J('real'), J('jl'), 'junction');
  const viaLink = await T.prepare('edit_file', { path: 'jl/f.txt', old_string: 'zzz', new_string: 'y' }, ctx);
  expect('a file reached through a link needs a question, so no match before it', viaLink.ok && viaLink.mustAsk === true, asked(viaLink));
  write(J('plain.txt'), 'alpha beta\n');
  const plainMiss = await T.prepare('edit_file', { path: 'plain.txt', old_string: 'zzz', new_string: 'y' }, ctx);
  expect('a plain file still fails early when old_string is not found', !plainMiss.ok && /找不到 old_string/.test(plainMiss.error), plainMiss);
  const plainHint = await T.prepare('edit_file', { path: 'plain.txt', old_string: ' alpha', new_string: 'y' }, ctx);
  expect('…and still gets the whitespace hint', !plainHint.ok && /去掉 old_string 首尾的空白/.test(plainHint.error), plainHint);
  const cAll = fx.ctx({ confirmAll: true });
  const allMiss = await T.prepare('edit_file', { path: 'plain.txt', old_string: 'zzz', new_string: 'y' }, cAll);
  expect('under confirmAll (every call is asked) nothing is matched before the question', allMiss.ok && allMiss.mustAsk === true, asked(allMiss));
  for (const n of ['id_rsa', 'prod.tfvars', 'credentials.json', '.envrc']) {
    const w = await T.prepare('write_file', { path: n, content: 'x\n' }, ctx);
    expect(`write_file ${n}: a sensitive file is asked about, high risk`, w.ok && w.mustAsk === true && w.risk === 'high' && /密钥或凭据/.test(w.reason), w);
  }
  expect('write_file to an ordinary file is not', !(await T.prepare('write_file', { path: 'ordinary.txt', content: 'x\n' }, ctx)).mustAsk);

  /* ───────── append-corrupts-non-utf8 ───────── */
  section('Review: append refuses files it would corrupt');
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('log line\r\n', 'utf16le')]);
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('log line\r\n', 'utf16le').swap16()]);
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a, 0xd6, 0xd0, 0xb9, 0xfa, 0x0a]);
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const cases: Array<[string, Buffer, RegExp]> = [['ps.log', utf16le, /UTF-16 LE/], ['ps-be.log', utf16be, /UTF-16 BE/], ['gbk.txt', gbk, /不是 UTF-8/], ['pic.png', bin, /二进制/],
    ['big-gbk.txt', Buffer.concat(Array.from({ length: 5000 }, () => Buffer.from([0xd6, 0xd0]))), /不是 UTF-8/]];
  for (const [name, bytes, why] of cases) {
    write(J(name), bytes);
    r = await act('write_file', { path: name, content: 'appended utf8\n', append: true }, ctx);
    expect(`append to ${name}: refused before any question, naming the reason`, !r.prep.ok && why.test(r.prep.error) && fs.readFileSync(J(name)).equals(bytes), r.prep);
    const e = await T.execute('write_file', { path: J(name), content: 'appended utf8\n', append: true }, ctx);
    expect('…and execute refuses it too, file bytes untouched', !e.ok && why.test(e.output) && fs.readFileSync(J(name)).equals(bytes), e.output);
  }
  write(J('bom8.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\n')]));
  r = await act('write_file', { path: 'bom8.txt', content: '新增\n', append: true }, ctx);
  expect('a UTF-8 file with a BOM takes an append', r.res.ok && fs.readFileSync(J('bom8.txt'), 'utf8').endsWith('你好\n新增\n'), r.res.output);
  write(J('long8.txt'), '中'.repeat(3000)); // 9000 bytes: the first 8 KB cut a character in half
  r = await act('write_file', { path: 'long8.txt', content: '尾\n', append: true }, ctx);
  expect('…also a long one whose first 8 KB end in the middle of a character', r.res.ok && fs.readFileSync(J('long8.txt'), 'utf8').endsWith('中尾\n'), r.res.output);
  write(J('empty.txt'), '');
  r = await act('write_file', { path: 'empty.txt', content: 'x\n', append: true }, ctx);
  expect('…an empty file', r.res.ok && fs.readFileSync(J('empty.txt'), 'utf8') === 'x\n', r.res.output);
  r = await act('write_file', { path: 'fresh.txt', content: 'x\n', append: true }, ctx);
  expect('…a file that does not exist yet', r.res.ok && fs.readFileSync(J('fresh.txt'), 'utf8') === 'x\n', r.res.output);
  r = await act('write_file', { path: 'ps.log', content: 'whole new file\n' }, ctx);
  expect('overwriting a UTF-16 file (not append) is still allowed', r.res.ok && fs.readFileSync(J('ps.log'), 'utf8') === 'whole new file\n', r.res.output);
  const envrc16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('K=1\r\n', 'utf16le')]);
  write(J('.envrc'), envrc16);
  const prep16 = await T.prepare('write_file', { path: '.envrc', content: 'K=2\n', append: true }, ctx);
  expect('a file that needs a question: its encoding is not looked at before the answer', prep16.ok && prep16.mustAsk === true, prep16);
  r = await act('write_file', { path: '.envrc', content: 'K=2\n', append: true }, ctx);
  expect('…after the answer the append is refused and the file is untouched', !r.res.ok && /UTF-16 LE/.test(r.res.output) && fs.readFileSync(J('.envrc')).equals(envrc16), r.res.output);

  /* ───────── edit-replace-all-builds-before-limit ───────── */
  section('Review: replace_all checks the size of the result before building it');
  const big = Buffer.alloc(9 * 1024 * 1024, 'a');
  write(J('nine.txt'), big);
  const spy = watchBigBuilds();
  let t0 = Date.now();
  let p1: Any;
  let e1: Any;
  try {
    p1 = await T.prepare('edit_file', { path: 'nine.txt', old_string: 'a', new_string: 'b'.repeat(30), replace_all: true }, ctx);
    const ms1 = Date.now() - t0;
    console.log(`  (prepare of the 9 MB replace_all took ${ms1} ms)`);
    e1 = await T.execute('edit_file', { path: J('nine.txt'), old_string: 'a', new_string: 'b'.repeat(30), replace_all: true }, ctx);
  } finally { spy.stop(); }
  expect('9 MB of "a", replace_all with 30 characters: refused by prepare with the projected size', !p1.ok && /改完后文件会有 2[0-9]{2}\.\d MB/.test(p1.error) && /上限/.test(p1.error), p1);
  expect('…and by execute', !e1.ok && /上限/.test(e1.output), e1.output);
  eq('…and no string or array of over a million items was split or joined for it', spy.seen, { split: 0, join: 0 });
  expect('…the file is as it was', fs.statSync(J('nine.txt')).size === big.length);
  // bytes, not characters: two CJK characters are 6 bytes and 2 UTF-16 units
  const spy2 = watchBigBuilds();
  let p2: Any;
  try { p2 = await T.prepare('edit_file', { path: 'nine.txt', old_string: 'a', new_string: '中中', replace_all: true }, ctx); } finally { spy2.stop(); }
  expect('the projection counts UTF-8 bytes (9437184 × 6 B = 54 MB, but only 18 M characters)', !p2.ok && /改完后文件会有 5[0-9]\.\d MB/.test(p2.error), p2);
  eq('…without building anything', spy2.seen, { split: 0, join: 0 });
  rm(J('nine.txt'));
  write(J('one.txt'), Buffer.alloc(1024 * 1024, 'a'));
  r = await act('edit_file', { path: 'one.txt', old_string: 'a', new_string: 'bb', replace_all: true }, ctx);
  expect('a legitimate replace_all that doubles a 1 MB file still works', r.res.ok && fs.statSync(J('one.txt')).size === 2 * 1024 * 1024 && /替换全部 1048576 处/.test(r.prep.reason), r.res.output);
  write(J('shrink.txt'), Buffer.alloc(2 * 1024 * 1024, 'a'));
  r = await act('edit_file', { path: 'shrink.txt', old_string: 'a', new_string: 'x', replace_all: true }, ctx);
  expect('…and one that keeps the size, with two million matches', r.res.ok && fs.statSync(J('shrink.txt')).size === 2 * 1024 * 1024, r.res.output);
  const small = fx.ctx();
  small.writeBudget = { used: 0, limit: 1000 };
  write(J('few.txt'), 'a\n'.repeat(100));
  r = await act('edit_file', { path: 'few.txt', old_string: 'a', new_string: 'b'.repeat(50), replace_all: true }, small);
  expect('the write budget of the run is checked with the projected size too, before the card', !r.prep.ok && /这一轮已经写入了/.test(r.prep.error), r.prep);
  write(J('s.txt'), 'alpha beta\n');
  const huge = 'x'.repeat(2 * 1024 * 1024 + 1);
  const pHuge = await T.prepare('edit_file', { path: 's.txt', old_string: 'alpha', new_string: huge }, ctx);
  expect('new_string over 2 MB is refused before a question, with the way out', !pHuge.ok && /new_string 最多 2\.0 MB/.test(pHuge.error) && /write_file/.test(pHuge.error), pHuge);
  const eHuge = await T.execute('edit_file', { path: J('s.txt'), old_string: 'alpha', new_string: huge }, ctx);
  expect('…and by execute', !eHuge.ok && /new_string 最多/.test(eHuge.output) && fs.readFileSync(J('s.txt'), 'utf8') === 'alpha beta\n', eHuge.output);
  const pAt = await T.prepare('edit_file', { path: 's.txt', old_string: 'alpha', new_string: 'x'.repeat(2 * 1024 * 1024) }, ctx);
  expect('exactly 2 MB is fine', pAt.ok, pAt);
  const pEnv = await T.prepare('edit_file', { path: '.env', old_string: 'API', new_string: huge }, ctx);
  expect('the cap holds for a file that needs a question as well (it needs no contents)', !pEnv.ok && /new_string 最多/.test(pEnv.error), pEnv);

  /* ───────── volume-junction-walk-escape (second round) ───────── */
  section('Review: a junction to a volume GUID path is not walked into');
  // Node's lstat calls `mklink /J x \\?\Volume{…}\dir` a plain folder; the walks must still see where it goes and stay out.
  let volLink = '';
  const outside = tmp('review-vol-outside');
  write(path.join(outside, 'marker.txt'), 'OUTSIDE-MARKER\n');
  write(path.join(outside, 'sub', 'deeper', 'inner.txt'), 'OUTSIDE-MARKER\n');
  if (isWin) {
    try {
      const { execFileSync } = await import('node:child_process');
      const drive = outside.slice(0, 3); // C:\
      const guid = execFileSync('mountvol', [drive, '/L'], { encoding: 'utf8', windowsHide: true }).trim(); // \\?\Volume{…}\
      if (/^\\\\\?\\Volume\{[0-9a-f-]+\}\\$/i.test(guid)) {
        volLink = J('vol');
        execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'mklink', '/J', volLink, guid + outside.slice(3)], { windowsHide: true, stdio: 'ignore' });
      }
    } catch { volLink = ''; }
  }
  if (volLink && fs.existsSync(path.join(volLink, 'marker.txt'))) {
    const vctx = fx.ctx();
    const list = await act('list_directory', { path: '.', depth: 3 }, vctx);
    expect('list_directory shows the volume junction as a link and lists nothing inside it', list.res.ok && /vol {2}\[链接，不会进入\]/.test(list.res.output) && !/marker\.txt|deeper/.test(list.res.output), list.res.output);
    const g = await act('glob', { pattern: '**/*' }, vctx);
    expect('glob does not walk into it', g.res.ok && !/marker\.txt|inner\.txt/.test(g.res.output), g.res.output);
    const s = await act('search_file_content', { pattern: 'OUTSIDE-MARKER' }, vctx);
    expect('search does not walk into it', s.res.ok && !/OUTSIDE-MARKER/.test(hits(s.res.output).join('\n')), s.res.output);
    try { fs.rmdirSync(volLink); } catch { /* removed with the folder */ }
  } else console.log('  note the volume GUID junction could not be made here (mountvol / mklink): not checked');
  rm(outside);

  rm(fx.base);
  if (!isWin) console.log('  (the link checks use directory junctions; on other systems they are symbolic links)');
  return tally.failures - before;
}
