#!/usr/bin/env node
// Word stats for text files — part of the word-stats example skill.
// Usage: node word_stats.mjs <file> [file …]   → one line of JSON: per-file stats, then the total.
// Reads only; never writes.
import { readFileSync, statSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('用法：node word_stats.mjs <文件> [文件 …]');
  process.exit(2);
}

const CJK = /[㐀-鿿豈-﫿\u{20000}-\u{2fa1f}]/gu;
const WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

function stats(text) {
  const cjk = (text.match(CJK) || []).length;
  const words = (text.match(WORD) || []).length;
  return { chars: cjk + words, cjk, words, lines: text === '' ? 0 : text.split(/\r?\n/).length };
}

const results = [];
const total = { file: '合计', chars: 0, cjk: 0, words: 0, lines: 0 };
for (const file of files) {
  try {
    if (statSync(file).size > 50 * 1024 * 1024) { results.push({ file, error: '文件太大（超过 50 MB）' }); continue; }
    const s = stats(readFileSync(file, 'utf8'));
    results.push({ file, ...s });
    for (const k of ['chars', 'cjk', 'words', 'lines']) total[k] += s[k];
  } catch (e) {
    results.push({ file, error: e.code === 'ENOENT' ? '找不到文件' : e.message });
  }
}
results.push(total);
console.log(JSON.stringify(results));
