/* A stand-in for window.fireflyPet when pet.html is opened in a plain browser (npm run dev, /pet.html):
   it shows the figure, says one line and answers in the chat panel with a canned reply (streamed, like the real one),
   so the look can be worked on without the desktop shell. Never used inside the app. */
import type { PetChatEntry, PetChatMsg, PetLine, PetMood, PetUiCommand, PetUiState, PetWindowBridge } from '../contracts';
import { CHAT_MAX } from './chatLog';

type Bridge = PetWindowBridge & { click(): void };

export function demoBridge(): Bridge {
  const params = new URLSearchParams(location.search);
  const mode = params.get('mode') === 'sam' ? 'sam' : 'firefly';
  const subs = {
    cmd: new Set<(c: PetUiCommand) => void>(), state: new Set<(s: PetUiState) => void>(), line: new Set<(l: PetLine) => void>(),
    mood: new Set<(m: { mood: PetMood }) => void>(), chat: new Set<(m: PetChatMsg) => void>(),
  };
  const sub = <T,>(set: Set<(v: T) => void>) => (fn: (v: T) => void) => { set.add(fn); return () => { set.delete(fn); }; };
  // The log, as the desktop keeps it (electron/pet/index.cjs).
  const log: PetChatEntry[] = [];
  let n = 0;
  const put = (entry: PetChatEntry) => {
    const i = log.findIndex((e) => e.id === entry.id);
    if (i >= 0) log[i] = entry; else log.push(entry);
    if (log.length > CHAT_MAX) log.splice(0, log.length - CHAT_MAX);
    subs.chat.forEach((fn) => fn({ op: 'put', entry }));
  };
  const say = (text: string, mood: PetMood = 'talk', more?: string, id = `demo-${++n}`, streaming = false) => {
    subs.line.forEach((fn) => fn({ id, text, mood, more, streaming }));
    const at = log.find((e) => e.id === id)?.at ?? Date.now();
    put({ id, who: 'her', text, more, mood, streaming: streaming || undefined, at });
  };
  const mine = (text: string) => put({ id: `me-${++n}`, who: 'me', text, at: Date.now() });
  const cmd = (c: PetUiCommand) => subs.cmd.forEach((fn) => fn(c));
  const state: PetUiState = { mode, scale: Number(params.get('scale')) || 1, watching: params.has('watch'), paused: false, realtime: false, voice: false };
  const LONG = ['第一步先把护盾打掉，然后集中输出弱点属性。', '第二步等他读条的时候走位，躲开地面的红圈。', '第三步趁硬直时开大招，注意留一点能量给下一个阶段。', '第四步把剩下的血量打完，掉落会在中间的箱子里。'];
  // ?mode=sam  ?scale=1.4  ?watch  ?mood=sleep|think|happy|watch  ?long  ?chat  — to look at one state of the window.
  setTimeout(() => {
    subs.state.forEach((fn) => fn(state));
    const mood = params.get('mood') as PetMood | null;
    if (params.has('chat')) {
      say(mode === 'sam' ? '在线。' : '嗯，我在这里。', 'happy');
      mine('这个 Boss 怎么打？');
      say(LONG.slice(0, 2).join(''), 'talk', LONG.join('\n'));
      mine('好，我试试');
    }
    if (params.has('long')) say(LONG.slice(0, 2).join(''), 'talk', LONG.join('\n'));
    else say(mode === 'sam' ? '在线。预览模式，没有接入桌面。' : '嗯，我在这里。现在是浏览器里的预览，还没有接上桌面哦。', mood ?? 'talk');
    if (mood) subs.mood.forEach((fn) => fn({ mood }));
    if (params.has('chat')) cmd({ type: 'chat' });
  }, 400);

  return {
    onCommand: sub(subs.cmd),
    onState: sub(subs.state),
    onLine: sub(subs.line),
    onLineDelta: () => () => {},
    onAudio: () => () => {},
    onMood: sub(subs.mood),
    onChat: sub(subs.chat),
    ask: (raw) => {
      const text = raw.trim();
      if (!text) return;
      mine(text);
      const id = `ask-${++n}`;
      say(mode === 'sam' ? '解析中。' : '嗯……让我想想。', 'think', undefined, id, true);
      const reply = `你说的是「${text.slice(0, 20)}」。这是预览里的固定回答，真正的回答由大脑通过模型生成，会像这样一点点写出来。`;
      let k = 0;
      const grow = () => {
        k = Math.min(reply.length, k + 6);
        if (k < reply.length) { say(reply.slice(0, k), 'talk', undefined, id, true); setTimeout(grow, 90); } else say(reply, 'talk', undefined, id);
      };
      setTimeout(grow, 700);
    },
    chatSync: () => subs.chat.forEach((fn) => fn({ op: 'reset', entries: log.slice() })),
    chatOpen: () => cmd({ type: 'chat' }),
    chatClose: () => cmd({ type: 'close-chat' }),
    chatFocus: () => {},
    hit: () => {},
    drag: () => {},
    menu: () => say('右键菜单只在桌面版里有。', 'idle'),
    spoken: () => {},
    mic: () => {},
    micFailed: () => {},
    click: () => say(mode === 'sam' ? '在线。' : '嗯？我在呢。', 'happy'),
  };
}
