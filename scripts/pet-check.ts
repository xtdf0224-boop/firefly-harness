/* Headless check of the 桌宠's pieces around the brain: npm run check:pet
   Scene analysis, what she may look at (policy), the voice helpers, the settings inputs and their
   storage, picking models, the model specs, and the desktop side (electron/pet/*.cjs) with Electron
   replaced by fakes so the wiring between the page, the main process, the capture page and the pet
   window is exercised. Nothing here opens a window. Plain assertions, no test runner. */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import fs from 'node:fs';
import { BLINK, Blinker, Babble, Lag, MouthEnvelope, blinkCurve, breath, mouthTarget, sway } from '../src/pet/ui/puppet/motion';
import { parseRig, rigPose } from '../src/pet/ui/puppet/rig';
import { CHAT_MAX, applyChat, atEnd, chatActivity, composerKey, fullText, startsRun } from '../src/pet/ui/chatLog';
import type { PetChatEntry } from '../src/pet/contracts';
import RIGS from '../src/pet/ui/puppet/rigs.json';
import { parseAccelerator, parseExe, parseIntIn } from '../src/components/views/settings/petInput';
import type { ModelState, TaskEngine } from '../src/lib/types';
import {
  DEFAULT_TUNING, SceneAnalyzer, THUMB_LEN, dhash, hamming, lumaFromRGBA, meanAbsDiff,
} from '../src/pet/capture/analyze';
import { actions } from '../src/state/actions';
import { petApiSpec, petCliSpec } from '../src/state/live';
import {
  engineChoices, initialModels, petChatEngine, petVisionEngine, petVisionOptions, petWebEngine, petWebOptions,
} from '../src/state/models';
import { loadState } from '../src/state/persist';
import { DEFAULT_PET, DEFAULT_SETTINGS, emptyState } from '../src/state/seed';
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
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const root = process.cwd();
const req = createRequire(path.join(root, 'package.json'));

/* ───────────────────────── scene analysis ───────────────────────── */

console.log('Scene analysis');
const flat = (v: number) => new Uint8Array(THUMB_LEN).fill(v);
const ramp = (flip: boolean) => Uint8Array.from({ length: THUMB_LEN }, (_, i) => { const x = i % 64; return flip ? 255 - x * 4 : x * 4; });
const checker = () => Uint8Array.from({ length: THUMB_LEN }, (_, i) => (((i % 64) >> 3) + (Math.floor(i / 64) >> 2)) % 2 ? 200 : 40);

{
  const a = new SceneAnalyzer();
  const seen: Array<[number, string]> = [];
  let t = 1000;
  const push = (luma: Uint8Array | null) => { const ev = a.push(luma, t); if (ev) seen.push([t, ev.state]); t += 500; return ev; };
  expect('nothing is announced before a first frame', a.push(null, 0) === null);
  const still = ramp(false);
  for (let i = 0; i < 8; i++) push(still);
  eq('a picture that does not change is "static" after three seconds', seen.map((s) => s[1]), ['static']);
  const nudged = still.slice();
  for (let i = 0; i < 2000; i++) nudged[i] = Math.min(255, nudged[i] + 90);
  push(nudged);
  eq('a visible change makes it "motion" again', seen.map((s) => s[1]), ['static', 'motion']);
  push(ramp(true));
  eq('a different picture is a "cut"', seen.map((s) => s[1]).slice(-1), ['cut']);
  for (let i = 0; i < 4; i++) push(ramp(true));
  eq('a cut that holds still "settles"', seen.map((s) => s[1]).slice(-1), ['settled']);
  for (let i = 0; i < 8; i++) push(null);
  eq('with no new frames time still passes: back to "static"', seen.map((s) => s[1]).slice(-1), ['static']);
}
{
  const a = new SceneAnalyzer();
  let t = 0;
  const states: string[] = [];
  const push = (luma: Uint8Array | null) => { const ev = a.push(luma, t); if (ev) states.push(ev.state); t += 500; };
  push(checker());
  for (let i = 0; i < 8; i++) push(flat(2));
  expect('a dark, frozen picture is "black" (exclusive full screen shows nothing)', states.includes('black'), states.join(','));
  const before = states.length;
  push(checker());
  eq('light coming back counts as a cut', states.slice(before), ['cut']);
}
{
  // Not every dark picture is a blank capture: a night scene, a fade or a loading screen keeps a little light.
  const lit = (base: number, n: number) => { const p = flat(base); for (let i = 0; i < n; i++) p[i * 50] = 200; return p; };
  const black = (pic: Uint8Array) => {
    const a = new SceneAnalyzer();
    let t = 0;
    const states: string[] = [];
    for (const p of [checker(), ...Array<Uint8Array>(10).fill(pic)]) { const ev = a.push(p, t); if (ev) states.push(ev.state); t += 500; }
    return states.includes('black');
  };
  eq('a dim picture, or a dark one with a HUD or a spinner in it, is not "black"; a blank one is', [black(flat(6)), black(lit(1, 46)), black(flat(1))], [false, false, true]);
  const a = new SceneAnalyzer();
  let t = 0;
  const states: string[] = [];
  const push = (luma: Uint8Array) => { const ev = a.push(luma, t); if (ev) states.push(ev.state); t += 500; };
  push(checker());
  for (let i = 0; i < 8; i++) push(flat(1));
  const shape = flat(1);
  for (let i = 0; i < 800; i++) shape[i] = 10; // something faint moves in the dark
  push(shape);
  eq('black, then something moves in the dark: not a blank capture after all (a cut)', states.slice(-2), ['black', 'cut']);
}
{
  const a = new SceneAnalyzer({ staticMs: 1000 });
  let t = 0;
  const states: string[] = [];
  for (let i = 0; i < 6; i++) { const ev = a.push(checker(), t); if (ev) states.push(ev.state); t += 500; }
  eq('the thresholds can be tuned', states, ['static']);
  expect('the defaults are what the page uses', DEFAULT_TUNING.staticMs === 3000 && DEFAULT_TUNING.blackMs === 2000);
}
{
  eq('luma of pure red/green/blue follows BT.601', Array.from(lumaFromRGBA([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])), [76, 149, 28]);
  eq('mean difference of black and white is 1', meanAbsDiff(flat(0), flat(255)), 1);
  expect('a picture and its negative differ in many hash bits', hamming(dhash(ramp(false)), dhash(ramp(true))) >= 14);
  eq('and the same picture in none', hamming(dhash(checker()), dhash(checker())), 0);
}

/* ───────────────────────── what she may look at ───────────────────────── */

console.log('Policy');
type Classified = { exe: string; title: string; isGame: boolean; game?: string; policy: string; pid: number; hwnd: string; antiCheat?: boolean };
type PolicyEnv = { listDir(dir: string): string[] };
const policy = req('./electron/pet/policy.cjs') as {
  classify(raw: object, lists?: object, env?: PolicyEnv): Classified;
  isAntiCheat(raw: object, env?: PolicyEnv): boolean;
};
const lists = { neverWatch: ['wechat.exe'], gameAllow: ['mygame.exe', 'valorant.exe'], gameDeny: ['eldenring.exe'] };
const cls = (exe: string, title = '', fullscreen = 'no') => policy.classify({ exe, title, pid: 7, hwnd: '4242', fullscreen }, lists);
eq('a known game is watched, with its name', [cls('StarRail.exe').policy, cls('StarRail.exe').game], ['watch', '崩坏：星穹铁道']);
eq('exe names are compared in lower case, ids come through', [cls('StarRail.exe').exe, cls('x.exe').hwnd, cls('x.exe').pid], ['starrail.exe', '4242', 7]);
eq('a browser is never a game, even full screen', [cls('chrome.exe', 'x', 'borderless').isGame, cls('chrome.exe', 'x', 'borderless').policy], [false, 'chat-only']);
eq('an unknown full-screen program is not a game: no look, no title as a name', [cls('whatever.exe', 'Cool Game', 'borderless').isGame, cls('whatever.exe', 'Cool Game', 'borderless').game, cls('whatever.exe', 'Cool Game', 'borderless').policy], [false, undefined, 'chat-only']);
eq('so a full-screen notes app or mailbox is never captured', ['obsidian.exe', 'notion.exe', 'netflix.exe', 'enpass.exe'].map((x) => { const c = cls(x, 'Inbox - me@example.com', 'borderless'); return [c.isGame, c.game, c.policy]; }), Array(4).fill([false, undefined, 'chat-only']));
eq('an unknown window is not', cls('whatever.exe', 'Cool Game').isGame, false);
eq('the user\'s "watch" list names the game after its window, a built-in one after the list', [cls('mygame.exe', 'My Game').game, cls('starrail.exe', 'Inbox').game], ['My Game', '崩坏：星穹铁道']);
eq('games with a protected online mode are chat only', ['eldenring.exe', 'helldivers2.exe', 'gta5.exe', 'wutheringwaves.exe', 'nightreign.exe'].map((x) => [cls(x).isGame, cls(x).policy]), Array(5).fill([true, 'chat-only']));
eq('the same exe as 鸣潮 or as another game', [cls('client-win64-shipping.exe', '鸣潮').policy, policy.classify({ exe: 'client-win64-shipping.exe', title: 'Other', path: 'D:\\Other\\client-win64-shipping.exe' }, {}, { listDir: () => [] }).isGame], ['chat-only', false]);
{
  // A game that is not on the list but ships an anti-cheat next to it (the folder listing is faked).
  const listDir = (dir: string) => (/\\Foo$/.test(dir) ? ['Engine', 'EasyAntiCheat', 'foo.exe'] : /\\Bar$/.test(dir) ? ['bar.exe', 'data'] : []);
  const at = (exe: string, p: string, l: object = {}) => policy.classify({ exe, title: 'T', pid: 7, hwnd: '1', fullscreen: 'no', path: p }, l, { listDir });
  eq('an anti-cheat in the folder: a game, chat only, even if the user allowed it', [at('foo.exe', 'D:\\Games\\Foo\\foo.exe').policy, at('foo.exe', 'D:\\Games\\Foo\\foo.exe', { gameAllow: ['foo.exe'] }).policy, at('foo.exe', 'D:\\Games\\Foo\\foo.exe').game], ['chat-only', 'chat-only', 'foo']);
  eq('also found three folders up (Unreal)', at('foo-win64-shipping.exe', 'D:\\Games\\Foo\\Game\\Binaries\\Win64\\foo-win64-shipping.exe').isGame, true);
  eq('no marker: an unknown program, and watchable only if the user says so', [at('bar.exe', 'D:\\Games\\Bar\\bar.exe').isGame, at('bar.exe', 'D:\\Games\\Bar\\bar.exe', { gameAllow: ['bar.exe'] }).policy], [false, 'watch']);
  eq('a browser in a folder with such a file is still not a game', at('chrome.exe', 'D:\\Games\\Foo\\chrome.exe').isGame, false);
  eq('the path is never copied into the result', 'path' in at('foo.exe', 'D:\\Games\\Foo\\foo.exe'), false);
  eq('isAntiCheat: the list, the folder, and not the rest', [policy.isAntiCheat({ exe: 'cs2.exe' }), policy.isAntiCheat({ exe: 'foo.exe', path: 'D:\\Games\\Foo\\foo.exe' }, { listDir }), policy.isAntiCheat({ exe: 'starrail.exe' }), policy.isAntiCheat({ exe: 'whatever.exe' })], [true, true, false, false]);
  eq('the brain is told which games have an anti-cheat (she is hidden over them); a game the user only said not to watch has none',
    [at('foo.exe', 'D:\\Games\\Foo\\foo.exe').antiCheat, cls('cs2.exe').antiCheat, policy.classify({ exe: 'starrail.exe', title: '', pid: 7, hwnd: '1', fullscreen: 'no' }, { gameDeny: ['starrail.exe'] }).antiCheat, cls('starrail.exe').antiCheat],
    [true, true, undefined, undefined]);
}
eq('an anti-cheat game is chat only (but still a game)', [cls('cs2.exe').isGame, cls('cs2.exe').policy], [true, 'chat-only']);
eq('the user\'s "watch" list does not beat the anti-cheat list', cls('valorant.exe').policy, 'chat-only');
eq('the user\'s "watch" list makes a window a game', [cls('mygame.exe').isGame, cls('mygame.exe').policy], [true, 'watch']);
eq('the user\'s "don\'t watch" list makes a game chat only', cls('eldenring.exe').policy, 'chat-only');
eq('the "never" list wins and even the title is dropped', [cls('wechat.exe', '聊天记录').policy, cls('wechat.exe', '聊天记录').title], ['never', '']);
eq('Minecraft is found by its window title', [cls('javaw.exe', 'Minecraft 1.21').game, cls('javaw.exe', 'Eclipse').isGame], ['Minecraft', false]);
eq('nothing in front is not a game', cls('', '').isGame, false);

/* ───────────────────────── the voice helpers ───────────────────────── */

