/* The hidden capture page (dist/capture.html, docs/PET.md §1). The desktop side (electron/pet/capture.cjs)
   picks the game window; this page records it with getDisplayMedia, judges the picture locally with
   SceneAnalyzer (twice a second, on a 64x36 thumbnail) and exports a JPEG / PNG of the latest frame only
   when asked. No pixel leaves the page except through those answers. */
import { SceneAnalyzer, THUMB_H, THUMB_W, lumaFromRGBA } from './analyze';

interface CaptureBridge {
  ready(): void;
  state(s: { gen: number; live: boolean; error?: string; width?: number; height?: number }): void;
  scene(e: { gen: number; state: string; since: number; change: number }): void;
  result(r: { id: string; ok: boolean; data?: Uint8Array; width?: number; height?: number }): void;
  onCommand(fn: (c: { op: string; gen?: number }) => void): () => void;
  onGrab(fn: (r: { id: string; kind: 'jpeg' | 'png'; maxSide: number; quality: number }) => void): () => void;
}

/** MediaStreamTrackProcessor is in Chromium but not in every lib.dom. */
interface TrackProcessorCtor { new (init: { track: MediaStreamTrack }): { readable: ReadableStream<VideoFrame> } }

const bridge = (window as unknown as { fireflyCapture?: CaptureBridge }).fireflyCapture;
const TICK_MS = 500;

/** Where pixels come from: the newest decoded frame of the captured window. */
interface Source {
  /** A frame arrived since the last sample. */
  fresh: boolean;
  size(): { w: number; h: number } | null;
  draw(ctx: CanvasRenderingContext2D, w: number, h: number): boolean;
  close(): void;
}

function frameSource(track: MediaStreamTrack, Processor: TrackProcessorCtor): Source {
  const reader = new Processor({ track }).readable.getReader();
  let latest: VideoFrame | null = null;
  let stopped = false;
  const src: Source = {
    fresh: false,
    size: () => (latest ? { w: latest.displayWidth, h: latest.displayHeight } : null),
    draw(ctx, w, h) {
      if (!latest) return false;
      ctx.drawImage(latest, 0, 0, w, h);
      return true;
    },
    close() {
      stopped = true;
      reader.cancel().catch(() => {});
      latest?.close();
      latest = null;
    },
  };
  void (async () => {
    // Keep exactly one frame: a captured frame holds a buffer the capture pipeline is waiting to get back.
    while (!stopped) {
      const res = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      const value = res.value;
      // A frame that arrives after close() (or ends the stream) has no owner: give it back right here.
      if (res.done || !value || stopped) { value?.close(); break; }
      latest?.close();
      latest = value;
      src.fresh = true;
    }
  })();
  return src;
}

function videoSource(stream: MediaStream): Source {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  void video.play().catch(() => {});
  const src: Source = {
    fresh: false,
    size: () => (video.videoWidth ? { w: video.videoWidth, h: video.videoHeight } : null),
    draw(ctx, w, h) {
      if (!video.videoWidth) return false;
      ctx.drawImage(video, 0, 0, w, h);
      return true;
    },
    close() { video.pause(); video.srcObject = null; },
  };
  const tick = () => { src.fresh = true; if (video.srcObject) video.requestVideoFrameCallback(tick); };
  video.requestVideoFrameCallback(tick);
  return src;
}

interface Session {
  stream: MediaStream;
  source: Source;
  timer: number;
}

let session: Session | null = null;

/* Start and stop can overlap (getDisplayMedia takes a while, and the desktop side may stop or restart meanwhile).
   Every start and stop moves `epoch` forward; the desktop numbers them, so a message that arrives late is
   recognised. Whatever comes back from an await after the epoch moved is stale and ends its own stream. */
let epoch = 0;

/** Move the epoch to `gen` (one step when the desktop did not number it). False: `gen` is older than what was already seen. */
function advance(gen?: number): boolean {
  if (typeof gen === 'number' && Number.isFinite(gen)) {
    if (gen < epoch) return false;
    epoch = gen;
  } else {
    epoch++;
  }
  return true;
}

/** The size of the first frame, or null when none arrives within `ms`. */
async function firstFrame(s: Session, ms: number) {
  const until = performance.now() + ms;
  while (!s.source.size() && performance.now() < until && session === s) await new Promise((r) => setTimeout(r, 50));
  return s.source.size();
}

const thumb = document.createElement('canvas');
thumb.width = THUMB_W;
thumb.height = THUMB_H;
const thumbCtx = thumb.getContext('2d', { willReadFrequently: true })!;
const lumaBuf = new Uint8Array(THUMB_W * THUMB_H);

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((t) => t.stop());
}

