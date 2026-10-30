/* Headless check of the 界面 fixes: 命令路径 clean-up, a 「测试中…」 state that is never restored,
   a connection test that throws, and what the follow-scroll key does for a capped list.
   npm run check:ui — plain assertions, no test runner (ui-check-env.ts is imported first: it gives the state modules a fake desktop bridge). */
import { isDeepStrictEqual } from 'node:util';
import { bridgeCalls } from './ui-check-env';
import { PROVIDERS, readiness } from '../src/lib/providers';
import { TESTING, cleanPath, initialModels, modelActions, restoreModels } from '../src/state/models';
import { emptyState } from '../src/state/seed';
import { store } from '../src/state/store';

let failures = 0;
function expect(label: string, cond: boolean, extra = '') {
  console.log(`${cond ? '  ok ' : '  FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures++;
}
function eq<T>(label: string, actual: T, expected: T) {
  const same = isDeepStrictEqual(actual, expected);
  expect(label, same, same ? '' : `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

/* ───────────────────────── 命令路径 ───────────────────────── */

console.log('命令路径 clean-up');
const R = String.raw;
eq('plain path is kept', cleanPath(R`D:\DeepSeek Harness`), R`D:\DeepSeek Harness`);
eq('inner spaces are kept', cleanPath(R`C:\Program Files\nodejs\claude.cmd`), R`C:\Program Files\nodejs\claude.cmd`);
eq('blanks around are dropped', cleanPath(`  ${R`D:\DeepSeek Harness`} \t`), R`D:\DeepSeek Harness`);
eq('a pair of double quotes is dropped (复制为路径)', cleanPath(R`"D:\DeepSeek Harness"`), R`D:\DeepSeek Harness`);
eq('a pair of single quotes is dropped', cleanPath(R`'D:\a b\x.cmd'`), R`D:\a b\x.cmd`);
eq('quotes with blanks around are dropped', cleanPath(R`  "D:\a b"  `), R`D:\a b`);
eq('blanks inside the quotes are dropped', cleanPath(R`" D:\a b "`), R`D:\a b`);
eq('only one pair is dropped', cleanPath(R`""D:\a""`), R`"D:\a"`);
eq('a lone quote stays', cleanPath(R`"D:\a`), R`"D:\a`);
eq('a single quote character stays', cleanPath('"'), '"');
eq('mixed quotes stay', cleanPath(R`"D:\a'`), R`"D:\a'`);
eq('empty stays empty', cleanPath('   '), '');
// What the box does while someone types the path one character at a time: the typed text is only cleaned when it is saved.
{
  const typed = R`D:\DeepSeek Harness`;
  let draft = '';
  for (const ch of typed) draft += ch;
  eq('typing character by character keeps the space in the draft', draft, typed);
  eq('and saves the same path', cleanPath(draft), typed);
}

/* ───────────────────────── 「测试中…」 is never restored ───────────────────────── */

console.log('Saved connection tests');
{
  const saved = initialModels();
  const done = { ok: true, at: 5, ms: 900, message: '回复「OK」', auth: 'api' as const };
  saved.providers.claude.test = { ok: false, at: 1, ms: 0, message: TESTING, auth: 'api' };
  saved.providers.gpt = { ...saved.providers.gpt, test: done };
  const back = restoreModels(JSON.parse(JSON.stringify(saved)));
  eq('a test still running when the app closed is dropped', back.providers.claude.test, undefined);
  eq('a finished test is kept', back.providers.gpt.test, done);
  eq('the message is the one the card looks for', TESTING, '测试中…');
}

/* ───────────────────────── a connection test that throws ───────────────────────── */

console.log('Connection test');
{
  store.init(emptyState(0));
  const id = 'claude' as const;
  store.update((d) => { Object.assign(d.models.providers[id], { auth: 'api', keyHint: '…abcd' }); });
  const c = () => store.get().models.providers[id];

  bridgeCalls.test = async () => { throw new Error('IPC 通道已关闭'); };
  await modelActions.test(id, 'api');
  eq('a thrown error ends as a failed test', [c().test?.ok, c().test?.message], [false, 'IPC 通道已关闭']);
  expect('and a danger toast says so', store.get().toasts.some((t) => t.tone === 'danger'));

  bridgeCalls.test = async () => { throw 'plain string'; };
  await modelActions.test(id, 'api');
  eq('a non-Error rejection keeps its text', c().test?.message, 'plain string');

  bridgeCalls.test = async () => ({ ok: true, text: 'OK', ms: 1200, model: 'm' });
  await modelActions.test(id, 'api');
  eq('a good reply is still a pass', [c().test?.ok, c().test?.ms], [true, 1200]);
  expect('and does not stay on 测试中…', c().test?.message !== TESTING);
}

/* ───────────────────────── a CLI that is found but cannot run ───────────────────────── */

console.log('Readiness of a command-line tool');
{
  const info = PROVIDERS.find((x) => x.id === 'claude')!;
  const base = { ...initialModels().providers.claude, driver: 'claude-code' as const };
  const cli = (c: { found: boolean; path?: string }) => ({ ...base, cli: { login: 'unknown' as const, at: 1, ...c } });
  eq('nothing found: it says the command is missing', readiness(info, cli({ found: false }), 'cli'), { ready: false, reason: '没有找到 claude 命令' });
  const broken = readiness(info, cli({ found: false, path: 'C:/x/claude.cmd' }), 'cli');
  expect('found but broken: it does not say the command is missing', broken.ready === false && !/没有找到/.test(broken.reason ?? ''), String(broken.reason));
  expect('…it points at the explanation above', /找到了，但运行不起来（见上方说明）/.test(broken.reason ?? ''));
}

/* ───────────────────────── follow-scroll key ───────────────────────── */

console.log('Follow-scroll key');
{
  // The log lists are capped: old rows go off the top as new ones arrive, so the length alone never changes.
  const CAP = 5;
  let rows: Array<{ id: string }> = [];
  let n = 0;
  const push = () => { rows = [...rows, { id: `ln_${++n}` }].slice(-CAP); };
  const byLength = () => rows.length;
  const byLast = () => rows[rows.length - 1]?.id;
  for (let i = 0; i < CAP; i++) push();
  const [len0, last0] = [byLength(), byLast()];
  push();
  eq('the length no longer tells that a row came in', byLength(), len0);
  expect('the last row id does', byLast() !== last0);
  const seen = new Set<string | undefined>();
  for (let i = 0; i < 50; i++) { push(); seen.add(byLast()); }
  eq('every append gives a new key', seen.size, 50);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
