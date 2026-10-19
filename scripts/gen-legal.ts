/* npm run legal — writes DISCLAIMER.md and build/license.txt (the installer's licence page) from the
   same source as Settings › 免责声明与使用条款 (src/lib/terms.ts), plus the MIT licence for the code. */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_URL, TERMS, termsAsText } from '../src/lib/terms';

// npm scripts run from the package root (the bundled script lives in node_modules/.cache).
const at = (f: string) => path.join(process.cwd(), f);
const mit = fs.readFileSync(at('LICENSE'), 'utf8');

const md = [
  '# 免责声明与使用条款',
  '',
  '> 与应用内「设置 › 免责声明与使用条款」一致。安装或使用本软件即视为同意以下全部条款。',
  '',
  ...TERMS.flatMap((s) => [
    `## ${s.title}`,
    '',
    ...s.paragraphs.flatMap((p) => [p, '']),
    ...(s.items ?? []).map((i) => (i.href ? `- [${i.text}](${i.href})` : `- ${i.text}`)),
    ...(s.items ? [''] : []),
  ]),
].join('\n');
fs.writeFileSync(at('DISCLAIMER.md'), md);

const txt = [
  '萤火 · Agent 工作台 — 免责声明与使用条款',
  `项目主页：${REPO_URL}`,
  '',
  '安装前请阅读以下条款。点击「我同意」即表示您已阅读、理解并同意全部内容。',
  '',
  termsAsText(),
  '',
  '────────────────────────────────────────',
  '源代码许可证（仅适用于本项目的源代码，不适用于第 2 条所列第三方素材）',
  '',
  mit.trim(),
  '',
].join('\r\n').replace(/\r?\n/g, '\r\n');
fs.mkdirSync(at('build'), { recursive: true });
// UTF-8 with BOM so the NSIS licence page shows Chinese correctly.
fs.writeFileSync(at('build/license.txt'), '\uFEFF' + txt);
console.log('wrote DISCLAIMER.md and build/license.txt');
