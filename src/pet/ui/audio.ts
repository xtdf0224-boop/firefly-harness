/* Playing her voice in the pet window, and telling the sprite when the mouth should be open.
   The desktop sends each spoken line as mp3 chunks (pet-ui:audio); a line is decoded and played when its
   last chunk is in. `live` chunks (实时陪玩, raw 16-bit PCM) are queued and played as they come; an MP3 line with a
   `group` (实时陪玩 read by a voice that only gives MP3) is decoded and queued after the group's earlier sound. */

type AudioMsg = { lineId: string; seq: number; chunk: Uint8Array; mime: string; volume?: number; live?: boolean; group?: string } | { lineId: string; end: true; failed?: string };

export interface PetAudioEvents {
  /** Playback of a line began / ended (or was cut off). */
  spoken(lineId: string, state: 'start' | 'end'): void;
  /** Whether the mouth is open right now (about 15 times a second while sound plays). */
  mouth(open: boolean): void;
  /** A line's voice could not be made or played (the window then moves her mouth without sound). */
  failed?(lineId: string): void;
}

interface Pending { parts: Uint8Array[]; mime: string; volume: number; group?: string }

/** Mouth opens above this level and closes below the lower one (so it does not flutter). */
const OPEN = 0.045;
const CLOSE = 0.025;

export class PetAudio {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private buf = new Uint8Array(512);
  private pending = new Map<string, Pending>();
  /** Lines whose last chunk is in and which are being decoded. */
  private decoding = new Set<string>();
  /** Lines that were cut off: chunks still in flight for them are dropped, and one that is being decoded is not played. */
  private cancelled = new Set<string>();
  /** Live replies that were stopped (cut off, or replaced): late sound for them is dropped. Kept apart from
   *  `cancelled`, which a bubble line for the same id clears. */
  private cutLive = new Set<string>();
  /** Live replies with an MP3 sentence being decoded right now. */
  private decodingGroups = new Set<string>();
  private playing: { id: string; sources: Set<AudioBufferSourceNode>; started: boolean; tail: number; live: boolean } | null = null;
  private open = false;
  private raf = 0;
  private lastSample = 0;

  constructor(private readonly on: PetAudioEvents) {}

  /** The line whose sound is playing or arriving, if any. */
  get currentId(): string {
    return this.playing?.id ?? '';
  }