console.log('Voice');
const gec = req('./electron/pet/tts-edge-gec.cjs') as { secMsGec(t: number): string };
// Values from the reference implementation (edge-tts 7.3, drm.py): a port must match them to the last digit.
eq('Sec-MS-GEC matches the reference', gec.secMsGec(1760000000.5), '6D50DDDB91812C33-DD68EFB01898B0750C9797D51A5FF93471DFDAE6888A1039D532CBDCCE54545D');
eq('…at a window edge', gec.secMsGec(1760000299), 'BAF4076F572BFE4E-2D6FBE5C0E24F56622EB94F37395F2D153C6C0C451DAAE2249A459BB3AFAD62C');
eq('…and the same value across the five-minute window', gec.secMsGec(1760000300), 'BAF4076F572BFE4E-2D6FBE5C0E24F56622EB94F37395F2D153C6C0C451DAAE2249A459BB3AFAD62C');
eq('…and a far one', gec.secMsGec(1900000000), '35CB2860F259268E-7C6AC7AAFAF9ECFDEF5C38802D91759C088D45E6E8BDBC2EC1C78C22D51F1DF6');
const tts = req('./electron/pet/tts.cjs') as {
  _internals: { speakable(t: string): string; chain(p: string, f: boolean): string[]; xmlEscape(t: string): string; EDGE_VOICES: Array<{ id: string; name: string }> };
  voices(p: string): Promise<Array<{ id: string; name: string }>>;
  synth(text: string, voice: object, o: object): Promise<unknown>;
};
const ti = tts._internals;
eq('markup and emoji are not read aloud', ti.speakable('# 标题\n**重点** [链接](http://a.b) `code` 😀 https://x.y/z'), '标题 重点 链接 code');
eq('very long text is cut', ti.speakable('字'.repeat(900)).length, 600);
eq('a chosen service is tried first, the rest in order', ti.chain('minimax', true), ['minimax', 'elevenlabs', 'edge']);
eq('without fallback only the chosen one', ti.chain('elevenlabs', false), ['elevenlabs']);
eq('an unknown service becomes the one that needs no key', ti.chain('nope', false), ['edge']);
eq('SSML text is escaped', ti.xmlEscape(`a<b>&"c'`), 'a&lt;b&gt;&amp;&quot;c&apos;');
expect('the Microsoft voice list starts with 晓晓', ti.EDGE_VOICES[0].id === 'zh-CN-XiaoxiaoNeural' && ti.EDGE_VOICES.every((v) => /Neural$/.test(v.id)));
eq('the voices of "edge" come without a key', (await tts.voices('edge')).length, ti.EDGE_VOICES.length);
{
  // Speech models: the chosen one goes into the request, '' or junk means the recommended one.
  type Model = { id: string; name: string; note?: string; recommended?: boolean; legacy?: boolean };
  const tm = tts as unknown as {
    models(p: string): Promise<{ models: Model[]; live: boolean }>;
    test(v: object, o?: object): Promise<{ ok: boolean; error?: string }>;
    _internals: {
      MODELS: Record<string, Model[]>; RUN: Record<string, (t: string, id: string, o: { onChunk(b: Buffer, m: string): void; model?: string }) => Promise<void>>;
      pickModel(p: string, m?: string): string; elevenRequest(t: string, v: string, m?: string): { url: string; body: { text: string; model_id: string } };
      elevenModelList(raw: unknown): Model[]; minimaxBody(t: string, v: string, m?: string): { model: string; voice_setting: { voice_id: string } };
    };
  };
  const mi = tm._internals;
  eq('the recommended models are ElevenLabs v4 and MiniMax 2.8 HD', [mi.MODELS.elevenlabs[0].id, mi.MODELS.minimax[0].id], ['eleven_v4', 'speech-2.8-hd']);
  eq('a chosen ElevenLabs model goes into the request', mi.elevenRequest('你好', 'voice1', 'eleven_flash_v2_5').body, { text: '你好', model_id: 'eleven_flash_v2_5' });
  eq('none chosen (or junk) = the recommended one', [mi.elevenRequest('你好', 'v', '').body.model_id, mi.pickModel('elevenlabs', 'a b/c'), mi.minimaxBody('你好', 'v', undefined).model], ['eleven_v4', 'eleven_v4', 'speech-2.8-hd']);
  eq('a chosen MiniMax model goes into the request, with the voice', [mi.minimaxBody('你好', 'female-shaonv', 'speech-2.6-hd').model, mi.minimaxBody('你好', 'female-shaonv', 'speech-2.6-hd').voice_setting.voice_id], ['speech-2.6-hd', 'female-shaonv']);
  const mm = await tm.models('minimax');
  eq('MiniMax offers its built-in list, recommended first, legacy marked', [mm.live, mm.models[0].id, mm.models[0].recommended, mm.models.filter((m) => m.legacy).length], [false, 'speech-2.8-hd', true, 4]);
  eq('without a key ElevenLabs offers the built-in list too', [(await tm.models('elevenlabs')).live, (await tm.models('elevenlabs')).models[0].id], [false, 'eleven_v4']);
  const live = mi.elevenModelList([
    { model_id: 'eleven_flash_v2_5', name: 'Flash v2.5', can_do_text_to_speech: true, languages: [{ language_id: 'en', name: 'English' }, { language_id: 'zh', name: 'Chinese' }] },
    { model_id: 'eleven_flash_v2', name: 'Flash v2', can_do_text_to_speech: true, languages: [{ language_id: 'en', name: 'English' }] },
    { model_id: 'eleven_english_sts_v2', name: 'STS', can_do_text_to_speech: false, languages: [{ language_id: 'zh', name: 'Chinese' }] },
    { model_id: 'eleven_v4', name: 'Eleven v4', can_do_text_to_speech: true, languages: [{ language_id: 'zh', name: 'Chinese' }] },
    { model_id: 'eleven_v5_preview', name: 'Eleven v5 Preview', can_do_text_to_speech: true, languages: [{ language_id: 'cmn', name: 'Mandarin Chinese' }] },
    { model_id: 'eleven_v3_conversational', name: 'v3 Conversational', can_do_text_to_speech: true, languages: [{ language_id: 'zh', name: 'Chinese' }] },
    { model_id: 'bad id!', name: 'x', can_do_text_to_speech: true },
  ]);
  eq('the account list keeps only models that read Mandarin over this endpoint, catalog order first', live.map((m) => m.id), ['eleven_v4', 'eleven_flash_v2_5', 'eleven_v5_preview']);
  eq('…with the catalog notes, the recommended mark, and a note for unknown ones', [live[0].recommended, live[1].note === mi.MODELS.elevenlabs[2].note, live[2].note], [true, true, '你账号里的模型']);

  // A chosen model the service refuses: she speaks with the recommended one; 试听 reports it instead.
  const runs: string[] = [];
  const orig = mi.RUN.minimax;
  mi.RUN.minimax = async (_t, _id, o) => {
    runs.push(o.model ?? '');
    if (o.model !== 'speech-2.8-hd') throw Object.assign(new Error('MiniMax：invalid params'), { code: 'REQUEST' });
    o.onChunk(Buffer.from('mp3'), 'audio/mpeg');
  };
  const r1 = await tts.synth('你好', { provider: 'minimax', voiceId: 'v', fallback: false, models: { minimax: 'speech-9-hd' } }, {});
  eq('a refused chosen model is retried with the recommended one', [runs, (r1 as { model: string }).model], [['speech-9-hd', 'speech-2.8-hd'], 'speech-2.8-hd']);
  runs.length = 0;
  const t1 = await tm.test({ provider: 'minimax', voiceId: 'v', model: 'speech-9-hd', text: '你好' }, {});
  eq('试听 does not swap the model: it reports the refusal', [runs, t1.ok, t1.error], [['speech-9-hd'], false, 'MiniMax：invalid params']);
  runs.length = 0;
  mi.RUN.minimax = async (_t, _id, o) => { runs.push(o.model ?? ''); throw new Error('MiniMax 密钥无效（或不是这个地域的密钥）'); };
  let other = '';
  try { await tts.synth('你好', { provider: 'minimax', voiceId: 'v', fallback: false, models: { minimax: 'speech-2.6-hd' } }, {}); } catch (e) { other = (e as Error).message; }
  eq('other failures (a bad key) are not retried with another model', [runs, other], [['speech-2.6-hd'], 'MiniMax 密钥无效（或不是这个地域的密钥）']);
  mi.RUN.minimax = orig;
}
{
  let msg = '';
  try { await tts.synth('   ', { provider: 'edge' }, {}); } catch (e) { msg = (e as Error).message; }
  eq('nothing to read: an error, not a silent success', msg, '没有可以读的文字');
  let denied = '';
  try { await tts.voices('nope'); } catch (e) { denied = (e as Error).message; }
  eq('an unknown service is refused', denied, '未知的语音服务');
}

/* ───────────────────────── settings inputs and storage ───────────────────────── */

/* ───────────────────────── the puppet (pseudo Live2D) ───────────────────────── */

console.log('Puppet');
{
  const rigs = RIGS as Record<string, unknown>;
  // A fixed sequence instead of Math.random, so the checks are repeatable.
  const seq = (...v: number[]) => { let i = 0; return () => v[i++ % v.length]; };

  const len = BLINK.close + BLINK.hold + BLINK.open;
  eq('a blink: open, shut in the middle, open again', [blinkCurve(-1), blinkCurve(BLINK.close + 10), blinkCurve(len + 1)], [0, 1, 0]);
  expect('…and it closes and opens smoothly', blinkCurve(BLINK.close / 2) > 0.3 && blinkCurve(BLINK.close / 2) < 0.7 && blinkCurve(len - BLINK.open / 2) > 0.3 && blinkCurve(len - BLINK.open / 2) < 0.7);
  {
    const b = new Blinker(0, seq(0, 0.9)); // first gap 2.2 s, then no double blink
    eq('no blink before the first gap', b.amount(2100), 0);
    eq('the first blink shuts her eyes', b.amount(2200 + BLINK.close + 5), 1);
    eq('…and is over a moment later', b.amount(2200 + len + 10), 0);
    const d = new Blinker(0, seq(0, 0.1, 0.5)); // a double blink
    d.amount(2200);
    eq('now and then she blinks twice', d.amount(2200 + len + 90 + BLINK.close + 5), 1);
    d.reset(10_000, 400);
    eq('after a pose change she waits before blinking again', d.amount(10_300), 0);
    // Back from sleep hours later: the missed blinks are skipped, and the next one comes within a normal gap.
    const z = new Blinker(0, seq(0.5, 0.9));
    z.amount(100);
    let seen = false;
    for (let t = 8 * 3600_000; t < 8 * 3600_000 + 7000; t += 16) if (z.amount(t) === 1) { seen = true; break; }
    expect('after a long pause she blinks again within a few seconds', seen);
  }
  const breaths = Array.from({ length: 40 }, (_, i) => breath(i * 95));
  expect('breathing stays between out (0) and in (1), and goes both ways in a cycle', Math.min(...breaths) < 0.05 && Math.max(...breaths) > 0.95 && breaths.every((v) => v >= 0 && v <= 1));
  const sw = Array.from({ length: 200 }, (_, i) => sway(i * 50, 7300));
  expect('the sway stays within ±1 and moves both ways', Math.max(...sw.map(Math.abs)) <= 1 && Math.min(...sw) < -0.5 && Math.max(...sw) > 0.5);

  eq('silence keeps the mouth shut; speech opens it, never past fully open', [mouthTarget(0), mouthTarget(0.01), mouthTarget(0.5)], [0, 0, 1]);
  expect('a louder voice opens the mouth wider', mouthTarget(0.05) < mouthTarget(0.09) && mouthTarget(0.09) < mouthTarget(0.13));
  {
    const env = new MouthEnvelope();
    let v = 0;
    for (let t = 0; t < 60; t += 16) v = env.step(1, 16);
    expect('the mouth opens within a few frames', v > 0.8);
    for (let t = 0; t < 60; t += 16) v = env.step(0, 16);
    expect('…and closes a little more slowly', v > 0.2 && v < 0.8);
    for (let t = 0; t < 600; t += 16) v = env.step(0, 16);
    eq('…until it is shut', v, 0);
    const bab = new Babble(seq(0.9, 0.9, 0.3, 0.1, 0.05, 0.5));
    const lv = Array.from({ length: 30 }, (_, i) => bab.level(i * 40));
    expect('a line without a voice still moves the mouth, with short pauses', lv.some((x) => x > 0.5) && lv.some((x) => x === 0));
  }
  {
    const lag = new Lag();
    let t = 0;
    let min = 0;
    for (; t < 300; t += 16) { lag.push(1, t); min = Math.min(min, lag.step(t, 16)); }
    expect('dragged to the right, the hair trails to the left', min < -0.5);
    let max = 0;
    for (; t < 1200; t += 16) max = Math.max(max, lag.step(t, 16));
    expect('let go, it swings back past the middle', max > 0.05);
    for (; t < 6000; t += 16) lag.step(t, 16);
    expect('…and settles', lag.settled);
  }

  for (const mode of ['firefly', 'sam']) {
    const rig = parseRig(rigs[mode]);
    expect(`the ${mode} rig from scripts/pet-rig.py is valid`, !!rig);
    if (!rig) continue;
    const files = Object.entries(rig.poses).flatMap(([pose, e]) => [pose, e!.weights, e!.blink, e!.talk].filter(Boolean) as string[]);
    const missing = files.filter((f) => !fs.existsSync(path.join(root, 'public', 'pet', mode, `${f}.png`)));
    eq(`every picture the ${mode} rig names is in public/pet/`, missing, []);
    expect(`${mode}: idle can blink and talk, and the poses she watches the game in can blink`, !!rig.poses.idle?.blink && !!rig.poses.idle?.talk && !!rig.poses.watch?.blink);
  }
  const good = rigs.firefly as Record<string, unknown>;
  eq('a broken rig is refused (the plain pictures are used instead)', [parseRig(null), parseRig({ ...good, size: 'big' }), parseRig({ ...good, poses: {} }), parseRig({ ...good, mouth: { kind: 'shout', box: [1, 1, 2, 2] } }), parseRig({ ...good, hip: 10 })], [null, null, null, null, null]);
  const odd = parseRig({ ...good, poses: { idle: { weights: 'w-idle', blink: '../../etc/passwd' }, watch: { weights: 'W I' } } });
  eq('file names in a rig are plain names only', [odd?.poses.idle, odd?.poses.watch], [{ weights: 'w-idle' }, undefined]);
  eq('a pose the rig lacks is drawn as idle', rigPose(odd!, 'watch'), 'idle');
}

/* ───────────────────────── the chat panel (its plain logic) ───────────────────────── */

console.log('Chat panel');
{
  const her = (id: string, text: string, more: Partial<PetChatEntry> = {}): PetChatEntry => ({ id, who: 'her', text, at: 1, ...more });
  const me = (id: string, text: string): PetChatEntry => ({ id, who: 'me', text, at: 1 });
  let log: PetChatEntry[] = [];
  log = applyChat(log, { op: 'put', entry: me('m1', '这个怎么打？') });
  log = applyChat(log, { op: 'put', entry: her('a1', '嗯……让我想想', { streaming: true, mood: 'think' }) });
  eq('a new message goes at the end', log.map((e) => e.id), ['m1', 'a1']);
  eq('while she thinks, the header says so', chatActivity(log), 'think');
  log = applyChat(log, { op: 'put', entry: her('a1', '先去', { streaming: true, mood: 'talk' }) });
  log = applyChat(log, { op: 'put', entry: me('m2', '然后呢') });
  log = applyChat(log, { op: 'put', entry: her('a1', '先去左边', { streaming: true, mood: 'talk' }) });
  eq('her reply streams into the same message, where it began', [log.map((e) => e.id), log[1].text, chatActivity(log)], [['m1', 'a1', 'm2'], '先去左边', 'typing']);
  log = applyChat(log, { op: 'put', entry: her('a1', '先去左边。', { more: '先去左边。\n再往前走。', mood: 'talk' }) });
  eq('a finished long reply shows in full', [fullText(log[1]), chatActivity(log)], ['先去左边。\n再往前走。', null]);
  eq('a message is taken back by id; an unknown id changes nothing', [applyChat(log, { op: 'drop', id: 'm2' }).map((e) => e.id), applyChat(log, { op: 'drop', id: 'x' }) === log], [['m1', 'a1'], true]);
  for (let i = 0; i < 70; i++) log = applyChat(log, { op: 'put', entry: me(`n${i}`, String(i)) });
  eq(`the log keeps the last ${CHAT_MAX} messages`, [log.length, log[0].id, log[log.length - 1].id], [CHAT_MAX, 'n10', 'n69']);
  const many = Array.from({ length: 80 }, (_, i) => me(`r${i}`, 'x'));
  eq('the whole log from the desktop is capped too', [applyChat([], { op: 'reset', entries: many }).length, applyChat([], { op: 'reset', entries: many })[0].id], [CHAT_MAX, 'r20']);
  eq('her avatar shows on the first of her messages in a row', [startsRun([me('a', ''), her('b', ''), her('c', ''), me('d', '')], 1), startsRun([me('a', ''), her('b', ''), her('c', '')], 2), startsRun([her('a', '')], 0)], [true, false, true]);
  eq('the log follows the bottom only when scrolled to it', [atEnd(500, 800, 300), atEnd(480, 800, 300), atEnd(100, 800, 300)], [true, true, false]);

  const k = (key: string, more: { shiftKey?: boolean; isComposing?: boolean; keyCode?: number } = {}) => composerKey({ key, ...more });
  eq('Enter sends, Shift+Enter is a new line, Esc closes, other keys are typing', [k('Enter'), k('Enter', { shiftKey: true }), k('Escape'), k('a')], ['send', null, 'close', null]);
  eq('while an IME is composing, Enter and Esc belong to it (isComposing, or keyCode 229)', [k('Enter', { isComposing: true }), k('Enter', { keyCode: 229 }), k('Process', { keyCode: 229 }), k('Escape', { isComposing: true })], [null, null, null, null]);
}

