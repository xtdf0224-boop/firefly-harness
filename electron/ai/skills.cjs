// 技能 (skills): folders the user adds to <userData>/skills, each with a SKILL.md (frontmatter
// `name` + `description`, optional `modes`) and any scripts or reference files it needs. The same
// format as Claude Code / DeepSeek Harness skills, so theirs import as they are.
const { app, dialog, shell, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_MD = 200 * 1024;
const MAX_BODY_CHARS = 40_000;
const MAX_FILES = 500;
const MAX_BYTES = 20 * 1024 * 1024;

function root() {
  const dir = path.join(app.getPath('userData'), 'skills');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const stateFile = () => path.join(root(), '.state.json');
function readState() {
  try { const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); return { disabled: Array.isArray(s.disabled) ? s.disabled : [] }; } catch { return { disabled: [] }; }
}
function writeState(s) {
  try { fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2), 'utf8'); } catch { /* best effort */ }
}

/* ───────────── SKILL.md frontmatter (a small YAML subset) ───────────── */

function unquote(v) {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Parse `---` frontmatter: scalars, quoted strings, [a, b] lists, `- item` lists, `|` / `>` blocks. */
function parseSkillMd(text) {
  const src = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = src.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { meta: {}, body: src.trim(), error: 'SKILL.md 开头缺少 --- 包起来的 name / description' };
  const meta = {};
  const lines = m[1].split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2];
    if (val === '|' || val === '>' || val === '|-' || val === '>-') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === '')) block.push(lines[++i].trim());
      meta[key] = val.startsWith('>') ? block.join(' ').trim() : block.join('\n').trim();
    } else if (val === '') {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) items.push(unquote(lines[++i].replace(/^\s*-\s+/, '')));
      meta[key] = items.length ? items : '';
    } else if (/^\[.*\]$/.test(val.trim())) {
      meta[key] = val.trim().slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else {
      meta[key] = unquote(val);
    }
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

function describe(dir, folder, disabled) {
  const file = path.join(dir, 'SKILL.md');
  const out = { folder, name: folder, description: '', modes: ['chat', 'work'], dir, skillFile: file, enabled: !disabled.includes(folder), body: '' };
  let text;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_SKILL_MD) return { ...out, error: `SKILL.md 超过 ${MAX_SKILL_MD / 1024} KB` };
    text = fs.readFileSync(file, 'utf8');
  } catch { return { ...out, error: '没有 SKILL.md' }; }
  const { meta, body, error } = parseSkillMd(text);
  const modes = (Array.isArray(meta.modes) ? meta.modes : typeof meta.modes === 'string' && meta.modes ? [meta.modes] : ['chat', 'work'])
    .map((x) => String(x).toLowerCase()).filter((x) => x === 'chat' || x === 'work');
  return {
    ...out,
    name: typeof meta.name === 'string' && meta.name ? meta.name.slice(0, 64) : folder,
    description: typeof meta.description === 'string' ? meta.description.slice(0, 600) : '',
    modes: modes.length ? modes : ['chat', 'work'],
    version: typeof meta.version === 'string' ? meta.version.slice(0, 20) : undefined,
    author: typeof meta.author === 'string' ? meta.author.slice(0, 60) : undefined,
    body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n…（正文过长，已截断）` : body,
    error: error || (!meta.description ? 'SKILL.md 缺少 description（Agent 靠它判断什么时候用这个技能）' : undefined),
  };
}

function list() {
  const r = root();
  const { disabled } = readState();
  const skills = [];
  for (const e of fs.readdirSync(r, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    skills.push(describe(path.join(r, e.name), e.name, disabled));
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { root: r, skills };
}

/* ───────────── copying folders (asar-aware: works from the packaged examples too) ───────────── */

function scan(src) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === '.git') continue; walk(p); }
      else if (e.isFile()) { files += 1; bytes += fs.statSync(p).size; }
      if (files > MAX_FILES || bytes > MAX_BYTES) throw new Error(`技能文件夹太大（最多 ${MAX_FILES} 个文件、${MAX_BYTES / 1024 / 1024} MB；node_modules 和 .git 不会被复制）`);
    }
  };
  walk(src);
  return { files, bytes };
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) { if (e.name === 'node_modules' || e.name === '.git') continue; copyDir(s, d); }
    else if (e.isFile()) fs.writeFileSync(d, fs.readFileSync(s));
  }
}

function folderNameFor(src) {
  let meta = {};
  try { meta = parseSkillMd(fs.readFileSync(path.join(src, 'SKILL.md'), 'utf8')).meta; } catch { /* checked by the caller */ }
  const fromMeta = typeof meta.name === 'string' ? meta.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : '';
  const fromDir = path.basename(src).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const name = (fromMeta || fromDir || 'skill').slice(0, 64);
  return NAME_RE.test(name) ? name : `skill-${Date.now().toString(36)}`;
}

/* Imports picked in the main-process dialog wait here for the page to confirm an overwrite —
   the page never hands us a path to copy from. */
const pending = new Map();

function finishImport(src, name) {
  const dest = path.join(root(), name);
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
  copyDir(src, dest);
  const { disabled } = readState();
  writeState({ disabled: disabled.filter((x) => x !== name) });
  return name;
}

async function importSkill(sender) {
  const win = BrowserWindow.fromWebContents(sender);
  const r = await dialog.showOpenDialog(win, {
    title: '导入技能：选择包含 SKILL.md 的文件夹，或直接选 SKILL.md 文件',
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'SKILL.md', extensions: ['md'] }],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  let src = r.filePaths[0];
  try {
    if (fs.statSync(src).isFile()) {
      if (path.basename(src).toLowerCase() !== 'skill.md') return { ok: false, error: '请选择名为 SKILL.md 的文件，或包含它的文件夹。' };
      src = path.dirname(src);
    }
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) return { ok: false, error: '这个文件夹里没有 SKILL.md。' };
    if (path.resolve(src).startsWith(path.resolve(root()))) return { ok: false, error: '这个技能已经在技能文件夹里了。' };
    scan(src);
    const name = folderNameFor(src);
    if (fs.existsSync(path.join(root(), name))) {
      const token = `imp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      pending.set(token, { src, name });
      setTimeout(() => pending.delete(token), 10 * 60_000);
      return { ok: false, conflict: name, token };
    }
    return { ok: true, name: finishImport(src, name) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function confirmImport(token) {
  const p = pending.get(String(token));
  if (!p) return { ok: false, error: '这次导入已经过期，请重新选择。' };
  pending.delete(String(token));
  try { return { ok: true, name: finishImport(p.src, p.name) }; } catch (e) { return { ok: false, error: e.message }; }
}

const TEMPLATE = (name) => `---
name: ${name}
description: 一句话说明这个技能做什么、什么时候该用它。Agent 只看到这句话来判断要不要用，所以写清楚触发场景，例如「当用户要写周报时使用」。
modes: [chat, work]
---

# ${name}

## 什么时候用

- 写下会触发这个技能的场景。

## 怎么做

1. 第一步……
2. 第二步……

## 可以用的文件

- 如果技能文件夹里有脚本或参考资料，在这里写清楚路径和用法，例如：
  运行 \`node scripts/hello.mjs <参数>\`（路径相对这个 SKILL.md 所在的文件夹）。

## 注意

- 写下必须遵守的规则，或不要做的事。
`;

function createSkill(rawName) {
  const name = String(rawName || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'my-skill';
  if (!NAME_RE.test(name)) return { ok: false, error: '名称只能用小写字母、数字和连字符。' };
  const dir = path.join(root(), name);
  if (fs.existsSync(dir)) return { ok: false, error: `已经有名为 ${name} 的技能了。` };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), TEMPLATE(name), 'utf8');
  return { ok: true, name, dir };
}

