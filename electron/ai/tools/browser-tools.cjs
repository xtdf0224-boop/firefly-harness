// The 萤火浏览器 as tools for the API loop: the same nine tools the CLI agents get from browser-mcp.cjs (same
// names and parameters; the descriptions are in Chinese for the model), called in-process through browser.cjs'
// own queue, so they share its one-action-at-a-time order, its 60 second limit and the toolbar's "Agent 在操作".
// A browser action cannot be interrupted once it has started (60 seconds at most).
// Plain Node can load this file: browser.cjs is only required when a tool is called.
'use strict';

const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space'];
const DISPLAY_CHARS = 6000;

const ref = { type: 'integer', description: '元素编号：最近一次 browser_snapshot 里 [ref=N] 的 N（例如 12）。页面变化后编号会变，要重新读取。' };
const element = { type: 'string', description: '用几个字说明要操作的元素，例如「登录按钮」。只是备注，实际操作的是 ref 指向的那个元素。' };
const none = { type: 'object', properties: {} };

/** toolId: the category the tool policy uses (read tools can run on their own; act tools change what the page does). */
const DEFS = [
  { name: 'browser_navigate', toolId: 'browser_act', description: '在萤火浏览器窗口里打开一个网页（http / https），并返回页面快照。网址直接写成本机或内网地址（localhost、127.0.0.1、192.168.x.x 等）的打不开；域名在打开前会在本机查一次解析结果，指向这些地址的也打不开。', parameters: { type: 'object', properties: { url: { type: 'string', description: '要打开的网址。' } }, required: ['url'] } },
  { name: 'browser_snapshot', toolId: 'browser_read', description: '读取当前页面：标题、网址、可以操作的元素（带 ref 编号）和可见文字。页面变化后要再读一次。', parameters: none },
  { name: 'browser_click', toolId: 'browser_act', description: '按 ref 点击页面元素（ref 来自 browser_snapshot），返回新的快照。', parameters: { type: 'object', properties: { ref, element }, required: ['ref', 'element'] } },
  { name: 'browser_type', toolId: 'browser_act', description: '按 ref 往输入框、文本区或可编辑元素里输入文字。默认先清空原有内容（clear=false 则不清）；submit=true 则输入后按回车。不能往密码、银行卡、验证码输入框里输入；点名的元素自己拿不到焦点时也不会输入，要点名真正的输入框。', parameters: { type: 'object', properties: { ref, element, text: { type: 'string', description: '要输入的文字（最多 20000 字）。' }, clear: { type: 'boolean', description: '输入前是否清空，默认 true。' }, submit: { type: 'boolean', description: '输入后是否按回车，默认 false。' } }, required: ['ref', 'element', 'text'] } },
  { name: 'browser_press', toolId: 'browser_act', description: '在页面里按一个键。', parameters: { type: 'object', properties: { key: { type: 'string', enum: KEYS, description: '键名。' } }, required: ['key'] } },
  { name: 'browser_scroll', toolId: 'browser_read', description: '向上或向下滚动一屏，返回新的快照。', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'], description: '滚动方向。' } }, required: ['direction'] } },
  { name: 'browser_back', toolId: 'browser_act', description: '回到上一个页面。', parameters: none },
  { name: 'browser_screenshot', toolId: 'browser_read', description: '截取页面当前可见的部分（PNG）。', parameters: none },
  { name: 'browser_wait', toolId: 'browser_read', description: '等几秒（0.2 到 10）让页面完成加载或动画，然后返回快照。', parameters: { type: 'object', properties: { seconds: { type: 'number', description: '等待的秒数，0.2 到 10。' } }, required: ['seconds'] } },
];
const BY_NAME = new Map(DEFS.map((d) => [d.name, d]));

/** What a person is told when the model tries to type into a field it must not. */
const SECRET_REFUSAL = '不能替你在密码、银行卡或验证码输入框里输入。';

let browserApi = null;
const browser = () => {
  if (!browserApi) browserApi = _internals.browser();
  return browserApi;
};

const fail = (message) => ({ ok: false, output: message, display: message });
const clip = (s) => (s.length > DISPLAY_CHARS ? `${s.slice(0, DISPLAY_CHARS - 20)}\n…（卡片里只显示开头）` : s);

/** What the page says the element with this ref is: { tag, role, label, type, autocomplete, url, secret }, or null (no page, or no such element). */
async function describe(refNumber) {
  try { return await browser().describeRef(refNumber); } catch { return null; }
}

const ROLE_NAMES = {
  button: '按钮', link: '链接', textbox: '输入框', checkbox: '复选框', radio: '单选框', combobox: '下拉框', tab: '标签页', menuitem: '菜单项', option: '选项', clickable: '可点击的元素',
};
const roleName = (role) => ROLE_NAMES[role] || role || '元素';

/** The ref of an input, as a whole number ≥ 1, or null. */
const refOf = (input) => {
  const n = Number(input && input.ref);
  return Number.isInteger(n) && n >= 1 ? n : null;
};

/**
 * The line for the approval card: what the element really is, read from the page (not what the model said it
 * is), and where. `info` is describe()'s answer.
 */
function reasonFor(name, input, info) {
  const where = info && info.url ? `（页面 ${info.url}）` : '';
  const target = info ? `${roleName(info.role)}「${info.label || '无文字'}」` : null;
  if (name === 'browser_click') return target ? `点击：${target}${where}` : `点击 ref=${refOf(input) ?? '?'}（在当前页面上没有找到这个元素，页面可能已经变化）`;
  if (name === 'browser_type') {
    const text = typeof input.text === 'string' ? input.text : '';
    const how = `${input.clear === false ? '' : '先清空，'}输入 ${text.length} 字${input.submit ? '，然后按回车' : ''}`;
    return target ? `${how}：${target}${where}` : `${how}：ref=${refOf(input) ?? '?'}（在当前页面上没有找到这个元素）`;
  }
  if (name === 'browser_navigate') return `打开网页：${String(input.url || '')}`;
  if (name === 'browser_press') return `按键：${String(input.key || '')}`;
  return '';
}

/**
 * Run one browser tool. `input` is what the loop validated; only the known fields are used. → { ok, output, display, image? }
 * (image: { mime, data } for a screenshot.) Never rejects.
 */
async function call(name, input) {
  if (!BY_NAME.has(name)) return fail(`未知的浏览器工具：${name}`);
  const given = input && typeof input === 'object' ? input : {};
  const args = {};
  if (name === 'browser_navigate') args.url = String(given.url ?? '');
  if (name === 'browser_click' || name === 'browser_type') {
    const n = refOf(given);
    if (n === null) return fail('需要 ref（先用 browser_snapshot 获取）。');
    args.ref = n;
    args.element = String(given.element ?? '');
  }
  if (name === 'browser_type') {
    args.text = String(given.text ?? '');
    if (given.clear !== undefined && given.clear !== null) args.clear = given.clear !== false;
    args.submit = given.submit === true;
    // Asked again now, at the moment of typing: the page may have changed since the card was shown.
    const target = await describe(args.ref);
    if (target && target.secret) return fail(SECRET_REFUSAL);
  }
  if (name === 'browser_press') args.key = String(given.key ?? '');
  if (name === 'browser_scroll') args.direction = given.direction === 'up' ? 'up' : 'down';
  if (name === 'browser_wait') args.seconds = Number(given.seconds);
  let result;
  try { result = await browser().runQueued(name, args); } catch (e) { return fail(`浏览器出错：${String(e && e.message || e)}`); }
  const parts = result && Array.isArray(result.content) ? result.content : [];
  const text = parts.filter((p) => p && p.type === 'text').map((p) => String(p.text)).join('\n');
  const shot = parts.find((p) => p && p.type === 'image' && p.data);
  const out = { ok: !(result && result.isError), output: text || (shot ? '（截图见下）' : ''), display: '' };
  out.display = clip(text || (shot ? '截图' : ''));
  if (shot) out.image = { mime: shot.mimeType || 'image/png', data: shot.data };
  return out;
}

// Swapped by checks.
const _internals = { browser: () => require('../browser.cjs') };

module.exports = { DEFS, call, describe, reasonFor, roleName, SECRET_REFUSAL, KEYS, _internals };
