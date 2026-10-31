/* The 桌宠 window: the figure, her bubble, the chat panel. It only shows what the desktop side sends
   (window.fireflyPet, electron/pet/preload.cjs) and reports clicks, drags and the user's messages back. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PetChatEntry, PetLine, PetMood, PetUiState, PetWindowBridge } from '../contracts';
import { PetAudio } from './audio';
import { ChatPanel } from './Chat';
import { applyChat } from './chatLog';
import { demoBridge } from './demo';
import { startMic, type Mic } from './mic';
import { Puppet, type PuppetInput } from './Puppet';
import type { PuppetPose } from './puppet/rig';
import type { PetPose } from './Sprite';

/** window.fireflyPet plus the click the preload adds beyond contracts.ts (optional: an older preload has none). */
type Bridge = Omit<PetWindowBridge, 'click'> & { click?(): void };
const bridge: Bridge = (window as unknown as { fireflyPet?: Bridge }).fireflyPet ?? demoBridge();

const START: PetUiState = { mode: 'firefly', scale: 1, watching: false, paused: false, realtime: false, voice: true };
/** A press that moves less than this (screen pixels) is a click, not a drag. */
const DRAG_PX = 4;
/** A second click this soon is a double-click (it opens the chat panel); a single click waits this long to be sure. */
const DOUBLE_MS = 320;

/** A line on screen long enough to read, then it fades. */
const showFor = (text: string) => Math.min(20_000, Math.max(5000, 3200 + text.length * 140));
/** A line still being written that has not grown for this long (longer than the web search's 100 s and the desktop's
 *  2 min stale rule) is given up: its closing line is not coming, and the bubble must not hang there for good. */
const STREAM_CAP_MS = 130_000;
/** If the desktop's first state has not come by now, show her anyway (with the defaults) rather than not at all. */
const STATE_WAIT_MS = 4000;

