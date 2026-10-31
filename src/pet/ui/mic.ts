/* The microphone for 实时陪玩: 16 kHz mono 16-bit PCM, sent to the desktop in small blocks. Only runs while
   the session is on (the pet window's only permission is the microphone, see electron/pet/window.cjs).
   ScriptProcessorNode is deprecated but is the one thing that works under this page's CSP (an
   AudioWorklet module would need script-src blob:). */

export interface Mic { stop(): void }

/** `onEnded`: the microphone stopped by itself later (unplugged, disabled, taken by another program). */
export async function startMic(send: (pcm: Int16Array) => void, onEnded?: () => void): Promise<Mic | null> {
  let stream: MediaStream;
  // 'all' asks Chromium to cancel everything the computer plays (the game too, through the system's loopback), not
  // only this page's own sound; where that is not offered it falls back to the usual cancellation. Gain control is off
  // so the level the turn detection sees does not pump up and down.
  const wide = { channelCount: 1, echoCancellation: { ideal: 'all' }, noiseSuppression: true, autoGainControl: false } as unknown as MediaTrackConstraints;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: wide });
  } catch {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch { return null; }
  }
  let ctx: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode;
  let node: ScriptProcessorNode;
  let mute: GainNode;
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    source = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(2048, 1, 1);
    mute = ctx.createGain();
    mute.gain.value = 0;
    node.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(input[i] * 32767)));
      send(pcm);
    };
    source.connect(node);
    // A processor node only runs while connected onward; the gain keeps the microphone out of the speakers.
    node.connect(mute);
    mute.connect(ctx.destination);
  } catch {
    // The microphone is open: let it go (or its light stays on) and report that there is none.
    stream.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => {});
    return null;
  }
  const open = ctx;
  stream.getAudioTracks().forEach((t) => { t.onended = () => onEnded?.(); });
  return {
    stop() {
      node.onaudioprocess = null;
      try { source.disconnect(); node.disconnect(); mute.disconnect(); } catch { /* gone */ }
      stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
      void open.close().catch(() => {});
    },
  };
}