/* ───────────────────────── 实时陪玩: hearing and speaking ───────────────────────── */

console.log('Live');
{
  const { Vad } = req('./electron/pet/vad.cjs') as { Vad: new (o: object) => { push(b: Buffer): void; setBusy(on: boolean): void; floor: number } };
  const R = 16000;
  // Noise, or a voice-like tone that wavers the way speech does.
  const tone = (ms: number, amp: number, f = 0) => {
    const n = (R * ms) / 1000;
    const b = Buffer.alloc(n * 2);
    let seed = 7;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = ((seed / 0x7fffffff) * 2 - 1) * 0.002;
      const v = f ? amp * (Math.sin((2 * Math.PI * f * i) / R) + 0.5 * Math.sin((2 * Math.PI * f * 2.7 * i) / R)) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / R)) : 0;
      b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((noise + v) * 32767))), i * 2);
    }
    return b;
  };
  const run = (busy: boolean, ...parts: Buffer[]) => {
    const ev: string[] = [];
    let t = 0;
    let sent = 0;
    const v = new Vad({ sensitivity: 50, onStart: () => ev.push(`start@${t}`), onAudio: (b: Buffer) => { sent += b.length; }, onEnd: () => ev.push(`end@${t}`) });
    v.setBusy(busy);
    for (const p of parts) for (let o = 0; o < p.length; o += 4096) { v.push(p.subarray(o, o + 4096)); t += Math.min(4096, p.length - o) / 32; }
    return { ev, sentMs: sent / 32 };
  };
  const a = run(false, tone(1000, 0), tone(1200, 0.08, 180), tone(1500, 0));
  const start = Number(a.ev[0]?.split('@')[1]);
  const end = Number(a.ev[1]?.split('@')[1]);
  expect('speech is noticed within about a tenth of a second', a.ev.length === 2 && start >= 1000 && start <= 1150, a.ev.join(' '));
  expect('and its end about two thirds of a second after it stops', end >= 2500 && end <= 3000, a.ev.join(' '));
  expect('what is sent starts a little before the first word (nothing clipped)', a.sentMs >= 1200 && a.sentMs <= 2200, String(a.sentMs));
  eq('silence and steady hum never count as speech', run(false, tone(3000, 0), tone(3000, 0.004, 300)).ev, []);
  eq('while she talks, a short or quiet sound does not cut in', run(true, tone(1000, 0), tone(120, 0.08, 180), tone(800, 0), tone(1000, 0.01, 200)).ev, []);
  expect('but the user talking over her still does', run(true, tone(1000, 0), tone(1500, 0.15, 180), tone(1500, 0)).ev.length === 2);
}
{
  // The ears: ElevenLabs Scribe over a fake WebSocket.
  type Sent = { message_type: string; audio_base_64: string; commit: boolean; sample_rate: number };
  const sockets: Array<{ url: string; headers: Record<string, string>; sent: Sent[]; onmessage?: (e: { data: string }) => void; onclose?: () => void; closed: boolean; msg(m: object): void; close(): void }> = [];
  class FakeWs {
    url: string; headers: Record<string, string>; sent: Sent[] = []; closed = false;
    onmessage?: (e: { data: string }) => void; onclose?: () => void; onerror?: () => void;
    constructor(url: string, o: { headers: Record<string, string> }) { this.url = url; this.headers = o.headers; sockets.push(this as never); }
    send(t: string) { this.sent.push(JSON.parse(t)); }
    close() { if (this.closed) return; this.closed = true; setTimeout(() => this.onclose?.(), 0); }
    msg(m: object) { this.onmessage?.({ data: JSON.stringify(m) }); }
  }
  const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWs;
  delete req.cache[req.resolve('./electron/pet/realtime.cjs')];
  const ears = req('./electron/pet/realtime.cjs') as {
    start(o: object, h: object): Promise<{ ok: boolean; error?: string }>; stop(m?: string): void; pushMic(b: Buffer): void; setBusy(on: boolean): void; listenOnce(): boolean; update(o: object): void; active(): boolean;
  };
  const heard: string[] = [];
  const hooks = (key: string | null = 'sk-el') => ({
    key: () => key, state: (st: string, m?: string) => heard.push(`state:${st}${m ? `:${m}` : ''}`),
    speechStart: () => heard.push('start'), partial: (t: string) => heard.push(`partial:${t}`), final: (t: string) => heard.push(`final:${t}`), none: () => heard.push('none'),
  });
  eq('without an ElevenLabs key it does not start', (await ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, hooks(null))).ok, false);

  const starting = ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, hooks());
  await wait(5);
  const ws = sockets[sockets.length - 1];
  const u = new URL(ws.url);
  eq('it connects to Scribe realtime with the key in a header, PCM 16 kHz, Mandarin, committing itself', [u.host, u.pathname, u.searchParams.get('model_id'), u.searchParams.get('audio_format'), u.searchParams.get('language_code'), u.searchParams.get('commit_strategy'), ws.headers['xi-api-key']],
    ['api.elevenlabs.io', '/v1/speech-to-text/realtime', 'scribe_v2_realtime', 'pcm_16000', 'zh', 'manual', 'sk-el']);
  expect('…and biased towards her names', u.searchParams.getAll('keyterms').includes('流萤'));
  ws.msg({ message_type: 'session_started', session_id: 's1', config: {} });
  eq('the session is live once the server says so', [(await starting).ok, heard.includes('state:live')], [true, true]);

  const tone = (ms: number, amp: number) => { const n = 16 * ms; const b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * 32767 * Math.sin(i / 3) * (0.6 + 0.4 * Math.sin(i / 1000))), i * 2); return b; };
  const feed = (b: Buffer) => { for (let o = 0; o < b.length; o += 4096) ears.pushMic(b.subarray(o, o + 4096)); };
  feed(tone(800, 0));
  eq('silence sends nothing', ws.sent.length, 0);
  feed(tone(1000, 0.1));
  expect('speech goes out as base64 PCM chunks of about 0.1 s', heard.includes('start') && ws.sent.length >= 8 && ws.sent.every((m) => m.message_type === 'input_audio_chunk' && m.sample_rate === 16000 && !m.commit));
  feed(tone(1200, 0));
  const commit = ws.sent[ws.sent.length - 1];
  eq('when the user stops, the turn is committed', [commit.commit, commit.audio_base_64], [true, '']);
  ws.msg({ message_type: 'partial_transcript', text: '' });
  ws.msg({ message_type: 'committed_transcript', text: '这里往哪走' });
  eq('the committed words are the turn', heard.slice(-1), ['final:这里往哪走']);
  feed(tone(1000, 0.1));
  feed(tone(1200, 0));
  ws.msg({ message_type: 'committed_transcript', text: '' });
  eq('a turn without words ends empty', heard.slice(-1), ['none']);

  ears.update({ listen: 'key', sensitivity: 50, autoOffMin: 20 });
  const before = ws.sent.length;
  feed(tone(1000, 0.1));
  eq('in the hotkey mode nothing is heard until the key is pressed', ws.sent.length, before);
  expect('…then one sentence is', ears.listenOnce());
  feed(tone(1000, 0.1));
  feed(tone(1200, 0));
  expect('…and it is committed', ws.sent.length > before && ws.sent[ws.sent.length - 1].commit);
  ws.msg({ message_type: 'committed_transcript', text: '好的' });
  feed(tone(1000, 0.1));
  eq('…and then it stops listening again', ws.sent[ws.sent.length - 1].commit, true);

  ears.update({ listen: 'auto', sensitivity: 50, autoOffMin: 20 });
  const h0 = heard.length;
  feed(tone(1000, 0.1));
  feed(tone(1200, 0));
  feed(tone(800, 0.1));
  feed(tone(1200, 0));
  ws.msg({ message_type: 'committed_transcript', text: '帮我看看这个' });
  ws.msg({ message_type: 'committed_transcript', text: '吧' });
  eq('two quick sentences whose words come back late are one, in order, nothing lost', heard.slice(h0).filter((x) => x.startsWith('final') || x === 'none'), ['final:帮我看看这个吧']);
  ws.msg({ message_type: 'auth_error', error: 'bad key' });
  expect('a key the server refuses ends the session with a reason', heard.some((h) => h.startsWith('state:error:ElevenLabs 的密钥无效')) && !ears.active());

  // Options the server refuses: once more with the bare minimum.
  const second = ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, hooks());
  await wait(5);
  const w2 = sockets[sockets.length - 1];
  w2.msg({ message_type: 'invalid_request', error: 'bad language' });
  w2.close();
  await wait(20);
  const w3 = sockets[sockets.length - 1];
  expect('a refused set of options is retried without language, filters and names', w3 !== w2 && !new URL(w3.url).searchParams.has('language_code') && !new URL(w3.url).searchParams.has('keyterms'));
  w3.msg({ message_type: 'session_started', session_id: 's3', config: {} });
  eq('…and that session runs', (await second).ok, true);
  ears.stop();
  eq('stopping closes the socket', w3.closed, true);
  const t0 = Date.now();
  const third = ears.start({ listen: 'auto', sensitivity: 50, autoOffMin: 20 }, hooks());
  await wait(5);
  ears.stop();
  const r3 = await third;
  expect('stopping while it starts ends the start at once, as cancelled', r3.ok === false && (r3 as { cancelled?: boolean }).cancelled === true && Date.now() - t0 < 1000);
  (globalThis as { WebSocket?: unknown }).WebSocket = realWs;
}
{
  // Speaking a live reply: raw PCM, whole samples, the right request.
  const tl = req('./electron/pet/tts.cjs') as {
    live(t: string, v: object, o: object): Promise<{ provider: string; mime: string }>;
    _internals: { RUN: Record<string, (t: string, id: string, o: { onChunk(b: Buffer, m: string): void; model?: string; pcm?: boolean; previous?: string; plain?: boolean }) => Promise<void>>; elevenRequest(t: string, v: string, m?: string, o?: object): { url: string; body: Record<string, unknown> }; PCM_MIME: string };
  };
  const ti2 = tl._internals;
  const rq = ti2.elevenRequest('先去左边。', 'v1', 'eleven_flash_v2_5', { pcm: true, previous: '嗯，开拓者。' });
  eq('a live sentence asks ElevenLabs for 24 kHz PCM, in Mandarin, after what she just said', [new URL(rq.url).searchParams.get('output_format'), rq.body.language_code, rq.body.previous_text], ['pcm_24000', 'zh', '嗯，开拓者。']);
  eq('Multilingual v2 does not take a language code', ti2.elevenRequest('好。', 'v1', 'eleven_multilingual_v2', { pcm: true }).body.language_code, undefined);
  eq('an ordinary line is still MP3', new URL(ti2.elevenRequest('好。', 'v1').url).searchParams.get('output_format'), 'mp3_44100_64');
  const orig = { ...ti2.RUN };
  const seen: string[] = [];
  ti2.RUN.elevenlabs = async (_t, _id, o) => { seen.push(`${o.model}|${o.pcm}|${o.previous}`); o.onChunk(Buffer.from([1, 2, 3]), ti2.PCM_MIME); o.onChunk(Buffer.from([4, 5, 6, 7, 8]), ti2.PCM_MIME); };
  const chunks: number[][] = [];
  const r1 = await tl.live('先去左边。', { provider: 'elevenlabs', voiceId: 'ff', fallback: false, models: { elevenlabs: 'eleven_v4' } }, { onPcm: (b: Buffer) => chunks.push([...b]), fast: true, previous: '嗯。' });
  eq('the faster voice model is used, and PCM chunks always hold whole samples (an odd byte waits for the next chunk)', [seen[0], chunks], ['eleven_flash_v2_5|true|嗯。', [[1, 2], [3, 4, 5, 6, 7, 8]]]);
  eq('…reported as PCM', r1, { provider: 'elevenlabs', mime: ti2.PCM_MIME });
  ti2.RUN.elevenlabs = async (_t, _id, o) => { seen.push(`plain:${!!o.plain}`); if (!o.plain) throw Object.assign(new Error('400'), { code: 'REQUEST' }); o.onChunk(Buffer.from([0, 0]), ti2.PCM_MIME); };
  seen.length = 0;
  await tl.live('好。', { provider: 'elevenlabs', voiceId: 'ff', fallback: false }, { onPcm() {} });
  eq('a model that refuses the language or previous text is asked again without them', seen, ['plain:false', 'plain:true']);
  ti2.RUN.elevenlabs = async () => { throw new Error('ElevenLabs 请求太频繁或额度用完了'); };
  ti2.RUN.minimax = async (_t, _id, o) => { seen.push(`mm:${o.pcm}`); o.onChunk(Buffer.from([0, 0]), ti2.PCM_MIME); };
  seen.length = 0;
  eq('a failing service hands over to the next one, also as PCM', [(await tl.live('好。', { provider: 'elevenlabs', voiceId: 'ff', fallback: true }, { onPcm() {} })).provider, seen], ['minimax', ['mm:true']]);
  Object.assign(ti2.RUN, orig);
}

console.log('Settings');
eq('"alt + f" is written Alt+F', parseAccelerator('alt + f'), { ok: true, value: 'Alt+F' });
eq('modifiers come in a fixed order', parseAccelerator('shift+alt+ctrl+f5'), { ok: true, value: 'Ctrl+Alt+Shift+F5' });
expect('a key with no Ctrl / Alt / Win would eat typing', !parseAccelerator('Shift+F').ok);
expect('system shortcuts are refused', !parseAccelerator('Ctrl+C').ok && !parseAccelerator('Alt+F4').ok);
expect('Command does not exist on Windows', !parseAccelerator('Cmd+F').ok);
expect('a lone key is refused', !parseAccelerator('F').ok && !parseAccelerator('').ok);
eq('a path becomes an exe name', parseExe('"C:\\Games\\StarRail.exe"'), { ok: true, value: 'starrail.exe' });
eq('a bare name gets .exe', parseExe('StarRail'), { ok: true, value: 'starrail.exe' });
expect('scripts and shortcuts are not programs', !parseExe('run.bat').ok && !parseExe('x.lnk').ok && !parseExe('').ok);
eq('numbers are clamped', [parseIntIn(60, 3600)('5'), parseIntIn(60, 3600)(' 99999 ')], [{ ok: true, value: '60' }, { ok: true, value: '3600' }]);