export function PetApp() {
  const [ui, setUi] = useState<PetUiState>(START);
  /** The desktop's first state has arrived: until then nothing is drawn, so she never shows as the wrong character or size. */
  const [got, setGot] = useState(false);
  const [line, setLine] = useState<PetLine | null>(null);
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [mood, setMood] = useState<PetMood>('idle');
  const [mouth, setMouth] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [flap, setFlap] = useState(false);
  const [babbling, setBabbling] = useState(false);
  /** The line whose voice failed: she still moves her mouth for it. */
  const [voiceless, setVoiceless] = useState('');
  const [blink, setBlink] = useState(false);
  const [hover, setHover] = useState(false);
  /** The chat panel: open, how many times the desktop opened it (each one puts the caret back), the log, the unsent text. */
  const [chat, setChat] = useState(false);
  const [opened, setOpened] = useState(0);
  const [log, setLog] = useState<PetChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  /** The window holds the keyboard. */
  const [keys, setKeys] = useState(() => document.hasFocus());
  /** The pointer is over her (the chat button shows beside her). */
  const [near, setNear] = useState(false);
  const audio = useRef<PetAudio | null>(null);
  /** The id of the line the user closed with ×: its next pieces (it is still being written) do not bring the bubble back. */
  const dismissed = useRef('');
  /** What the pointer effect below offers the rest of the page: look again at what the pointer is over, or forget it. */
  const pointer = useRef({ look() {}, forget() {} });

  /* ───────────── messages from the desktop ───────────── */

  useEffect(() => {
    const a = new PetAudio({
      spoken: (id, state) => { bridge.spoken(id, state); setPlaying(state === 'start'); },
      mouth: setMouth,
      failed: setVoiceless,
    });
    audio.current = a;
    const wait = setTimeout(() => setGot(true), STATE_WAIT_MS);
    const off = [
      bridge.onState((s) => { setUi(s); setGot(true); }),
      bridge.onLine((l) => {
        setLine((prev) => { if (prev?.id !== l.id) setExpanded(false); return l; });
        // The user closed this line with ×: while it is still being written it stays closed (its final version shows).
        const closed = !!dismissed.current && l.id === dismissed.current;
        if (!closed) dismissed.current = '';
        setShown(!!l.text && !(closed && l.streaming));
        // Another line replaces the one being read aloud, and the sound still arriving for a line she dropped goes now.
        a.stop(l.id, true);
        if (l.mood) setMood(l.mood);
      }),
      bridge.onLineDelta((d) => setLine((prev) => (prev && prev.id === d.id ? { ...prev, text: prev.text + d.text } : prev))),
      bridge.onAudio((m) => a.push(m)),
      bridge.onMood((m) => setMood(m.mood)),
      bridge.onCommand((c) => {
        // 实时陪玩: the user cut in, or a newer reply took over: her voice stops at once.
        if (c.type === 'hush') { a.stop(); return; }
        // The window is click-through again: what the pointer was over is no longer true.
        if (c.type === 'pointer') { pointer.current.forget(); return; }
        if (c.type === 'chat') { setChat(true); setOpened((n) => n + 1); setHover(false); } else if (c.type === 'close-chat') setChat(false);
      }),
      bridge.onChat((m) => setLog((prev) => applyChat(prev, m))),
    ];
    // Listening now: the desktop sends the log as it stands (it outlives this page).
    bridge.chatSync();
    return () => { clearTimeout(wait); off.forEach((fn) => fn()); a.dispose(); audio.current = null; };
  }, []);

  // Whether the window holds the keyboard (clicking elsewhere takes it away; the panel stays open).
  useEffect(() => {
    const on = () => setKeys(true);
    const off = () => setKeys(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off); };
  }, []);

  // The window is resized by the desktop side; the page scales with it.
  useLayoutEffect(() => {
    if (!got) return;
    document.documentElement.style.zoom = String(ui.scale);
    document.documentElement.dataset.mode = ui.mode;
  }, [got, ui.scale, ui.mode]);

  // The microphone, only while 实时陪玩 is on. If it cannot be opened, or stops (unplugged, taken by another program),
  // the desktop is told, so she does not sit there with LIVE on and deaf.
  useEffect(() => {
    if (!ui.realtime) return;
    let mic: Mic | null = null;
    let stopped = false;
    void startMic((pcm) => bridge.mic(pcm), () => { if (!stopped) bridge.micFailed(); }).then((m) => {
      if (stopped) m?.stop();
      else if (m) mic = m;
      else bridge.micFailed();
    });
    return () => { stopped = true; mic?.stop(); };
  }, [ui.realtime]);

  /* ───────────── the bubble ───────────── */

  // While the chat panel is open the bubble is not drawn (her lines go into the log), but a line still has its time, so her
  // face and mouth follow it as usual and an old line does not pop up when the panel closes.
  // A line still being written waits for the next piece (each one starts the wait again), up to STREAM_CAP_MS.
  useEffect(() => {
    if (!shown || !line || (hover && !chat) || expanded || playing) return;
    const t = setTimeout(() => setShown(false), line.streaming ? STREAM_CAP_MS : showFor(line.text));
    return () => clearTimeout(t);
  }, [shown, line, chat, hover, expanded, playing]);

  // A line without a voice still moves her mouth for a moment.
  const text = line?.text ?? '';
  // The bubble is on screen. When it goes (× , a line with no text, the panel opening) the pointer is no longer over it,
  // and no mouseleave comes for an element that is gone: hover must not stay set, or no later bubble would ever fade.
  const bubble = shown && !!text && !chat;
  useEffect(() => { if (!bubble) setHover(false); }, [bubble]);
  // No voice for this line: it was not meant to be read, voice is switched off, or the voice failed.
  const silent = !!line && !playing && (!line.speak || !ui.voice || voiceless === line.id);
  const lineId = line?.id;
  useEffect(() => {
    if (!shown || !silent) return;
    const until = Date.now() + Math.min(3000, 600 + text.length * 70);
    setBabbling(true);
    const t = setInterval(() => { if (Date.now() > until) { clearInterval(t); setFlap(false); setBabbling(false); } else setFlap((f) => !f); }, 170);
    return () => { clearInterval(t); setFlap(false); setBabbling(false); };
  }, [shown, silent, lineId]);

  // Now and then she blinks.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const later = () => {
      t = setTimeout(() => { setBlink(true); t = setTimeout(() => { setBlink(false); later(); }, 130); }, 2600 + Math.random() * 3600);
    };
    later();
    return () => clearTimeout(t);
  }, []);

  /* ───────────── the pose ───────────── */

  const feel: PetMood = shown && line?.mood ? line.mood : mood;
  const babble = feel === 'talk' && shown && silent && babbling;
  // The puppet: a base pose; blinking and the mouth are blended in by the puppet itself. While she speaks
  // (aloud or babbling) the idle face is used, since that is the one with a matching open mouth.
  let base: PuppetPose;
  if (feel === 'sleep') base = 'sleep';
  else if (feel === 'think') base = 'think';
  else if (playing || babble) base = 'idle';
  else if (feel === 'happy') base = 'happy';
  else if (chat || ui.watching) base = 'watch';
  else base = 'idle';
  const puppet = useRef<PuppetInput>({ speaking: false, babble: false, level: () => audio.current?.level() ?? 0, vx: 0, vxAt: 0 });
  puppet.current.speaking = playing;
  puppet.current.babble = babble;

  // The plain picture switcher (no WebGL): whole frames for blink and talk, as before.
  let pose: PetPose;
  if (feel === 'sleep') pose = 'sleep';
  else if (feel === 'think') pose = 'think';
  else if (playing) pose = mouth ? 'talk' : feel === 'happy' ? 'happy' : 'idle';
  else if (feel === 'talk' && shown && silent && flap) pose = 'talk';
  else if (feel === 'happy') pose = 'happy';
  else if (chat || ui.watching) pose = blink ? 'blink' : 'watch';
  else pose = blink ? 'blink' : 'idle';

  /* ───────────── the pointer ───────────── */

  // Clicks fall through the window except where the figure, the bubble, the chat panel or the chat button is.
  useEffect(() => {
    let over = false;
    let by = false;
    /** Where the pointer last was in the window (null: outside it, or not known any more). */
    let at: { x: number; y: number } | null = null;
    const look = () => {
      if (!at) return;
      const el = document.elementFromPoint(at.x, at.y);
      const now = !!el?.closest('[data-hit]');
      if (now !== over) { over = now; bridge.hit(now); }
      const close = !!el?.closest('.pet-stage');
      if (close !== by) { by = close; setNear(close); }
    };
    const move = (e: MouseEvent) => { at = { x: e.clientX, y: e.clientY }; look(); };
    const leave = () => {
      at = null;
      if (over) { over = false; bridge.hit(false); }
      if (by) { by = false; setNear(false); }
    };
    // The desktop made the window click-through behind the page's back (hidden, reloaded, lost the keyboard): the position
    // is stale too, so the next move reports the pointer afresh.
    const forget = () => { at = null; over = false; by = false; setNear(false); bridge.hit(false); };
    pointer.current = { look, forget };
    window.addEventListener('mousemove', move);
    document.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);
    return () => { window.removeEventListener('mousemove', move); document.removeEventListener('mouseleave', leave); window.removeEventListener('blur', leave); };
  }, []);

  // A pointer that rests while the layout changes under it (the bubble comes, grows or goes, the panel opens or closes,
  // the scale changes) is over something else now; mousemove alone would not tell, and the window would swallow clicks
  // meant for the game (or let through ones meant for her) until the next move.
  useEffect(() => {
    const id = requestAnimationFrame(() => pointer.current.look());
    return () => cancelAnimationFrame(id);
  }, [got, shown, text, chat, near, expanded, ui.scale]);

  const press = useRef<{ x: number; y: number; moved: boolean; lx: number; lt: number } | null>(null);
  /** A click waiting to see whether a second one makes it a double-click. */
  const clickWait = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (clickWait.current) clearTimeout(clickWait.current); }, []);
  const down = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.screenX, y: e.screenY, moved: false, lx: e.screenX, lt: performance.now() };
    // The desktop side follows the real cursor itself; the numbers here are only for the "did it move" test.
    bridge.drag('start', NaN, NaN);
  }, []);
  const move = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.screenX - p.x, e.screenY - p.y) >= DRAG_PX) p.moved = true;
    if (p.moved) bridge.drag('move', NaN, NaN);
    // The window follows the cursor, so its speed is the cursor's: the puppet's hair lags behind it.
    const now = performance.now();
    if (p.moved && now - p.lt >= 8) {
      const vx = (e.screenX - p.lx) / (now - p.lt);
      puppet.current.vx = Math.max(-4, Math.min(4, vx));
      puppet.current.vxAt = now;
      p.lx = e.screenX;
      p.lt = now;
    }
  }, []);
  const up = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    bridge.drag('end', NaN, NaN);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (p.moved) return;
    // A press that did not drag is a click on her; two of them quickly open the chat panel instead.
    if (clickWait.current) {
      clearTimeout(clickWait.current);
      clickWait.current = null;
      bridge.chatOpen();
      return;
    }
    clickWait.current = setTimeout(() => { clickWait.current = null; bridge.click?.(); }, DOUBLE_MS);
  }, []);

  /* ───────────── the chat panel ───────────── */

  const closeChat = useCallback(() => { setChat(false); bridge.chatClose(); }, []);

  const more = line?.more;
  if (!got) return null;
  return (
    <div className="pet" data-mode={ui.mode}>
      {chat && (
        <ChatPanel mode={ui.mode} log={log} draft={draft} setDraft={setDraft} keys={keys} opened={opened}
          onSend={(v) => bridge.ask(v)} onClose={closeChat} onTakeKeys={() => bridge.chatFocus()} />
      )}
      {bubble && (
        <div className="pet-bubble" data-hit data-streaming={line?.streaming ? '' : undefined} data-open={expanded ? '' : undefined}
          onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
          <p className="pet-bubble__text" role="status" aria-live="polite">{expanded && more ? more : text}</p>
          {more && (
            <button type="button" className="pet-bubble__more" onClick={() => setExpanded((x) => !x)}>{expanded ? '收起' : '展开'}</button>
          )}
          <button type="button" className="pet-bubble__close" aria-label="关闭气泡" onClick={() => { dismissed.current = line?.id ?? ''; setShown(false); setExpanded(false); setHover(false); }}>×</button>
        </div>
      )}
      <div className="pet-stage">
        {/* With the panel open a press on her must not take the caret out of the box (that is mousedown's default; the
            pointer events, the drag and the menu are not touched). */}
        <div className="pet-figure" data-hit data-pose={pose} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onMouseDown={(e) => { if (chat) e.preventDefault(); }}
          onContextMenu={(e) => { e.preventDefault(); bridge.menu(); }}>
          <Puppet key={ui.mode} mode={ui.mode} pose={base} fallback={pose} input={puppet} />
        </div>
        {near && !chat && (
          <button type="button" className="pet-chatbtn" data-hit aria-label="和她聊天" title="和她聊天（双击她也可以）" onClick={() => bridge.chatOpen()}>
            <ChatIcon />
          </button>
        )}
        <div className="pet-badges">
          {ui.realtime && <span className="pet-badge pet-badge--live" title="实时陪玩中">LIVE</span>}
          {ui.realtime && ui.listening && <span className="pet-badge pet-badge--ear" title="在听你说话"><MicIcon /></span>}
          {ui.watching && <span className="pet-badge" title="正在看游戏画面"><EyeIcon /></span>}
          {ui.paused && !ui.watching && <span className="pet-badge pet-badge--off" title="观看已暂停"><PauseIcon /></span>}
        </div>
      </div>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 12a7.5 7 0 0 1-10.6 6.4L4.5 20l1.4-4A7 7 0 0 1 4.5 12 7.5 7 0 0 1 20 12z" /><path d="M9 12h.01M12.5 12h.01M16 12h.01" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