/** End the running capture: timer, frame reader (and the frame it holds), tracks. */
function teardown() {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(s.timer);
  s.source.close();
  stopStream(s.stream);
}

function stopCommand(gen?: number) {
  if (advance(gen)) teardown();
}

async function start(gen: number): Promise<boolean> {
  if (!bridge || !advance(gen)) return false;
  teardown();
  const stale = () => epoch !== gen;
  let stream: MediaStream;
  try {
    // The desktop side answers with the one window it picked. Low frame rate: this is for judging, not for recording.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 4, max: 8 }, width: { max: 2560 }, height: { max: 1440 } },
      audio: false,
    });
  } catch (e) {
    const err = e as Error;
    if (!stale()) bridge.state({ gen, live: false, error: `${err.name}: ${err.message}` });
    return false;
  }
  // A stop (or a newer start) came in while the answer was on its way: this stream has no owner, end it.
  if (stale()) { stopStream(stream); return false; }
  try {
    const track = stream.getVideoTracks()[0];
    if (!track) { stopStream(stream); bridge.state({ gen, live: false, error: 'no video track' }); return false; }
    const Processor = (window as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor;
    let reader: Source | null = null;
    if (Processor) { try { reader = frameSource(track, Processor); } catch { reader = null; } }
    const analyzer = new SceneAnalyzer();
    const mine: Session = { stream, source: reader ?? videoSource(stream), timer: 0 };
    mine.timer = window.setInterval(() => {
      const now = performance.now();
      const source = mine.source;
      let luma: Uint8Array | null = null;
      if (source.fresh && source.draw(thumbCtx, THUMB_W, THUMB_H)) {
        source.fresh = false;
        luma = lumaFromRGBA(thumbCtx.getImageData(0, 0, THUMB_W, THUMB_H).data, lumaBuf);
      }
      const ev = analyzer.push(luma, now);
      if (ev && session === mine) bridge.scene({ gen, state: ev.state, since: ev.since, change: ev.change });
    }, TICK_MS);
    session = mine;
    // The window was closed or the capture was cut off: say so, the desktop side decides what to do.
    track.addEventListener('ended', () => {
      if (session === mine) { teardown(); bridge.state({ gen, live: false }); }
    });
    // Wait for the first frame so "live" means pixels are really coming. If the frame reader stays silent,
    // a <video> element gets the same stream a chance.
    let dims = await firstFrame(mine, reader ? 2500 : 4000);
    if (!dims && reader && session === mine) {
      mine.source.close();
      mine.source = videoSource(stream);
      dims = await firstFrame(mine, 4000);
    }
    // Stopped or replaced meanwhile: whoever did that already ended this session.
    if (session !== mine) return false;
    if (!dims) { teardown(); bridge.state({ gen, live: false, error: 'no frame arrived' }); return false; }
    bridge.state({ gen, live: true, width: dims.w, height: dims.h });
    return true;
  } catch (e) {
    // Whatever went wrong, nothing may keep running: end the session this call built (or just the stream).
    if (session && session.stream === stream) teardown(); else stopStream(stream);
    const err = e as Error;
    if (!stale()) bridge.state({ gen, live: false, error: `${err.name}: ${err.message}` });
    return false;
  }
}

function encode(canvas: HTMLCanvasElement, kind: 'jpeg' | 'png', quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, kind === 'png' ? 'image/png' : 'image/jpeg', kind === 'png' ? undefined : quality));
}

async function grab(r: { id: string; kind: 'jpeg' | 'png'; maxSide: number; quality: number }) {
  const s = session;
  const dims = s?.source.size();
  if (!bridge) return;
  if (!s || !dims) { bridge.result({ id: r.id, ok: false }); return; }
  const k = Math.min(1, r.maxSide / Math.max(dims.w, dims.h));
  const w = Math.max(1, Math.round(dims.w * k));
  const h = Math.max(1, Math.round(dims.h * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  if (!s.source.draw(ctx, w, h)) { bridge.result({ id: r.id, ok: false }); return; }
  const blob = await encode(canvas, r.kind, r.quality);
  if (!blob) { bridge.result({ id: r.id, ok: false }); return; }
  bridge.result({ id: r.id, ok: true, data: new Uint8Array(await blob.arrayBuffer()), width: w, height: h });
}

if (bridge) {
  // The desktop side starts a capture through this (it calls it with a user gesture, which getDisplayMedia needs).
  (window as unknown as { __petCapture: { start(gen: number): Promise<boolean> } }).__petCapture = { start };
  bridge.onCommand((c) => { if (c.op === 'stop') stopCommand(c.gen); });
  bridge.onGrab((r) => { void grab(r).catch(() => bridge.result({ id: r.id, ok: false })); });
  window.addEventListener('pagehide', teardown);
  bridge.ready();
}