store.init(emptyState(0));
actions.setPet({ scale: 5, cooldownSec: 5, imagesPerHour: 9999, voice: { volume: -3, voiceId: '  abc  ' }, neverWatch: ['  A.EXE ', 'a.exe', ''], hotkeyAsk: '   ' });
{
  const p = store.get().settings.pet;
  eq('a pet setting is clamped to its range', [p.scale, p.cooldownSec, p.imagesPerHour, p.voice.volume], [1.6, 60, 240, 0]);
  eq('a voice change keeps the other voice settings', [p.voice.voiceId, p.voice.provider, p.voice.enabled], ['abc', 'elevenlabs', true]);
  eq('no model chosen yet: both services use their recommended one', p.voice.models, { elevenlabs: '', minimax: '' });
  eq('program lists are lower-cased and de-duplicated', p.neverWatch, ['a.exe']);
  eq('an empty hotkey falls back to the default', p.hotkeyAsk, DEFAULT_PET.hotkeyAsk);
}
actions.setPet({ vision: { key: 'claude:api', model: 'claude-haiku-5-5' } });
actions.setPet({ vision: undefined });
expect('{ vision: undefined } clears the model choice', store.get().settings.pet.vision === undefined);

const mem = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } },
});
{
  mem.set('firefly-harness/prefs', JSON.stringify({
    settingsRev: 2, policyRev: 2, navCollapsed: false, console: { open: false, height: 280, tab: 'tools' }, tools: [], agents: [],
    settings: { pet: { enabled: 'yes', proactivity: 'loud', cooldownSec: -4, scale: 99, neverWatch: ['  X.EXE', 5, null], voice: { provider: 'siri', volume: 400, models: { elevenlabs: 'eleven_flash_v2_5', minimax: '../../evil' } }, realtime: { listen: 'shout', sensitivity: 400, fastVoice: 'yes', autoOffMin: 1, workspaceId: 'old' }, hotkeyAsk: 'Ctrl+Alt+P' } },
  }));
  const s = loadState(1_000).settings.pet;
  eq('a garbled save cannot break the pet: bad values fall back', [s.enabled, s.proactivity, s.cooldownSec, s.scale], [DEFAULT_PET.enabled, DEFAULT_PET.proactivity, 60, 1.6]);
  eq('lists keep only strings, in lower case', s.neverWatch, ['x.exe']);
  eq('nested settings are checked too', [s.voice.provider, s.voice.volume, s.realtime, s.hotkeyAsk], [DEFAULT_PET.voice.provider, 100, { listen: DEFAULT_PET.realtime.listen, sensitivity: 100, fastVoice: DEFAULT_PET.realtime.fastVoice, autoOffMin: 5 }, 'Ctrl+Alt+P']);
  eq('a saved speech model is kept, a malformed one becomes the recommended one', s.voice.models, { elevenlabs: 'eleven_flash_v2_5', minimax: '' });
  mem.clear();
  eq('with nothing saved the defaults apply', loadState(2_000).settings.pet, DEFAULT_SETTINGS.pet);
}

/* ───────────────────────── picking models ───────────────────────── */

console.log('Models');
function models(configure: (m: ModelState) => void): ModelState {
  const m = initialModels();
  configure(m);
  return m;
}
const found = { found: true, login: 'yes', version: '1.0', detail: '', at: 0 } as never;
{
  const none = models(() => {});
  eq('with nothing connected there is no pick', [petVisionOptions(none).length, petWebOptions(none).length, petVisionEngine(none), petWebEngine(none), petChatEngine(none, {})], [0, 0, undefined, undefined, undefined]);
  const api = models((m) => { m.providers.claude.keyHint = '••••1'; m.providers.deepseek.keyHint = '••••2'; });
  const opts = petVisionOptions(api);
  expect('every vision model of a connected vendor is offered, and only those', opts.length > 0 && opts.some((o) => o.model === 'claude-haiku-5-5') && opts.some((o) => o.model === 'deepseek-flash') && !opts.some((o) => o.model === 'deepseek-v4-pro'));
  eq('the automatic pick is a fast one', petVisionEngine(api)?.model, 'claude-haiku-5-5');
  api.defaultEngine = 'deepseek';
  eq('among equals the default vendor wins', petVisionEngine(api)?.provider, 'deepseek');
  eq('a chosen model is used', petVisionEngine(api, { key: 'claude:api', model: 'claude-opus-5-5' })?.model, 'claude-opus-5-5');
  eq('a chosen model that is no longer connected is ignored', petVisionEngine(api, { key: 'gpt:api', model: 'gpt-6-luna' })?.provider, 'deepseek');
  eq('the engine is an API one that talks plain chat', [petVisionEngine(api)?.auth, petVisionEngine(api)?.access], ['api', 'read']);
  eq('a web model needs a command-line tool', petWebEngine(api), undefined);
  eq('plain talk uses the same cheap model', petChatEngine(api, {})?.provider, 'deepseek');

  const cli = models((m) => { m.providers.claude.cli = found; m.providers.claude.auth = 'cli'; m.providers.claude.driver = 'claude-code'; });
  eq('a logged-in Claude Code is a web model', petWebOptions(cli).every((o) => o.key === 'claude:cli') && petWebOptions(cli).length > 0, true);
  const web = petWebEngine(cli, undefined, 'C:/scratch');
  eq('the automatic web pick runs in the scratch folder', [web?.provider, web?.auth, web?.driver, web?.cwd], ['claude', 'cli', 'claude-code', 'C:/scratch']);
  eq('plain talk falls back to it when no API model is connected', petChatEngine(cli, { cwd: 'C:/scratch' })?.auth, 'cli');
  eq('with nothing connected on the other side there is no picture model', petVisionEngine(cli), undefined);
  expect('both kinds of access show up as choices', engineChoices(cli).some((c) => c.auth === 'cli'));
}

/* ───────────────────────── model specs ───────────────────────── */

console.log('Model specs');
{
  const m = models((x) => {
    x.providers.claude.keyHint = '••••1'; x.providers.deepseek.keyHint = '••••2';
    x.providers.claude.cli = found; x.providers.claude.driver = 'claude-code';
    x.providers.gpt.cli = found; x.providers.gpt.driver = 'codex';
  });
  const st = emptyState(0);
  st.models = m;
  store.init(st);
  const vision = petVisionEngine(m, { key: 'claude:api', model: 'claude-haiku-5-5' }) as TaskEngine;
  const img = { type: 'image' as const, mime: 'image/jpeg' as const, data: '/9j/4AAQ' };
  const ok = petApiSpec(vision, { system: 'sys', messages: [{ role: 'user', content: [img, { type: 'text', text: '看' }] }] });
  expect('a picture question to a model that can see builds a spec', ok.ok && ok.value.driver === 'api-anthropic' && ok.value.model === 'claude-haiku-5-5' && ok.value.system === 'sys');
  expect('the reply is kept short, with room for thinking if it cannot be switched off', ok.ok && (ok.value.maxTokens ?? 0) >= 800 && (ok.value.maxTokens ?? 0) <= 3000, ok.ok ? String(ok.value.maxTokens) : '');
  const blind: TaskEngine = { kind: 'live', provider: 'deepseek', auth: 'api', model: 'deepseek-v4-pro', label: 'x' };
  const refused = petApiSpec(blind, { system: 's', messages: [{ role: 'user', content: [img] }] });
  expect('a picture for a model that cannot see is refused in Chinese', !refused.ok && refused.error.includes('不能看图'));
  expect('plain text to the same model is fine', petApiSpec(blind, { system: 's', messages: [{ role: 'user', content: '你好' }] }).ok);
  expect('a command-line model cannot take the API route', !petApiSpec({ ...vision, auth: 'cli', driver: 'claude-code' }, { system: 's', messages: [] }).ok);

  const claudeCli = petWebEngine(m, { key: 'claude:cli', model: '' }, 'C:/scratch') as TaskEngine;
  const web = petCliSpec(claudeCli, { system: 'sys', prompt: '问题', webSearch: true });
  expect('Claude Code with the web: work access, only the two web tools allowed', web.ok && web.value.access === 'work' && isDeepStrictEqual(web.value.allow, ['WebSearch', 'WebFetch']));
  expect('everything else is denied outright', web.ok && (web.value.deny ?? []).includes('Bash') && (web.value.deny ?? []).includes('Write') && !(web.value.deny ?? []).includes('WebSearch'));
  expect('she is also told in words', web.ok && (web.value.system ?? '').includes('联网搜索') && web.value.readOnly === true);
  const quiet = petCliSpec(claudeCli, { system: 'sys', prompt: '问题', webSearch: false });
  expect('without the web: chat access, no tools at all', quiet.ok && quiet.value.access === 'chat' && !quiet.value.allow && (quiet.value.system ?? '').includes('不要使用任何工具'));
  const codex = petWebEngine(m, { key: 'gpt:cli', model: '' }, 'C:/scratch') as TaskEngine;
  const cx = petCliSpec(codex, { system: 'sys', prompt: '问题', webSearch: true });
  expect('Codex searches the web in a read-only sandbox', cx.ok && cx.value.access === 'chat' && cx.value.webSearch === true && cx.value.sandbox === 'read-only');
  expect('an API model is not a web helper', !petCliSpec(vision, { system: 's', prompt: 'p', webSearch: true }).ok);
  store.update((d) => { const t = d.tools.find((x) => x.id === 'web_search'); if (t) t.permission = 'off'; const f = d.tools.find((x) => x.id === 'web_fetch'); if (f) f.permission = 'off'; });
  const off = petCliSpec(claudeCli, { system: 'sys', prompt: '问题', webSearch: true });
  expect('with both web tools switched off in 工具与技能 she does not search', off.ok && off.value.access === 'chat' && !off.value.allow);
}

/* ───────────────────────── the desktop side, with Electron faked ───────────────────────── */

console.log('Desktop side');
const modules = req.cache;
function fake(rel: string, exports: unknown) {
  const file = req.resolve(rel);
  modules[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [], path: path.dirname(file) } as unknown as NodeJS.Module;
}
type Handler = (e: unknown, ...a: unknown[]) => unknown;
const ipcOn = new Map<string, Handler>();
const ipcHandle = new Map<string, Handler>();
const switches: Array<[string, string?]> = [];
let menuItems: Array<{ label?: string; click?: () => void }> = [];

/* A fake BrowserWindow for the capture page: it answers like the real page would. */
const pageWc = {
  sent: [] as Array<[string, unknown]>, ran: [] as Array<[string, boolean | undefined]>,
  /** The capture page's top frame: requests are believed when they come from this very object. */
  mainFrame: { url: '' },
  isDestroyed: () => false, setAudioMuted() {}, setWindowOpenHandler() {}, on() {},
  send(ch: string, p: unknown) { this.sent.push([ch, p]); },
  async executeJavaScript(code: string, gesture?: boolean) {
    this.ran.push([code, gesture]);
    const gen = Number(/start\((\d+)\)/.exec(code)?.[1]);
    ipcOn.get('pet-capture:state')?.({ sender: pageWc }, { gen, live: true, width: 1920, height: 1080 });
    return true;
  },
};
class FakeWindow {
  webContents = pageWc;
  isDestroyed() { return false; }
  on() {}
  destroy() {}
  loadFile() { setTimeout(() => ipcOn.get('pet-capture:ready')?.({ sender: pageWc }), 5); return Promise.resolve(); }
}
let displayHandler: ((req: { frame?: object }, cb: (s: object) => void) => Promise<void>) | undefined;
type PermWc = { getURL(): string } | null;
let permRequest: ((wc: PermWc, permission: string, cb: (ok: boolean) => void, details: object) => void) | undefined;
let permCheck: ((wc: PermWc, permission: string, origin: string, details: object) => boolean) | undefined;
let sources: Array<{ id: string }> = [{ id: 'window:4242:0' }, { id: 'window:1:0' }];
const fakeElectron = {
  app: { commandLine: { appendSwitch: (k: string, v?: string) => { switches.push([k, v]); } }, getPath: () => path.join(root, 'node_modules', '.cache') },
  ipcMain: { on: (c: string, f: Handler) => ipcOn.set(c, f), handle: (c: string, f: Handler) => ipcHandle.set(c, f) },
  Menu: { buildFromTemplate: (items: typeof menuItems) => ({ popup: () => { menuItems = items; } }) },
  Notification: class { static isSupported() { return false; } show() {} },
  BrowserWindow: FakeWindow,
  desktopCapturer: { getSources: async () => sources },
  session: { fromPartition: () => ({ setDisplayMediaRequestHandler: (h: typeof displayHandler) => { displayHandler = h; }, setPermissionRequestHandler: (h: typeof permRequest) => { permRequest = h; }, setPermissionCheckHandler: (h: typeof permCheck) => { permCheck = h; } }) },
  globalShortcut: { register: () => true, unregister() {} },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
};
fake('electron', fakeElectron);