  private ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    // The level is measured before the volume, so how wide her mouth opens does not depend on the volume slider.
    analyser.connect(gain);
    gain.connect(ctx.destination);
    this.ctx = ctx;
    this.gain = gain;
    this.analyser = analyser;
    return ctx;
  }

  push(m: AudioMsg) {
    if ('end' in m) { void this.finish(m.lineId, !!m.failed); return; }
    if (m.live || m.mime.startsWith('audio/pcm')) { this.pushPcm(m); return; }
    if (this.cancelled.has(m.lineId)) return; // a chunk of a line that was already replaced
    let p = this.pending.get(m.lineId);
    if (!p) { p = { parts: [], mime: m.mime, volume: m.volume ?? 80, group: typeof m.group === 'string' ? m.group : undefined }; this.pending.set(m.lineId, p); }
    p.parts.push(m.chunk);
  }

  private markLive(id: string) {
    this.cutLive.add(id);
    if (this.cutLive.size > 16) this.cutLive.delete(this.cutLive.values().next().value as string);
  }

  /** Remember a line as cut off (the list stays short: only the last few matter). */
  private cut(id: string) {
    this.cancelled.add(id);
    if (this.cancelled.size > 16) this.cancelled.delete(this.cancelled.values().next().value as string);
  }

  /** A new line replaced the one being spoken: drop its sound, and what is still arriving or being decoded for
   *  other lines, right now. `keepLive` leaves a running 实时陪玩 stream alone (its transcript lines are bubbles only). */
  stop(except = '', keepLive = false) {
    if (except) this.cancelled.delete(except);
    for (const id of [...this.pending.keys()]) if (id !== except) { this.pending.delete(id); this.cut(id); }
    for (const id of this.decoding) if (id !== except) this.cut(id);
    if (!keepLive) for (const g of this.decodingGroups) if (g !== except) this.markLive(g);
    const cur = this.playing;
    if (cur && cur.id !== except && !(keepLive && cur.live)) {
      this.playing = null;
      // Sound for a live reply may still be on its way: it is dropped when it arrives.
      if (cur.live) this.markLive(cur.id);
      cur.sources.forEach((s) => { try { s.stop(); } catch { /* ended already */ } });
      if (cur.started) this.on.spoken(cur.id, 'end');
      this.setMouth(false);
    }
  }

  private async finish(id: string, failed: boolean) {
    const p = this.pending.get(id);
    this.pending.delete(id);
    if (this.playing?.id === id && this.playing.sources.size) return; // a live stream: it ends by itself
    if (failed) { this.on.failed?.(id); return; }
    if (!p || !p.parts.length) return;
    if (p.group) { void this.queueDecoded(id, p); return; }
    const total = p.parts.reduce((n, a) => n + a.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const a of p.parts) { bytes.set(a, at); at += a.length; }
    const ctx = this.ensure();
    this.decoding.add(id);
    let buffer: AudioBuffer | undefined;
    try {
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    } catch { buffer = undefined; }
    this.decoding.delete(id);
    // A newer line took over while this one was being decoded: it is not played.
    if (this.cancelled.delete(id)) return;
    if (!buffer) { this.on.failed?.(id); return; }
    this.stop(id);
    this.gain!.gain.value = Math.min(1, Math.max(0, p.volume / 100));
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser!);
    const cur = { id, sources: new Set([src]), started: true, tail: 0, live: false };
    this.playing = cur;
    src.onended = () => {
      cur.sources.delete(src);
      if (this.playing === cur && !cur.sources.size) { this.playing = null; this.on.spoken(id, 'end'); this.setMouth(false); }
    };
    src.start();
    this.on.spoken(id, 'start');
    this.sample();
  }

  /** Raw 16-bit mono PCM (mime audio/pcm;rate=24000), played back to back as it arrives. */
  private pushPcm(m: Extract<AudioMsg, { chunk: Uint8Array }>) {
    if (this.cutLive.has(m.lineId)) return; // a live reply the user cut off: its late chunks are dropped
    const ctx = this.ensure();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const rate = Number(/rate=(\d+)/.exec(m.mime)?.[1]) || 24000;
    const n = Math.floor(m.chunk.byteLength / 2);
    if (!n) return;
    const view = new DataView(m.chunk.buffer, m.chunk.byteOffset, n * 2);
    const buf = ctx.createBuffer(1, n, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    this.schedule(m.lineId, buf, m.volume ?? 80);
  }

  /** A whole MP3 sentence of a live reply: decoded, then queued after what the reply already plays. */
  private async queueDecoded(id: string, p: Pending) {
    const group = p.group!;
    if (this.cutLive.has(group)) return;
    const total = p.parts.reduce((n, a) => n + a.length, 0);
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const a of p.parts) { bytes.set(a, at); at += a.length; }
    const ctx = this.ensure();
    let buffer: AudioBuffer | undefined;
    this.decodingGroups.add(group);
    try {
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
    } catch { buffer = undefined; }
    this.decodingGroups.delete(group);
    if (!buffer) { this.on.failed?.(id); return; }
    if (this.cutLive.has(group)) return;
    this.schedule(group, buffer, p.volume);
  }

  /** Queue a piece of sound for a live reply `id` right after its earlier pieces (a different reply is stopped first). */
  private schedule(id: string, buf: AudioBuffer, volume: number) {
    const ctx = this.ensure();
    this.gain!.gain.value = Math.min(1, Math.max(0, volume / 100));
    let cur = this.playing;
    if (!cur || cur.id !== id) {
      this.stop();
      cur = { id, sources: new Set(), started: false, tail: ctx.currentTime + 0.05, live: true };
      this.playing = cur;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser!);
    const startAt = Math.max(cur.tail, ctx.currentTime + 0.02);
    cur.tail = startAt + buf.duration;
    cur.sources.add(src);
    const mine = cur;
    src.onended = () => {
      mine.sources.delete(src);
      if (this.playing === mine && !mine.sources.size) { this.playing = null; this.on.spoken(mine.id, 'end'); this.setMouth(false); }
    };
    src.start(startAt);
    if (!mine.started) { mine.started = true; this.on.spoken(mine.id, 'start'); this.sample(); }
  }

  private setMouth(open: boolean) {
    if (open === this.open) return;
    this.open = open;
    this.on.mouth(open);
  }

  /** Read the output level a few times a second while something plays. */
  private sample = () => {
    cancelAnimationFrame(this.raf);
    if (!this.playing || !this.analyser) return;
    const now = performance.now();
    if (now - this.lastSample >= 66) {
      this.lastSample = now;
      const rms = this.rms();
      this.setMouth(this.open ? rms > CLOSE : rms > OPEN);
    }
    this.raf = requestAnimationFrame(this.sample);
  };

  private rms(): number {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) { const d = (v - 128) / 128; sum += d * d; }
    return Math.sqrt(sum / this.buf.length);
  }

  /** How loud her voice is right now (RMS of what is being played, about 0…0.35); 0 when nothing plays.
   *  The puppet reads it every frame to open the mouth by that much. */
  level(): number {
    return this.playing ? this.rms() : 0;
  }

  dispose() {
    this.stop();
    cancelAnimationFrame(this.raf);
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
