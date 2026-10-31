// The pet window's only door to the desktop: window.fireflyPet (PetWindowBridge in src/pet/contracts.ts).
// Everything it can ask for goes through channels the main process checks (electron/pet/index.cjs).
const { contextBridge, ipcRenderer } = require('electron');

/** One block of microphone samples is a few KiB; the main process drops anything bigger than this anyway. */
const MAX_MIC_BYTES = 64 * 1024;

/** Subscribe to a main → page channel; returns the unsubscribe function. */
function listen(channel, fn) {
  if (typeof fn !== 'function') return () => {};
  const handler = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('fireflyPet', {
  onCommand: (fn) => listen('pet-ui:command', fn),
  onState: (fn) => listen('pet-ui:state', fn),
  onLine: (fn) => listen('pet-ui:line', fn),
  onLineDelta: (fn) => listen('pet-ui:line-delta', fn),
  onAudio: (fn) => listen('pet-ui:audio', fn),
  onMood: (fn) => listen('pet-ui:mood', fn),
  onChat: (fn) => listen('pet-ui:chat', fn),
  /** The user's message from the chat panel (the panel stays open). */
  ask: (text) => ipcRenderer.send('pet-ui:ask', { text: String(text == null ? '' : text) }),
  /** The chat panel: the whole log, please / open it / the user closed it / the user clicked back into it. */
  chatSync: () => ipcRenderer.send('pet-ui:chat-sync'),
  chatOpen: () => ipcRenderer.send('pet-ui:chat-open'),
  chatClose: () => ipcRenderer.send('pet-ui:chat-close'),
  chatFocus: () => ipcRenderer.send('pet-ui:chat-focus'),
  hit: (over) => ipcRenderer.send('pet-ui:hit', !!over),
  drag: (phase, x, y) => ipcRenderer.send('pet-ui:drag', { phase, x, y }),
  menu: () => ipcRenderer.send('pet-ui:menu'),
  /** A click on the sprite that was not a drag. */
  click: () => ipcRenderer.send('pet-ui:click'),
  spoken: (lineId, state) => ipcRenderer.send('pet-ui:spoken', { lineId, state }),
  mic: (pcm) => { if (ArrayBuffer.isView(pcm) && pcm.byteLength > 0 && pcm.byteLength <= MAX_MIC_BYTES) ipcRenderer.send('pet-ui:mic', { pcm }); },
  /** 实时陪玩: the microphone could not be opened, or it stopped. The desktop ends the session and says why. */
  micFailed: () => ipcRenderer.send('pet-ui:mic-failed'),
});