// 1. The capture module itself (real code, fake window).
{
  const capture = req('./electron/pet/capture.cjs') as {
    init(): void; start(h: string): Promise<boolean>; stop(): boolean; frame(o?: object): Promise<{ data: string; mime: string; width: number } | null>;
    png(o?: object): Promise<Buffer | null>; onScene(fn: (e: { state: string; since: number; change: number }) => void): () => void;
    onLive(fn: (live: boolean) => void): () => void; status(): { active: boolean; live: boolean; hwnd: string | null; black: boolean }; dispose(): void;
  };
  capture.init();
  const pageUrl = pathToFileURL(path.join(root, 'dist', 'capture.html')).href;
  pageWc.mainFrame.url = pageUrl;
  expect('before anything starts, nothing is captured', !capture.status().active && !capture.status().live);
  const lives: boolean[] = [];
  capture.onLive((v) => lives.push(v));
  eq('a window handle must be decimal', [await capture.start('abc'), await capture.start('0'), await capture.start('')], [false, false, false]);
  const started = await capture.start('4242');
  eq('starting asks the page (with a user gesture) and waits for the first frame', [started, pageWc.ran.length, pageWc.ran[0][1]], [true, 1, true]);
  eq('status shows what is captured', [capture.status().active, capture.status().live, capture.status().hwnd], [true, true, '4242']);
  eq('listeners hear that frames are flowing', lives, [true]);
  eq('starting the same window again does nothing', [await capture.start('4242'), pageWc.ran.length], [true, 1]);
  const gen = Number(/start\((\d+)\)/.exec(pageWc.ran[0][0])?.[1]);

  // What the page may be given to capture.
  const answers: object[] = [];
  await displayHandler!({ frame: pageWc.mainFrame }, (s) => answers.push(s));
  // Another frame — even one that claims the same address — is not the capture page.
  await displayHandler!({ frame: { url: pageUrl } }, (s) => answers.push(s));
  eq('only the capture page gets the chosen window; anything else gets nothing', [JSON.stringify(answers[0]), JSON.stringify(answers[1])], [JSON.stringify({ video: { id: 'window:4242:0' } }), '{}']);
  sources = [{ id: 'window:1:0' }];
  await displayHandler!({ frame: pageWc.mainFrame }, (s) => answers.push(s));
  eq('a window that is gone is not substituted by another', JSON.stringify(answers[2]), '{}');
  // Electron 44 asks for getDisplayMedia as 'media' with no device types: that must pass, a camera or microphone must not.
  const asks: boolean[] = [];
  const capWc = pageWc as unknown as PermWc;
  permRequest!(capWc, 'media', (v) => asks.push(v), { mediaTypes: [] });
  permRequest!(capWc, 'display-capture', (v) => asks.push(v), {});
  permRequest!(capWc, 'media', (v) => asks.push(v), { mediaTypes: ['audio'] });
  permRequest!(capWc, 'media', (v) => asks.push(v), { mediaTypes: ['video'] });
  permRequest!({ getURL: () => pageUrl }, 'media', (v) => asks.push(v), { mediaTypes: [] }); // same address, other contents
  permRequest!(capWc, 'notifications', (v) => asks.push(v), {});
  eq('the capture page may ask for screen capture, nothing else, and no other page may', asks, [true, true, false, false, false, false]);
  eq('permission checks follow the same rule', [permCheck!(capWc, 'media', 'file:///', {}), permCheck!(capWc, 'media', 'file:///', { mediaType: 'audio' }), permCheck!(null, 'media', '', {})], [true, false, false]);

  // Scene events: the page reports how long a state had held; the desktop turns it into the wall-clock start.
  const scenes: Array<{ state: string; since: number; change: number }> = [];
  capture.onScene((e) => scenes.push(e));
  const tn = Date.now();
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen, state: 'static', since: 4000, change: 0.002 });
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen: gen - 1, state: 'cut', since: 0, change: 1 });
  ipcOn.get('pet-capture:scene')!({ sender: {}, }, { gen, state: 'cut', since: 0, change: 1 });
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen, state: 'bogus', since: 0, change: 1 });
  eq('only a scene from the page, of this capture, with a known state counts', scenes.length, 1);
  expect('"static for 4 s" becomes the moment it began', scenes[0].state === 'static' && Math.abs(scenes[0].since - (tn - 4000)) < 500 && scenes[0].change === 0.002);
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen, state: 'black', since: 2000, change: 0 });
  eq('black is reported in the status', capture.status().black, true);

  // Pictures on request.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const asked = capture.frame({ maxSide: 1280 });
  const grab = pageWc.sent.filter(([c]) => c === 'pet-capture:grab').pop()![1] as { id: string; kind: string; maxSide: number };
  eq('a picture request names the kind and size', [grab.kind, grab.maxSide], ['jpeg', 1280]);
  ipcOn.get('pet-capture:result')!({ sender: pageWc }, { id: grab.id, ok: true, data: new Uint8Array(jpeg), width: 1280, height: 720 });
  const f = await asked;
  eq('the frame comes back as base64 JPEG with its size', [f?.mime, f?.data, f?.width], ['image/jpeg', jpeg.toString('base64'), 1280]);
  const pngAsked = capture.png({ maxSide: 99999 });
  const grab2 = pageWc.sent.filter(([c]) => c === 'pet-capture:grab').pop()![1] as { id: string; kind: string; maxSide: number };
  eq('the size is capped', [grab2.kind, grab2.maxSide], ['png', 2560]);
  ipcOn.get('pet-capture:result')!({ sender: pageWc }, { id: grab2.id, ok: false });
  eq('a failed grab is null, not an error', await pngAsked, null);
  ipcOn.get('pet-capture:result')!({ sender: pageWc }, { id: 'nope', ok: true, data: new Uint8Array(3) });

  eq('stopping tells the page and the status goes quiet', [capture.stop(), capture.status().active, capture.status().live, pageWc.sent.some(([c, p]) => c === 'pet-capture:cmd' && (p as { op: string }).op === 'stop')], [true, false, false, true]);
  eq('with nothing captured there is no frame', await capture.frame(), null);
  ipcOn.get('pet-capture:scene')!({ sender: pageWc }, { gen, state: 'cut', since: 0, change: 1 });
  eq('a late scene event of a stopped capture is ignored', scenes.length, 2);
  capture.dispose();
}

// 1b. The hotkeys (real code, a fake globalShortcut).
{
  const held = new Map<string, () => void>();
  const gs = fakeElectron.globalShortcut as unknown as { register(a: string, f: () => void): boolean; unregister(a: string): void };
  gs.register = (a: string, f: () => void) => {
    if (a.includes('Bogus')) throw new Error('not an accelerator');
    if (a === 'Ctrl+Alt+X' || held.has(a)) return false; // another program has it
    held.set(a, f);
    return true;
  };
  gs.unregister = (a: string) => { held.delete(a); };
  delete modules[req.resolve('./electron/pet/hotkeys.cjs')];
  const hk = req('./electron/pet/hotkeys.cjs') as {
    apply(k: { ask: string; pause: string }, f: { onAsk(): void; onPause(): void }): { ok: boolean; errors: string[]; ask: boolean; pause: boolean }; clear(): void;
  };
  let asks = 0;
  const fns = { onAsk: () => { asks++; }, onPause() {} };
  const r1 = hk.apply({ ask: 'Ctrl+Alt+F', pause: 'Ctrl+Alt+P' }, fns);
  eq('both hotkeys register', [r1.ok, r1.ask, r1.pause, [...held.keys()]], [true, true, true, ['Ctrl+Alt+F', 'Ctrl+Alt+P']]);
  for (let i = 0; i < 3; i++) held.get('Ctrl+Alt+F')!(); // held down: Windows repeats it
  eq('a key held down (its repeats) is one press, not a toggle back and forth', asks, 1);
  await wait(850);
  held.get('Ctrl+Alt+F')!();
  eq('…a new press later counts again', asks, 2);
  const r2 = hk.apply({ ask: 'Ctrl+Alt+X', pause: 'Ctrl+Alt+P' }, fns);
  eq('a combination another program has: said so, and the one it was to replace goes on working',
    [r2.ok, r2.ask, r2.pause, held.has('Ctrl+Alt+F'), held.has('Ctrl+Alt+X'), r2.errors.length, r2.errors[0]?.includes('Ctrl+Alt+F')], [false, false, true, true, false, 1, true]);
  const r3 = hk.apply({ ask: 'Ctrl+Alt+P', pause: 'Ctrl+Alt+F' }, fns);
  eq('swapping the two works', [r3.ok, r3.ask, r3.pause, held.size], [true, true, true, 2]);
  const r4 = hk.apply({ ask: 'Ctrl+Alt+Q', pause: 'Ctrl+Alt+Q' }, fns);
  eq('the same keys for both: the second is refused and keeps its old combination', [r4.ask, r4.pause, r4.errors.length, held.has('Ctrl+Alt+Q'), held.has('Ctrl+Alt+F')], [true, false, 1, true, true]);
  const r5 = hk.apply({ ask: 'Bogus+F', pause: '' }, fns);
  eq('one Electron cannot read is called malformed; an empty one is simply not set', [r5.ask, r5.pause, r5.errors.length, r5.errors[0]?.includes('格式不对')], [false, false, 1, true]);
  hk.clear();
  eq('clearing lets go of all of them', held.size, 0);
  gs.register = () => true;
  gs.unregister = () => {};
}