/** The examples shipped with the app (examples/skills in the repo). Existing skills are left alone. */
function installExamples() {
  const src = path.join(app.getAppPath(), 'examples', 'skills');
  const added = [];
  let entries = [];
  try { entries = fs.readdirSync(src, { withFileTypes: true }); } catch { return { ok: false, error: '没有找到自带的示例技能。' }; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dest = path.join(root(), e.name);
    if (fs.existsSync(dest)) continue;
    copyDir(path.join(src, e.name), dest);
    added.push(e.name);
  }
  return { ok: true, added };
}

function setEnabled(folder, enabled) {
  const { disabled } = readState();
  const next = disabled.filter((x) => x !== folder);
  if (!enabled) next.push(String(folder));
  writeState({ disabled: next });
  return true;
}

function folderPath(folder) {
  const f = String(folder || '');
  if (!f || f.includes('/') || f.includes('\\') || f.startsWith('.')) return null;
  const dir = path.join(root(), f);
  return fs.existsSync(dir) ? dir : null;
}

async function removeSkill(folder) {
  const dir = folderPath(folder);
  if (!dir) return { ok: false, error: '找不到这个技能。' };
  // To the Recycle Bin, so a mistake can be undone.
  await shell.trashItem(dir);
  return { ok: true };
}

module.exports = { list, importSkill, confirmImport, createSkill, installExamples, setEnabled, removeSkill, folderPath, root, parseSkillMd };
