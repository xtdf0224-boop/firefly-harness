// 萤火浏览器 toolbar: back / forward / reload / home and the address bar. Talks to the main process
// only through window.ffBar (bar-preload.cjs).
const $ = (id) => document.getElementById(id);
const url = $('url');
let editing = false;

url.addEventListener('focus', () => { editing = true; url.select(); });
url.addEventListener('blur', () => { editing = false; });
url.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { url.blur(); window.ffBar.refresh(); }
  // Tab from the address bar continues into the page (the two are separate views).
  if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); window.ffBar.focusPage(); }
});
window.ffBar.onFocusUrl(() => { url.focus(); url.select(); });
$('go').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = url.value.trim();
  if (!text) return;
  url.blur();
  window.ffBar.navigate(text);
});
$('back').addEventListener('click', () => window.ffBar.back());
$('forward').addEventListener('click', () => window.ffBar.forward());
$('reload').addEventListener('click', () => window.ffBar.reload());
$('home').addEventListener('click', () => window.ffBar.home());

window.ffBar.onState((s) => {
  if (!editing) url.value = s.url || '';
  $('back').disabled = !s.canGoBack;
  $('forward').disabled = !s.canGoForward;
  $('loading').classList.toggle('on', !!s.loading);
  $('lock').classList.toggle('secure', /^https:/i.test(s.url || ''));
  $('msg').textContent = s.message || '';
  $('msg').title = s.message || '';
  $('agent').classList.toggle('on', !!s.agent);
  $('agentText').textContent = s.agent ? `Agent 正在操作：${s.agent}` : 'Agent 正在操作';
});
window.ffBar.refresh();