// 1c. The voice services' keys (real code, Electron's storage faked).
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-tts-keys-'));
  const fe = fakeElectron as unknown as Record<string, unknown>;
  const getPath = fakeElectron.app.getPath;
  fakeElectron.app.getPath = () => dir;
  fe.safeStorage = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString().slice(4) };
  const tk = tts as unknown as { saveKey(p: string, k: string): { ok: boolean; error?: string }; clearKey(p: string): { ok: boolean; error?: string }; getKey(p: string): string | null };
  eq('a key copied with a zero-width character in it is saved without it', [tk.saveKey('elevenlabs', 'sk_abcd1234​').ok, tk.getKey('elevenlabs')], [true, 'sk_abcd1234']);
  const bad = tk.saveKey('minimax', 'sk_abcd１２３４');
  eq('one with full-width or Chinese characters is refused, saying why, and nothing is stored', [bad.ok, bad.error, tk.getKey('minimax')], [false, '密钥里有看不见的字符或中文、全角符号，请重新复制', null]);
  // The key file cannot be written (here: a folder sits where its temporary copy goes).
  fs.mkdirSync(path.join(dir, 'tts-keys.json.tmp'));
  const stuck = tk.clearKey('elevenlabs');
  eq('deleting a key that cannot be written away says so, and the key is still there', [stuck.ok, !!stuck.error?.startsWith('没能删除密钥'), tk.getKey('elevenlabs')], [false, true, 'sk_abcd1234']);
  fs.rmdirSync(path.join(dir, 'tts-keys.json.tmp'));
  eq('…once it can be, it is gone', [tk.clearKey('elevenlabs').ok, tk.getKey('elevenlabs')], [true, null]);
  fakeElectron.app.getPath = getPath;
  delete fe.safeStorage;
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. The main-process hub, with the other modules faked.
const liveLog: string[] = [];
let liveHold = false;
let liveRelease: (() => void) | undefined;
{
  const calls: string[] = [];
  const log = (s: string) => { calls.push(s); };
  const petWc = { mainFrame: { url: pathToFileURL(path.join(root, 'dist', 'pet.html')).href, parent: null } };
  // What the pet window sends: her webContents, from the top frame of her own page.
  const fromPetWin = { sender: petWc, senderFrame: petWc.mainFrame };
  let pageReset: ((why: string) => void) | undefined;
  type ChatMsg = { op: string; entry?: PetChatEntry; entries?: PetChatEntry[]; id?: string };
  const win = { lines: [] as unknown[], audio: [] as unknown[], states: [] as unknown[], cmds: [] as unknown[], restore: '', chat: [] as ChatMsg[], chatOpen: false, chatKeys: false };
  fake('./electron/pet/window.cjs', {
    onReset: (fn: (why: string) => void) => { pageReset = fn; return () => {}; },
    create: () => log('create'), get: () => ({ webContents: petWc, destroy() {} }), show: () => log('show'), hide: () => log('hide'), isVisible: () => true,
    sendState: (s: unknown) => win.states.push(s), sendLine: (l: unknown) => win.lines.push(l), sendLineDelta() {}, sendAudio: (a: unknown) => win.audio.push(a),
    sendMood() {}, destroy() {}, setInteractive: (v: boolean) => log(`interactive:${v}`), drag: (p: string) => log(`drag:${p}`),
    sendCommand: (c: { type: string }) => {
      win.cmds.push(c);
      if (c.type === 'chat') { win.chatOpen = true; win.chatKeys = true; } else if (c.type === 'close-chat') { win.chatOpen = false; win.chatKeys = false; }
    },
    applyScale: (s: number) => log(`scale:${s}`), hwnd: () => '777', whenReady: async () => {}, setRestoreTarget: (h: string) => { win.restore = h; },
    sendChat: (m: ChatMsg) => win.chat.push(m), chatState: () => ({ open: win.chatOpen, focused: win.chatOpen && win.chatKeys }),
    focusChat: () => { log('chat-focus'); win.chatKeys = true; }, park: () => log('park'), shutdown: () => log('window-shutdown'),
  });
  const lastCmd = () => JSON.stringify(win.cmds[win.cmds.length - 1]);
  const lastPut = () => win.chat.filter((m) => m.op === 'put').pop()?.entry;
  const synced = () => { ipcOn.get('pet-ui:chat-sync')!(fromPetWin); return win.chat[win.chat.length - 1].entries ?? []; };
  let hot: { keys: { ask: string; pause: string }; onAsk(): void; onPause(): void } | undefined;
  fake('./electron/pet/hotkeys.cjs', {
    apply: (keys: { ask: string; pause: string }, cb: { onAsk(): void; onPause(): void }) => { hot = { keys, ...cb }; return { ok: true, errors: [], ask: true, pause: true }; },
    clear: () => { hot = undefined; log('hotkeys-clear'); },
  });
  let onFocus: ((raw: object) => void) | undefined;
  let onLost: (() => void) | undefined;
  let sensing = false;
  fake('./electron/pet/sense.cjs', {
    start: (cb: { onFocus: (raw: object) => void; onLost: () => void }) => { sensing = true; onFocus = cb.onFocus; onLost = cb.onLost; },
    stop: () => { sensing = false; log('sense-stop'); }, running: () => sensing, ocrPng: async () => ['任务：前往群星图书馆', '流萤：我会一直陪着你。'],
  });
  const cap = { live: false, hwnd: null as string | null, scene: undefined as undefined | ((e: object) => void), liveCb: undefined as undefined | ((v: boolean) => void) };
  fake('./electron/pet/capture.cjs', {
    init() {}, dispose: () => log('capture-dispose'),
    start: async (h: string) => { log(`capture-start:${h}`); cap.live = true; cap.hwnd = h; cap.liveCb?.(true); return true; },
    stop: () => { log('capture-stop'); cap.live = false; cap.hwnd = null; return true; },
    frame: async () => ({ mime: 'image/jpeg', data: '/9j/4AAQ', width: 1280, height: 720, at: 1 }), png: async () => Buffer.from([1, 2, 3]),
    onScene: (fn: (e: object) => void) => { cap.scene = fn; return () => {}; }, onLive: (fn: (v: boolean) => void) => { cap.liveCb = fn; return () => {}; },
    status: () => ({ active: cap.hwnd !== null, live: cap.live, hwnd: cap.hwnd, black: false }),
  });
  fake('./electron/pet/tts.cjs', {
    synth: async (text: string, voice: object, o: { onChunk(b: Buffer, m: string): void }) => { o.onChunk(Buffer.from([1, 2, 3]), 'audio/mpeg'); log(`synth:${text}`); return { provider: (voice as { provider: string }).provider }; },
    voices: async (p: string) => [{ id: `${p}-1`, name: 'one' }], test: async (_v: object, o: { onChunk(b: Buffer, m: string): void }) => { o.onChunk(Buffer.from([9]), 'audio/mpeg'); return { ok: true }; },
    saveKey: (p: string, k: string) => ({ ok: true, hint: `••••${k.slice(-4)}`, p }), clearKey: () => ({ ok: true }), hints: () => ({ minimax: '••••abcd' }),
    getKey: (p: string) => (p === 'elevenlabs' ? 'sk-el' : null),
    live: async (text: string, _v: object, o: { onPcm(b: Buffer): void; signal: AbortSignal; fast: boolean }) => {
      liveLog.push(`live:${text}:${o.fast}`);
      o.onPcm(Buffer.from([1, 2, 3, 4]));
      if (liveHold) await new Promise<void>((resolve) => { liveRelease = resolve; o.signal.addEventListener('abort', () => resolve(), { once: true }); });
      return { provider: 'elevenlabs', mime: 'audio/pcm;rate=24000' };
    },
    _internals: { PCM_MIME: 'audio/pcm;rate=24000' },
  });
  const rtLog: string[] = [];
  let rtHooks: { key(): string | null; state(st: string, m?: string): void; speechStart(): void; partial(t: string): void; final(t: string): void; none(): void } | undefined;
  let rtActive = false;
  fake('./electron/pet/realtime.cjs', {
    start: async (o: object, h: typeof rtHooks) => { rtLog.push(`start:${JSON.stringify(o)}`); rtHooks = h; rtActive = true; h!.state('live'); return { ok: true }; },
    update: (o: object) => rtLog.push(`update:${JSON.stringify(o)}`), listenOnce: () => { rtLog.push('listen'); return true; },
    setBusy: (on: boolean) => rtLog.push(`busy:${on}`), pushMic() {},
    stop: (m?: string, failed?: boolean) => { rtLog.push('stop'); if (rtActive) { rtActive = false; rtHooks?.state(failed ? 'error' : 'closed', m); } }, active: () => rtActive,
  });
  // The real policy and the real hub.
  delete modules[req.resolve('./electron/pet/index.cjs')];
  const hub = req('./electron/pet/index.cjs') as {
    beforeReady(): void; register(h: object): void; stopAll(): void; _internals: { sanitizeConfig(c: unknown): { scale: number; neverWatch: string[]; voice: { provider: string; volume: number; models: { elevenlabs: string; minimax: string } }; mode: string; enabled: boolean }; sanitizeLine(l: unknown): object | null };
  };
  const toPage: Array<[string, unknown]> = [];
  const commands: Array<[object, boolean | undefined]> = [];
  const mainWc = { isDestroyed: () => false, send: (c: string, p: unknown) => { toPage.push([c, p]); } };
  const appUrl = pathToFileURL(path.join(root, 'dist', 'index.html')).href;
  // The shell decides who the main page is (main.cjs isAppSender): here, this one frame object.
  const appFrame = { url: appUrl };
  const fromApp = { sender: mainWc, senderFrame: appFrame };
  const fromEvil = { sender: mainWc, senderFrame: { url: appUrl } };
  const events = () => toPage.filter(([c]) => c === 'pet:event').map(([, p]) => p as { type: string; [k: string]: unknown });

  hub.beforeReady();
  eq('a switch is set before the app is ready', switches.map((s) => s[0]), ['disable-features']);
  hub.register({ getMainWindow: () => ({ isDestroyed: () => false, webContents: mainWc }), showMainWindow: () => log('show-main'), sendCommandToPage: (c: object, s?: boolean) => commands.push([c, s]),
    isAppSender: (e: { senderFrame?: object }) => !!e && e.senderFrame === appFrame });

  const clean = hub._internals.sanitizeConfig({ enabled: 1, mode: 'x', scale: 9, neverWatch: ['  A.exe', 4], voice: { provider: 'siri', volume: 900, models: { elevenlabs: ' eleven_v4 ', minimax: 'speech 2.8; rm' } } });
  eq('speech models from the page are checked like everything else', clean.voice.models, { elevenlabs: 'eleven_v4', minimax: '' });
  eq('whatever the page sends is checked field by field', [clean.enabled, clean.mode, clean.scale, clean.neverWatch, clean.voice.provider, clean.voice.volume], [false, 'firefly', 1.6, ['a.exe'], 'edge', 100]);
  eq('a line needs an id and text', [hub._internals.sanitizeLine({ id: 'a' }), hub._internals.sanitizeLine('x')], [null, null]);
  eq('and drops what it does not know', hub._internals.sanitizeLine({ id: 'a', text: 'hi', mood: 'angry', speak: 'yes', extra: 1 }), { id: 'a', text: 'hi' });

  const cfg = { enabled: true, mode: 'firefly', scale: 1.2, watch: true, neverWatch: [], gameAllow: [], gameDeny: [], hotkeyAsk: 'Ctrl+Alt+F', hotkeyPause: 'Ctrl+Alt+P', voice: { enabled: true, provider: 'edge', voiceId: '', volume: 70, fallback: true } };
  ipcOn.get('pet:config')!(fromEvil, cfg);
  eq('a call from any other page is ignored', calls.filter((c) => c === 'show').length, 0);
  let denied = '';
  try { await ipcHandle.get('pet:frame')!(fromEvil, {}); } catch (e) { denied = (e as Error).message; }
  expect('and a request from another page is refused', denied.startsWith('拒绝'), denied);
  ipcOn.get('pet:config')!(fromApp, cfg);
  eq('switching on sets her size, but she waits to hear what is in front (an anti-cheat game?) before showing', [calls.includes('show'), calls.includes('scale:1.2')], [false, true]);
  eq('registers her hotkeys', hot?.keys, { ask: 'Ctrl+Alt+F', pause: 'Ctrl+Alt+P' });
  eq('…and tells the page which ones work', events().filter((e) => e.type === 'hotkeys').pop() as unknown, { type: 'hotkeys', ask: true, pause: true, errors: [] });
  eq('and starts sensing', sensing, true);
  eq('the pet window is told how things stand', win.states[win.states.length - 1], { mode: 'firefly', scale: 1.2, watching: false, paused: false, realtime: false, listening: false, voice: true });

  // The program in front.
  onFocus!({ exe: 'chrome.exe', title: 'x', pid: 5, hwnd: '1000', fullscreen: 'no', rect: {} });
  eq('the first report of the program in front (no anti-cheat game) shows her at once', calls.filter((c) => c === 'show').length, 1);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  eq('a game that has just come to the front is not watched yet (the focus must hold still)', calls.some((c) => c.startsWith('capture-start')), false);
  await wait(1750);
  const focusEvents = events().filter((e) => e.type === 'focus');
  eq('after 1.5 s the page hears about it: only the last program, classified', [focusEvents.length, (focusEvents[0]?.app as { policy: string; game: string })?.policy, (focusEvents[0]?.app as { game: string })?.game], [1, 'watch', '崩坏：星穹铁道']);
  eq('and the game window starts being captured', calls.filter((c) => c.startsWith('capture-start')), ['capture-start:4242']);
  eq('the pet shows the eye', (win.states[win.states.length - 1] as { watching: boolean }).watching, true);

  // Her own window must not count as "the program in front".
  onFocus!({ exe: 'fireflyharness.exe', title: '萤火桌宠', pid: process.pid, hwnd: '777', fullscreen: 'no', rect: {} });
  await wait(1750);
  eq('the pet window holding the keyboard (ask box) does not stop the watch', [calls.includes('capture-stop'), events().filter((e) => e.type === 'focus').length], [false, 1]);
  // But another program does: at once.
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  eq('looking stops the instant another window takes the front', calls.includes('capture-stop'), true);
  await wait(1750);
  eq('and the page is told the program changed', events().filter((e) => e.type === 'focus').length, 2);
  eq('no picture can be had of a program that is not a game', await ipcHandle.get('pet:frame')!(fromApp, { maxSide: 1280 }), null);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  const frame = await ipcHandle.get('pet:frame')!(fromApp, { maxSide: 1280 }) as { mime: string } | null;
  eq('back in the game she can have a picture', frame?.mime, 'image/jpeg');
  const ocr = await ipcHandle.get('pet:ocr')!(fromApp) as { lines: string[] } | null;
  eq('and the text on it', ocr?.lines.length, 2);

  // A title that keeps changing (a clock, a song's name) must not hold the change back for ever.
  const nF = events().filter((e) => e.type === 'focus').length;
  for (let i = 0; i < 4; i++) { onFocus!({ exe: 'music.exe', title: `歌 ${i}`, pid: 12, hwnd: '600', fullscreen: 'no', rect: {} }); await wait(400); }
  const moved = events().filter((e) => e.type === 'focus').slice(nF).map((e) => e.app as { exe: string; title: string });
  eq('a window whose title changes every 0.4 s still becomes the program in front after 1.5 s (with its newest title)', [moved.length, moved[0]?.exe, moved[0]?.title], [1, 'music.exe', '歌 3']);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  // While another window settles in front, pausing and resuming must not start looking at the game she left.
  const starts = calls.filter((c) => c.startsWith('capture-start')).length;
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  hot!.onPause();
  hot!.onPause();
  await wait(30);
  eq('pausing and resuming while another window settles in front does not look at the game she left', calls.filter((c) => c.startsWith('capture-start')).length, starts);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);

  // The sense helper dies or goes quiet: what it last reported is stale, so she stops looking.
  const nFocus = events().filter((e) => e.type === 'focus').length;
  const stops1 = calls.filter((c) => c === 'capture-stop').length;
  onLost!();
  const lostApp = (events().filter((e) => e.type === 'focus').pop() as unknown as { app: { exe: string; hwnd: string; policy: string; isGame: boolean } }).app;
  eq('when sense is lost she forgets the program, stops looking and tells the page', [events().filter((e) => e.type === 'focus').length, lostApp.exe, lostApp.hwnd, lostApp.policy, lostApp.isGame, calls.filter((c) => c === 'capture-stop').length > stops1], [nFocus + 1, '', '0', 'never', false, true]);
  eq('and has no picture or text to give', [await ipcHandle.get('pet:frame')!(fromApp, {}), await ipcHandle.get('pet:ocr')!(fromApp)], [null, null]);
  onLost!();
  eq('the page is told once per outage', events().filter((e) => e.type === 'focus').length, nFocus + 1);
  onFocus!({ exe: 'starrail.exe', title: '崩坏：星穹铁道', pid: 6, hwnd: '4242', fullscreen: 'borderless', rect: {} });
  await wait(1750);
  eq('a fresh report from the helper brings her back', (await ipcHandle.get('pet:frame')!(fromApp, { maxSide: 1280 })) !== null, true);

  // Scene events and the text that appears in calm moments.
  cap.scene!({ state: 'settled', since: 123, change: 0.01 });
  eq('scene events go to the page', events().some((e) => e.type === 'scene' && e.state === 'settled' && e.since === 123), true);
  await wait(30);
  const text = events().find((e) => e.type === 'text');
  eq('a calm picture gets its text read, once', [(text?.lines as string[] | undefined)?.length, events().filter((e) => e.type === 'text').length], [2, 1]);
  cap.scene!({ state: 'static', since: 1, change: 0 });
  await wait(30);
  eq('and not again for 30 s', events().filter((e) => e.type === 'text').length, 1);

  // Pausing.
  hot!.onPause();
  eq('the pause hotkey stops the capture and tells the page', [calls.filter((c) => c === 'capture-stop').length >= 2, events().some((e) => e.type === 'pause' && e.paused === true), await ipcHandle.get('pet:frame')!(fromApp, {})], [true, true, null]);
  hot!.onPause();
  await wait(30);
  eq('pressing it again resumes', [events().some((e) => e.type === 'pause' && e.paused === false), (await ipcHandle.get('pet:frame')!(fromApp, {})) !== null], [true, true]);

  // Saying things.
  eq('a bad line is refused', await ipcHandle.get('pet:say')!(fromApp, { nope: 1 }), { ok: false });
  const said = await ipcHandle.get('pet:say')!(fromApp, { id: 'l1', text: '你好呀', mood: 'talk', speak: true });
  await wait(20);
  eq('a spoken line shows the bubble and sends the voice', [said, (win.lines[0] as { text: string }).text, calls.includes('synth:你好呀'), (win.audio[0] as { seq: number; volume: number; mime: string }).volume, (win.audio[win.audio.length - 1] as { end?: boolean }).end], [{ ok: true }, '你好呀', true, 70, true]);
  const audio0 = win.audio[0] as { lineId: string; chunk: Uint8Array };
  eq('the audio arrives as bytes for that line', [audio0.lineId, audio0.chunk instanceof Uint8Array], ['l1', true]);
  const before = win.audio.length;
  await ipcHandle.get('pet:say')!(fromApp, { id: 'l2', text: '还在写…', mood: 'think', speak: true, streaming: true });
  await wait(20);
  eq('a line that is still being written is shown but not read', [win.lines.length, win.audio.length], [2, before]);

  // The pet window's own messages.
  ipcOn.get('pet-ui:ask')!({ sender: {} }, { text: 'x' });
  eq('a message from anything but the pet window is ignored', events().filter((e) => e.type === 'ask').length, 0);
  const cmdsBeforeAsk = win.cmds.length;
  ipcOn.get('pet-ui:ask')!(fromPetWin, { text: '  这个怎么打？  ' });
  eq('a message from the chat panel reaches the brain, goes into the log, and closes nothing', [events().find((e) => e.type === 'ask')?.text, lastPut()?.who, lastPut()?.text, win.cmds.length], ['这个怎么打？', 'me', '这个怎么打？', cmdsBeforeAsk]);
  const putsBefore = win.chat.length;
  ipcOn.get('pet-ui:ask')!(fromPetWin, { text: '   ' });
  eq('an empty message is ignored', [events().filter((e) => e.type === 'ask').length, win.chat.length], [1, putsBefore]);
  ipcOn.get('pet-ui:click')!({ sender: petWc, senderFrame: { url: 'file:///evil.html', parent: null } });
  ipcOn.get('pet-ui:click')!({ sender: petWc, senderFrame: { url: fromPetWin.senderFrame.url, parent: petWc.mainFrame } });
  ipcOn.get('pet-ui:click')!({ sender: {}, senderFrame: petWc.mainFrame });
  eq('her window is not enough: only her own page, in its top frame, is believed', events().filter((e) => e.type === 'click').length, 0);
  ipcOn.get('pet-ui:click')!(fromPetWin);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'l1', state: 'end' });
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'l1', state: 'bogus' });
  eq('clicks and playback state are passed on', [events().filter((e) => e.type === 'click').length, events().filter((e) => e.type === 'spoken').length], [1, 1]);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'l9', state: 'start' });
  pageReset!('gone');
  pageReset!('hide');
  eq('when her page is lost, a line it began reading is reported as ended (once), so the brain is not left waiting', events().filter((e) => e.type === 'spoken' && e.lineId === 'l9').map((e) => e.state), ['start', 'end']);
  ipcOn.get('pet-ui:hit')!(fromPetWin, true);
  ipcOn.get('pet-ui:drag')!(fromPetWin, { phase: 'start', x: NaN, y: NaN });
  ipcOn.get('pet-ui:drag')!(fromPetWin, { phase: 'fly', x: 1, y: 1 });
  eq('hit-testing and dragging go to the window (a made-up phase does not)', [calls.includes('interactive:true'), calls.filter((c) => c.startsWith('drag:'))], [true, ['drag:start']]);
  // The chat panel's log: her lines, as they reach the window.
  eq('her lines go into the log too; one still being written is marked so', synced().map((e) => [e.id, e.who, e.text, !!e.streaming]), [['l1', 'her', '你好呀', false], ['l2', 'her', '还在写…', true], [lastPut()!.id, 'me', '这个怎么打？', false]]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a1', text: '嗯……让我想想', mood: 'think', streaming: true });
  eq('a new reply starting drops the older one that never got past thinking', [win.chat[win.chat.length - 2], synced().map((e) => e.id).slice(0, 1)], [{ op: 'drop', id: 'l2' }, ['l1']]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a1', text: '先去', mood: 'talk', streaming: true });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a1', text: '先去左边。', more: '先去左边。\n再往前走。', mood: 'talk', speak: true });
  const a1 = synced().filter((e) => e.id === 'a1');
  eq('her reply grows in the same message and ends with the whole answer', [a1.length, a1[0].text, a1[0].more, !!a1[0].streaming, synced().map((e) => e.id).pop()], [1, '先去左边。', '先去左边。\n再往前走。', false, 'a1']);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a2', text: '嗯，那', mood: 'talk', streaming: true });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a3', text: '让我想想', mood: 'think', streaming: true });
  eq('…an older reply that had words in it stays, as far as it got', synced().filter((e) => e.id === 'a2').map((e) => [e.text, !!e.streaming]), [['嗯，那', false]]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'a3', text: '好。', mood: 'talk' });
  // A reply that stops without a last line (the user cut in, a newer line took over): it does not stay "typing" for good.
  const streamingIds = () => synced().filter((e) => e.streaming).map((e) => e.id);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'b1', text: '我觉得', mood: 'talk', streaming: true });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'b2', text: '哇，好厉害！', mood: 'happy' });
  eq('any other line ends an older reply still being written: it stays as far as it got, not "typing"',
    [streamingIds(), synced().filter((e) => e.id === 'b1').map((e) => e.text)], [[], ['我觉得']]);
  await ipcHandle.get('pet:say')!(fromApp, { id: 'b3', text: '让我想想', mood: 'think', streaming: true });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'b4', text: '嗯？', mood: 'happy' });
  eq('…and one that never got past "let me think" goes', [streamingIds(), synced().some((e) => e.id === 'b3')], [[], false]);

  // Opening the chat panel: the hotkey, the menu, a double-click / the chat button (the page asks), and closing it.
  hot!.onAsk();
  eq('the ask hotkey opens the chat panel and remembers the game to hand the keyboard back to', [lastCmd(), win.restore], [JSON.stringify({ type: 'chat' }), '4242']);
  const nLines = win.lines.length;
  await ipcHandle.get('pet:say')!(fromApp, { id: 'o1', text: '在呢。', mood: 'happy' });
  eq('her lines reach the window while the panel is open (bubble data and log)', [win.lines.length, (win.lines[nLines] as { id: string }).id, lastPut()?.id], [nLines + 1, 'o1', 'o1']);
  ipcOn.get('pet-ui:ask')!(fromPetWin, { text: '再说一遍' });
  eq('sending keeps the panel open', [win.chatOpen, lastCmd()], [true, JSON.stringify({ type: 'chat' })]);
  hot!.onAsk();
  eq('the hotkey again, while the panel has the keyboard, closes it', [lastCmd(), win.chatOpen], [JSON.stringify({ type: 'close-chat' }), false]);
  ipcOn.get('pet-ui:chat-open')!({ sender: {} });
  eq('only her own page may open it', lastCmd(), JSON.stringify({ type: 'close-chat' }));
  ipcOn.get('pet-ui:chat-open')!(fromPetWin);
  eq('a double-click on her (or the chat button) opens it', [lastCmd(), win.chatOpen], [JSON.stringify({ type: 'chat' }), true]);
  win.chatKeys = false; // the user clicked into another window
  win.restore = '';
  ipcOn.get('pet-ui:chat-focus')!(fromPetWin);
  eq('a click back into the open panel takes the keyboard again (and remembers whom to give it back to)', [calls.filter((c) => c === 'chat-focus').length, win.restore], [1, '4242']);
  ipcOn.get('pet-ui:chat-focus')!(fromPetWin);
  eq('…but not when it already has it', calls.filter((c) => c === 'chat-focus').length, 1);
  ipcOn.get('pet-ui:chat-close')!(fromPetWin);
  eq('Esc or × in the panel closes it', [lastCmd(), win.chatOpen], [JSON.stringify({ type: 'close-chat' }), false]);

  // The menu.
  ipcOn.get('pet-ui:menu')!(fromPetWin);
  menuItems.find((m) => m.label === '和她聊天')!.click!();
  eq('the menu has 「和她聊天」, which opens the panel', [lastCmd(), win.chatOpen], [JSON.stringify({ type: 'chat' }), true]);
  ipcOn.get('pet-ui:menu')!(fromPetWin);
  menuItems.find((m) => m.label === '收起聊天框')!.click!();
  eq('…and while it is open, an item to close it', win.chatOpen, false);
  ipcOn.get('pet-ui:menu')!(fromPetWin);
  const labels = menuItems.map((m) => m.label).filter(Boolean) as string[];
  expect('the menu offers "don\'t look at this game", pause, 实时陪玩, settings', labels.some((l) => l.includes('不看')) && labels.includes('暂停观看') && labels.some((l) => l.includes('实时陪玩')) && labels.includes('隐藏桌宠'), labels.join(' / '));
  menuItems.find((m) => m.label?.includes('不看'))!.click!();
  menuItems.find((m) => m.label === '桌宠设置…')!.click!();
  eq('menu choices go to the page as commands', commands.map(([c, s]) => [(c as { type: string }).type, s]), [['pet-watch', false], ['pet-settings', true]]);
  eq('the program is named in the command', (commands[0][0] as { exe: string; allow: boolean }).exe + ':' + (commands[0][0] as { allow: boolean }).allow, 'starrail.exe:false');

  // Voice and 实时陪玩.
  eq('the voices come through', await ipcHandle.get('pet:tts:voices')!(fromApp, 'minimax'), [{ id: 'minimax-1', name: 'one' }]);
  eq('keys are saved by the voice module, and only hints come back', [await ipcHandle.get('pet:tts:key')!(fromApp, 'elevenlabs', 'sk-1234567890abcd'), await ipcHandle.get('pet:tts:keys')!(fromApp)], [{ ok: true, hint: '••••abcd', p: 'elevenlabs' }, { minimax: '••••abcd' }]);
  eq('a voice test plays in the pet window (which goes back to sleep if she is switched off)', [await ipcHandle.get('pet:tts:test')!(fromApp, { provider: 'edge', voiceId: '', text: '试听' }), win.audio.some((a) => (a as { lineId?: string }).lineId?.startsWith('test-')), calls.includes('park')], [{ ok: true }, true, true]);
  eq('an unknown service is refused', (await ipcHandle.get('pet:tts:test')!(fromApp, { provider: 'siri' }) as { ok: boolean }).ok, false);
  // 实时陪玩: start, read a reply aloud, cut her off, listen by hotkey.
  const rt = (cmd: object) => ipcHandle.get('pet:rt')!(fromApp, cmd);
  eq('实时陪玩 starts with checked options', [await rt({ op: 'start', listen: 'loud', sensitivity: 900, fastVoice: true, autoOffMin: 1 }), rtLog.find((x) => x.startsWith('start:'))], [{ ok: true }, 'start:{"listen":"auto","sensitivity":100,"fastVoice":true,"autoOffMin":5}']);
  eq('the pet window shows it is on', (win.states[win.states.length - 1] as { realtime: boolean }).realtime, true);
  eq('a sentence of her reply is read as PCM, live, in her voice settings', [await rt({ op: 'say', id: 'L1', text: '嗯，开拓者先去左边的门。' }), liveLog[0], (win.audio[win.audio.length - 1] as { lineId: string; mime: string; live: boolean })],
    [{ ok: true }, 'live:嗯，开拓者先去左边的门。:true', { lineId: 'L1', seq: 0, chunk: new Uint8Array([1, 2, 3, 4]), mime: 'audio/pcm;rate=24000', volume: 70, live: true }]);
  eq('bad commands are refused', [await rt({ op: 'say', id: '', text: 'x' }), await rt({ op: 'dance' })], [{ ok: false, error: '命令无效' }, { ok: false, error: '命令无效' }]);
  liveHold = true;
  void rt({ op: 'say', id: 'L2', text: '那里有一个宝箱，记得打开哦。' });
  await ipcHandle.get('pet:say')!(fromApp, { id: 'L2', text: '那里有一个宝箱，', mood: 'talk', streaming: true });
  await wait(5);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'L2', state: 'start' });
  const evN = events().length;
  const cmdN = win.cmds.length;
  rtHooks!.speechStart();
  eq('while she talks, a sound on the microphone does not cut her off by itself', [events().slice(evN).filter((e) => e.type === 'hear').length, win.cmds.length], [0, cmdN]);
  rtHooks!.partial('宝箱记得打开');
  eq('…nor her own words coming back through the speakers', win.cmds.length, cmdN);
  rtHooks!.partial('等一下我问你');
  eq('the user\'s own words cut her off at once', [win.cmds.slice(cmdN), events().slice(evN).filter((e) => e.type === 'hear').map((e) => e.state)], [[{ type: 'hush' }], ['start']]);
  eq('…and the reply she was cut off from stops "typing" in the log', synced().filter((e) => e.id === 'L2').map((e) => [e.text, !!e.streaming]), [['那里有一个宝箱，', false]]);
  rtHooks!.final('等一下我问你个事');
  eq('…and what they said goes to the brain', events().filter((e) => e.type === 'hear').pop() as unknown, { type: 'hear', state: 'final', text: '等一下我问你个事' });
  eq('…and into the chat log, marked as spoken', [lastPut()?.who, lastPut()?.text, lastPut()?.voice], ['me', '等一下我问你个事', true]);
  const nL = liveLog.length;
  eq('a late sentence of the reply she was cut off from is not read', [await rt({ op: 'say', id: 'L2', text: '还有一个宝箱。' }), liveLog.length], [{ ok: false }, nL]);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'L2', state: 'end' });
  liveHold = false;
  liveRelease?.();
  rtHooks!.speechStart();
  rtHooks!.final('那里有一个宝箱记得打开哦');
  eq('her own sentence heard back is not a question', (events().filter((e) => e.type === 'hear').pop() as unknown as { state: string }).state, 'none');
  await wait(3200);
  rtHooks!.speechStart();
  rtHooks!.final('那里有一个宝箱');
  eq('…but the user saying the same words later is the user', (events().filter((e) => e.type === 'hear').pop() as unknown as { state: string }).state, 'final');
  liveHold = true;
  void rt({ op: 'say', id: 'L3', text: '我觉得可以先去左边看看。' });
  await wait(5);
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'L3', state: 'start' });
  const c3 = win.cmds.length;
  rtHooks!.speechStart();
  rtHooks!.partial('我觉');
  rtHooks!.partial('好');
  eq('a word or two is not enough to cut her off', win.cmds.length, c3);
  rtHooks!.final('好');
  ipcOn.get('pet-ui:spoken')!(fromPetWin, { lineId: 'L3', state: 'end' });
  liveHold = false;
  liveRelease?.();
  await wait(5);
  ipcOn.get('pet:config')!(fromApp, { ...cfg, voice: { ...cfg.voice, enabled: false } });
  const nV = liveLog.length;
  eq('with her voice off a live reply is only shown', [await rt({ op: 'say', id: 'L4', text: '好的。' }), liveLog.length], [{ ok: true }, nV]);
  rtHooks!.speechStart();
  eq('…and the user is heard at once (nothing of hers is playing)', (events().filter((e) => e.type === 'hear').pop() as unknown as { state: string }).state, 'start');
  rtHooks!.none();
  ipcOn.get('pet:config')!(fromApp, cfg);
  await rt({ op: 'start', listen: 'key', sensitivity: 40, fastVoice: false, autoOffMin: 30 });
  eq('changing options while it runs updates the session', rtLog.filter((x) => x.startsWith('update:')).pop(), 'update:{"listen":"key","sensitivity":40,"fastVoice":false,"autoOffMin":30}');
  const askN = win.cmds.filter((c) => (c as { type: string }).type === 'chat').length;
  const logN = rtLog.length;
  hot!.onAsk();
  eq('in the hotkey mode the 呼出 key means "listen to me"', [rtLog.slice(logN).includes('listen'), win.cmds.filter((c) => (c as { type: string }).type === 'chat').length, (win.states[win.states.length - 1] as { listening: boolean }).listening], [true, askN, true]);
  rtHooks!.none();
  eq('…and the ear goes away when nothing was said', (win.states[win.states.length - 1] as { listening: boolean }).listening, false);
  await rt({ op: 'stop' });
  eq('stopping ends the session and the LIVE mark', [rtLog.includes('stop'), (win.states[win.states.length - 1] as { realtime: boolean }).realtime], [true, false]);
  // The page cannot open the microphone (or loses it): she would be deaf with LIVE showing.
  await rt({ op: 'start', listen: 'auto', sensitivity: 50, fastVoice: true, autoOffMin: 20 });
  ipcOn.get('pet-ui:mic-failed')!({ sender: {} });
  eq('only her own page can say the microphone failed', (win.states[win.states.length - 1] as { realtime: boolean }).realtime, true);
  ipcOn.get('pet-ui:mic-failed')!(fromPetWin);
  const micErr = events().filter((e) => e.type === 'rt').pop() as unknown as { state: string; message?: string };
  eq('a microphone that will not open ends 实时陪玩, with the reason', [micErr.state, !!micErr.message?.includes('麦克风'), (win.states[win.states.length - 1] as { realtime: boolean }).realtime], ['error', true, false]);

  // Changing the lists re-classifies the program in front.
  const n0 = events().filter((e) => e.type === 'focus').length;
  ipcOn.get('pet:config')!(fromApp, { ...cfg, gameDeny: ['starrail.exe'] });
  await wait(20);
  const lastFocus = events().filter((e) => e.type === 'focus').pop() as unknown as { app: { policy: string } };
  eq('moving a game to "don\'t watch" takes effect at once: no more capture', [events().filter((e) => e.type === 'focus').length, lastFocus.app.policy, cap.live], [n0 + 1, 'chat-only', false]);

  // An anti-cheat game in front: her window (a transparent always-on-top overlay) goes at once and she says nothing over it.
  const hides0 = calls.filter((c) => c === 'hide').length;
  const shows0 = calls.filter((c) => c === 'show').length;
  await ipcHandle.get('pet:say')!(fromApp, { id: 'ac0', text: '这一关的', mood: 'talk', streaming: true });
  await rt({ op: 'start', listen: 'auto', sensitivity: 50, fastVoice: true, autoOffMin: 20 });
  onFocus!({ exe: 'valorant.exe', title: 'VALORANT', pid: 11, hwnd: '900', fullscreen: 'exclusive', rect: {} });
  eq('an anti-cheat game takes the front: her window is hidden at once', calls.filter((c) => c === 'hide').length, hides0 + 1);
  const acRt = events().filter((e) => e.type === 'rt').pop() as unknown as { state: string; message?: string };
  eq('…and 实时陪玩 ends with it (no microphone or recogniser running unseen), saying why', [rtActive, acRt.state, !!acRt.message?.includes('反作弊')], [false, 'closed', true]);
  eq('…and a reply she was writing stops "typing" (its end will not be shown)', synced().filter((e) => e.id === 'ac0').map((e) => !!e.streaming), [false]);
  eq('and she says nothing over it', await ipcHandle.get('pet:say')!(fromApp, { id: 'ac1', text: '嗨' }), { ok: false });
  await wait(1750);
  onFocus!({ exe: 'notepad.exe', title: 'n', pid: 9, hwnd: '555', fullscreen: 'no', rect: {} });
  await wait(1750);
  eq('she is shown again once it is no longer in front', [calls.filter((c) => c === 'show').length > shows0, await ipcHandle.get('pet:say')!(fromApp, { id: 'ac2', text: '嗨' })], [true, { ok: true }]);

  // Switching off.
  const hides1 = calls.filter((c) => c === 'hide').length;
  await ipcHandle.get('pet:say')!(fromApp, { id: 'off0', text: '那我', mood: 'talk', streaming: true });
  ipcOn.get('pet:config')!(fromApp, { ...cfg, enabled: false });
  eq('switching off hides the window, drops the hotkeys and stops sensing', [calls.filter((c) => c === 'hide').length > hides1, hot, sensing], [true, undefined, false]);
  eq('…the page hears no hotkey works now', events().filter((e) => e.type === 'hotkeys').pop() as unknown, { type: 'hotkeys', ask: false, pause: false, errors: [] });
  eq('…and nothing in the log is left "typing"', synced().filter((e) => e.streaming).length, 0);
  hub.stopAll();
  expect('quitting leaves nothing running, and her window is not built again once it closes', calls.includes('capture-dispose') && calls.includes('window-shutdown'));
}

// 3. The pet window itself (window.cjs): the chat panel's size and the keyboard.
console.log('Pet window');
{
  type Rect = { x: number; y: number; width: number; height: number };
  type Fn = (...a: unknown[]) => void;
  class FakePetWindow {
    static last: FakePetWindow | undefined;
    bounds: Rect;
    focusable: boolean;
    focused = false;
    visible = false;
    /** The OS will not hand over the keyboard. */
    refuse = false;
    /** Like Windows at 150 % display scaling: at an odd y the window reads back a pixel taller than it was set. */
    offByOne = false;
    /** Like a real transparent window at 150 %: it reads back 2 px wider and taller than it was set. */
    pad = 0;
    /** setBounds calls: each one can make a transparent window flash. */
    sets = 0;
    ignore: boolean | null = null;
    destroyed = false;
    sent: Array<[string, { type?: string }]> = [];
    private on_ = new Map<string, Fn[]>();
    private wcOn = new Map<string, Fn[]>();
    webContents = {
      send: (c: string, p: { type?: string }) => { this.sent.push([c, p]); },
      on: (ev: string, fn: Fn) => { this.wcOn.set(ev, [...(this.wcOn.get(ev) ?? []), fn]); },
      setWindowOpenHandler() {}, setBackgroundThrottling() {}, isDestroyed: () => this.destroyed,
    };
    constructor(o: Rect & { focusable?: boolean }) {
      this.bounds = { x: o.x, y: o.y, width: o.width, height: o.height };
      this.focusable = o.focusable !== false;
      FakePetWindow.last = this;
    }
    on(ev: string, fn: Fn) { this.on_.set(ev, [...(this.on_.get(ev) ?? []), fn]); }
    once(ev: string, fn: Fn) { this.on(ev, fn); }
    emit(ev: string) { (this.on_.get(ev) ?? []).forEach((fn) => fn()); }
    emitWc(ev: string, details: object = {}) { (this.wcOn.get(ev) ?? []).forEach((fn) => fn({}, details)); }
    getBounds() { return { ...this.bounds, width: this.bounds.width + this.pad, height: this.bounds.height + this.pad + (this.offByOne && Math.abs(this.bounds.y) % 2 ? 1 : 0) }; }
    setBounds(r: Rect) { this.bounds = { ...r }; this.sets++; }
    setFocusable(v: boolean) { this.focusable = v; }
    setSkipTaskbar() {}
    setAlwaysOnTop() {}
    setIgnoreMouseEvents(v: boolean) { this.ignore = v; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.blurTo(); this.visible = false; this.emit('hide'); }
    isFocused() { return this.focused; }
    focus() { if (this.focusable && !this.refuse && !this.focused) { this.focused = true; this.emit('focus'); } }
    /** The user clicks into another window. */
    blurTo() { if (this.focused) { this.focused = false; this.emit('blur'); } }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.visible = false; this.emit('closed'); }
    /** Alt+F4. */
    close() { this.destroy(); }
    loadFile() { setTimeout(() => { this.emit('ready-to-show'); this.emitWc('did-finish-load'); }, 5); return Promise.resolve(); }
    reload() { setTimeout(() => this.emitWc('did-finish-load'), 5); }
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(777n); return b; }
  }
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-pet-check-'));
  const fe = fakeElectron as unknown as Record<string, unknown>;
  fe.BrowserWindow = FakePetWindow;
  const screenOn = new Map<string, Fn[]>();
  fe.screen = {
    getDisplayNearestPoint: () => display, getPrimaryDisplay: () => display, getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on: (ev: string, fn: Fn) => { screenOn.set(ev, [...(screenOn.get(ev) ?? []), fn]); },
  };
  const screensChanged = () => (screenOn.get('display-metrics-changed') ?? []).forEach((fn) => fn());
  fakeElectron.app.getPath = () => tmp;
  delete modules[req.resolve('./electron/pet/window.cjs')];
  const pw = req('./electron/pet/window.cjs') as {
    show(): void; hide(): void; sendCommand(c: { type: string }): void; chatState(): { open: boolean; focused: boolean }; focusChat(): void;
    drag(phase: string, x: number, y: number): void; applyScale(s: number): void; setInteractive(on: boolean): void; shutdown(): void;
  };
  const saved = () => (JSON.parse(fs.readFileSync(path.join(tmp, 'window-state.json'), 'utf8')) as { petBounds: Rect }).petBounds;
  const told = (w: FakePetWindow) => w.sent.filter(([c]) => c === 'pet-ui:command').map(([, p]) => p.type);
  pw.show();
  await wait(300);
  const w = FakePetWindow.last!;
  eq('she starts on the taskbar at the bottom right, in a window already as tall as with the panel open, that never takes the keyboard',
    [w.getBounds(), w.focusable, w.visible], [{ x: 1608, y: 402, width: 300, height: 630 }, false, true]);

  let sets = w.sets;
  pw.sendCommand({ type: 'chat' });
  eq('opening the chat neither moves nor resizes the window (a transparent window that grows upward flashes on Windows)',
    [w.getBounds(), w.sets - sets], [{ x: 1608, y: 402, width: 300, height: 630 }, 0]);
  eq('…takes the keyboard, and tells the page', [w.focusable, w.focused, pw.chatState(), told(w).pop()], [true, true, { open: true, focused: true }, 'chat']);
  eq('the open panel does not make the whole window swallow clicks (only where the page says)', w.ignore, true);
  pw.setInteractive(true);
  eq('…the panel itself does', w.ignore, false);
  pw.setInteractive(false);
  w.blurTo();
  eq('clicking elsewhere lets go of the keyboard and is click-through again, but the panel stays open and the window tall',
    [w.focusable, w.ignore, pw.chatState(), w.getBounds().height, told(w).includes('close-chat')], [false, true, { open: true, focused: false }, 630, false]);
  pw.focusChat();
  eq('a click back into the panel takes the keyboard again', [w.focusable, w.focused, pw.chatState().focused], [true, true, true]);

  pw.drag('start', 1000, 900);
  pw.drag('move', 900, 900);
  pw.drag('end', 900, 900);
  eq('dragging her with the panel open moves both; the saved place is where she stands, not the tall window',
    [w.getBounds(), saved()], [{ x: 1508, y: 402, width: 300, height: 630 }, { x: 1508, y: 632, width: 300, height: 400 }]);
  sets = w.sets;
  pw.sendCommand({ type: 'close-chat' });
  eq('closing leaves the window as it is and lets go of the keyboard', [w.getBounds(), w.sets - sets, w.focusable, pw.chatState().open], [{ x: 1508, y: 402, width: 300, height: 630 }, 0, false, false]);

  pw.drag('start', 0, 0);
  pw.drag('end', 0, -582);
  eq('near the top of the screen the empty part above her head reaches past the top edge; she stands where she was dropped',
    [w.getBounds(), saved()], [{ x: 1508, y: -180, width: 300, height: 630 }, { x: 1508, y: 50, width: 300, height: 400 }]);
  pw.sendCommand({ type: 'chat' });
  eq('…there the open window moves into the work area (she moves down while it is open)', w.getBounds(), { x: 1508, y: 0, width: 300, height: 630 });
  eq('…and the saved place is still where she stands', saved(), { x: 1508, y: 50, width: 300, height: 400 });
  pw.sendCommand({ type: 'close-chat' });
  eq('…and she goes back up when it closes', w.getBounds(), { x: 1508, y: -180, width: 300, height: 630 });
  pw.sendCommand({ type: 'chat' });
  pw.drag('start', 500, 500);
  pw.drag('end', 500, 500);
  pw.drag('start', 500, 500);
  pw.drag('end', 502, 501); // a hand's tremble, under the page's 4 px
  pw.sendCommand({ type: 'close-chat' });
  eq('a click (or double-click) on her while the open panel has pushed her down is not a drop: same place, same saved place',
    [w.getBounds(), saved()], [{ x: 1508, y: -180, width: 300, height: 630 }, { x: 1508, y: 50, width: 300, height: 400 }]);
  pw.sendCommand({ type: 'chat' });
  pw.drag('start', 500, 500);
  pw.drag('move', 510, 500);
  pw.sendCommand({ type: 'close-chat' }); // the hotkey, with the mouse button still down
  pw.drag('move', 520, 500);
  eq('closing the panel in the middle of a drag: the window goes on around her, back where it is with the panel closed', w.getBounds(), { x: 1528, y: -180, width: 300, height: 630 });
  pw.drag('end', 520, 500);
  eq('…and she is dropped where the pointer let go', [w.getBounds(), saved()], [{ x: 1528, y: -180, width: 300, height: 630 }, { x: 1528, y: 50, width: 300, height: 400 }]);

  // A small screen at the largest size: the whole thing does not fit, so the panel is shorter.
  display.bounds = { x: 0, y: 0, width: 1366, height: 768 };
  display.workArea = { x: 0, y: 0, width: 1366, height: 728 };
  pw.drag('start', 0, 0);
  pw.drag('end', -600, 278); // her feet on the top of the taskbar (the bottom of the work area)
  pw.applyScale(1.6);
  const small = w.getBounds();
  sets = w.sets;
  pw.sendCommand({ type: 'chat' });
  const big = w.getBounds();
  eq('on a small screen at size 1.6 the window is as tall as the work area and no taller, her feet at its bottom, and the panel opens in it as it is',
    [big.width, big.height, big.y >= 0, big.y + big.height <= 728, big.y + big.height === saved().y + saved().height, w.sets - sets], [480, 728, true, true, true, 0]);
  pw.sendCommand({ type: 'close-chat' });
  eq('…and the same after', w.getBounds(), small);

  pw.sendCommand({ type: 'chat' });
  w.reload();
  await wait(300);
  eq('a reloaded page is told the panel is open', told(w).slice(-2), ['chat', 'chat']);
  pw.hide();
  eq('hiding her (an anti-cheat game, switched off) closes the panel with her and stops her voice (the page is told both), and the page forgets where the pointer was',
    [pw.chatState().open, told(w).slice(-3), w.focusable, w.getBounds().height], [false, ['close-chat', 'hush', 'pointer'], false, 728]);

  pw.show();
  w.refuse = true;
  pw.sendCommand({ type: 'chat' });
  eq('when the OS will not hand over the keyboard, the panel opens anyway…', [pw.chatState(), w.focusable], [{ open: true, focused: false }, true]);
  await wait(6200);
  eq('…and after a while the window stops being focusable for nothing (the panel stays)', [w.focusable, pw.chatState().open], [false, true]);
  pw.sendCommand({ type: 'close-chat' });
  w.refuse = false;

  // Windows at 150 %: a work area 1019 px tall, so her default place is at an odd y, where the window reads back a pixel
  // taller than it was set. Opening and closing must not walk her down the screen a pixel or two each time.
  display.bounds = { x: 0, y: 0, width: 1707, height: 1067 };
  display.workArea = { x: 0, y: 0, width: 1707, height: 1019 };
  pw.applyScale(1);
  const here = saved();
  pw.drag('start', 0, 0);
  pw.drag('end', 1395 - here.x, 619 - here.y);
  w.offByOne = true;
  const ys: number[] = [];
  sets = w.sets;
  for (let i = 0; i < 15; i++) {
    pw.sendCommand({ type: 'chat' });
    pw.sendCommand({ type: 'close-chat' });
    ys.push(w.bounds.y);
  }
  eq('open/close 15 times where getBounds() is a pixel off: the window is never set again, and she and the saved place stay put',
    [[...new Set(ys)], w.bounds, saved(), w.sets - sets], [[389], { x: 1395, y: 389, width: 300, height: 630 }, { x: 1395, y: 619, width: 300, height: 400 }, 0]);
  pw.sendCommand({ type: 'chat' });
  eq('…and the open window still stands on her feet, inside the work area', w.bounds, { x: 1395, y: 389, width: 300, height: 630 });
  pw.sendCommand({ type: 'close-chat' });
  w.offByOne = false;
  w.pad = 2;
  sets = w.sets;
  for (let i = 0; i < 5; i++) {
    pw.sendCommand({ type: 'chat' });
    pw.sendCommand({ type: 'close-chat' });
  }
  eq('…nor where the window reads back 2 px larger than it was set (a transparent window at 150 %)', [w.sets - sets, w.bounds], [0, { x: 1395, y: 389, width: 300, height: 630 }]);
  w.pad = 0;

  // A display that shrinks for a while (a full-screen game at a lower resolution, a monitor unplugged) moves her only for that while.
  const put = { ...w.bounds };
  const savedPut = saved();
  display.bounds = { x: 0, y: 0, width: 1280, height: 720 };
  display.workArea = { x: 0, y: 0, width: 1280, height: 720 };
  screensChanged();
  const shrunk = { ...w.bounds };
  display.bounds = { x: 0, y: 0, width: 1707, height: 1067 };
  display.workArea = { x: 0, y: 0, width: 1707, height: 1019 };
  screensChanged();
  eq('a display that shrinks keeps her on it; when it grows back she is where the user put her, and the saved place never moved',
    [shrunk.x + shrunk.width <= 1280 && shrunk.y + shrunk.height <= 720, w.bounds, saved()], [true, put, savedPut]);

  // A page that keeps crashing: the window is let go (no dead rectangle on the screen holding the keyboard).
  pw.sendCommand({ type: 'chat' });
  for (let i = 0; i < 4; i++) w.emitWc('render-process-gone', { reason: 'crashed' });
  eq('four crashes in a minute: the panel closes and the window goes', [w.destroyed, pw.chatState().open], [true, false]);
  await wait(400);
  eq('…and it is not built again by itself', FakePetWindow.last, w);
  pw.show();
  await wait(300);
  const w2 = FakePetWindow.last!;
  eq('showing her again builds a new window, where the user put her', [w2 !== w, w2.visible, w2.bounds], [true, true, put]);
  w2.close(); // Alt+F4 while the panel had the keyboard
  await wait(400);
  const w3 = FakePetWindow.last!;
  eq('a window closed under her while she is switched on comes back by itself', [w3 !== w2, w3.visible, w3.bounds], [true, true, put]);
  pw.shutdown();
  w3.close();
  await wait(400);
  eq('…but not once the app is quitting', FakePetWindow.last, w3);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
