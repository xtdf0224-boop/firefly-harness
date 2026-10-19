/* A small, safe Markdown renderer for report artifacts. It parses to a block tree and builds React
   elements directly (no HTML strings, no dangerouslySetInnerHTML), so nothing in the source can
   inject markup. Supported: headings 1–3, paragraphs, ordered / unordered (nested) lists,
   blockquotes, fenced code, tables with a header row, horizontal rules, inline `code`, **bold**,
   *italic* and http(s) / mailto links. Everything else is shown as plain text. */
import { createElement, Fragment, useMemo, type ReactNode } from 'react';
import { CodeBlock } from '../ui';
import { isCjk } from './shared';

type Align = 'left' | 'center' | 'right' | undefined;

type Block =
  | { t: 'heading'; level: 1 | 2 | 3; text: string }
  | { t: 'para'; text: string }
  | { t: 'code'; lang: string; code: string }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; head: string[]; align: Align[]; rows: string[][] }
  | { t: 'hr' };

interface ListItem { text: string; children: Block[] }

/* ───────────── block parser ───────────── */

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;

/** Join the lines of a paragraph. A line break between two CJK characters (or next to CJK
 *  punctuation) must not turn into a space; between Latin words it does. */
function joinSoft(lines: string[]) {
  return lines.reduce((acc, line, i) => {
    if (i === 0) return line;
    const before = acc.slice(-1);
    const after = line.replace(/^[*_`[(]+/, '')[0]; // look past inline markers such as ** or `
    const fullwidthPunct = (ch?: string) => !!ch && /[\u3000-\u303f\uff00-\uffef]/.test(ch);
    const tight = (isCjk(before) && isCjk(after)) || fullwidthPunct(before) || fullwidthPunct(after);
    return acc + (tight ? '' : ' ') + line;
  }, '');
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function startsTable(src: string[], i: number) {
  return src[i].includes('|') && i + 1 < src.length && src[i + 1].includes('-') && TABLE_SEP.test(src[i + 1]);
}

function startsBlock(src: string[], i: number) {
  const line = src[i];
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || startsTable(src, i);
}

function parseList(src: string[], start: number): [Block, number] {
  const first = ITEM.exec(src[start])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: Array<{ text: string[]; sub: string[] }> = [];
  let i = start;
  while (i < src.length) {
    const line = src[i];
    if (!line.trim()) {
      // A blank line keeps the list going only if the next content still belongs to it.
      let j = i + 1;
      while (j < src.length && !src[j].trim()) j++;
      if (j >= src.length) break;
      const m = ITEM.exec(src[j]);
      const belongs = indentOf(src[j]) > base || (m && m[1].length === base && /\d/.test(m[2]) === ordered);
      if (!belongs) break;
      if (items.length) items[items.length - 1].sub.push('');
      i = j;
      continue;
    }
    const m = ITEM.exec(line);
    const indent = indentOf(line);
    if (m && m[1].length === base) {
      if (/\d/.test(m[2]) !== ordered) break;
      items.push({ text: [m[3]], sub: [] });
      i++;
      continue;
    }
    if (indent <= base && !(items.length && !m && !startsBlock(src, i))) break;
    const cur = items[items.length - 1];
    if (!cur) break;
    const rel = line.slice(Math.min(indent, base + 2));
    const opensBlock = ITEM.test(rel) || FENCE.test(rel) || QUOTE.test(rel) || HEADING.test(rel);
    // An indented line right under the item text (no blank line, no new block) continues its paragraph.
    if (indent > base && (opensBlock || cur.sub.length > 0)) cur.sub.push(rel);
    else cur.text.push(line.trim());
    i++;
  }
  const numbered = ordered ? Number.parseInt(first[2], 10) : 1;
  return [{
    t: 'list', ordered, start: Number.isFinite(numbered) ? numbered : 1,
    items: items.map((it) => ({ text: joinSoft(it.text), children: parseBlocks(it.sub) })),
  }, i];
}

function parseBlocks(src: string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < src.length) {
    const line = src[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2];
      const body: string[] = [];
      i++;
      while (i < src.length && !src[i].trim().startsWith(marker)) {
        body.push(src[i].slice(Math.min(fence[1].length, indentOf(src[i]))));
        i++;
      }
      i++; // closing fence (or end of input)
      out.push({ t: 'code', lang: fence[3], code: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: 'heading', level: Math.min(heading[1].length, 3) as 1 | 2 | 3, text: heading[2] });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < src.length && QUOTE.test(src[i])) { inner.push(src[i].replace(/^\s{0,3}>\s?/, '')); i++; }
      out.push({ t: 'quote', blocks: parseBlocks(inner) });
      continue;
    }

    if (startsTable(src, i)) {
      const head = splitRow(line);
      const align: Align[] = splitRow(src[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined));
      const rows: string[][] = [];
      i += 2;
      while (i < src.length && src[i].trim() && src[i].includes('|')) { rows.push(splitRow(src[i])); i++; }
      out.push({ t: 'table', head, align, rows });
      continue;
    }

    if (ITEM.test(line)) {
      const [block, next] = parseList(src, i);
      out.push(block);
      i = next;
      continue;
    }

    const para = [line.trim()];
    i++;
    while (i < src.length && src[i].trim() && !startsBlock(src, i)) { para.push(src[i].trim()); i++; }
    out.push({ t: 'para', text: joinSoft(para) });
  }
  return out;
}

/* ───────────── inline renderer ───────────── */

// groups: 1–2 code span · 3 escaped char · 4 bold · 5 italic · 6–7 link text + href
const INLINE = /(`+)(.+?)\1|\\([\\`*_{}[\]()#+\-.!|>~])|\*\*(\S(?:.*?\S)?)\*\*|\*(\S(?:[^*]*?\S)?)\*|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/;

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyBase}-${n++}`;
    if (m[1] !== undefined) nodes.push(<code key={key} className="ws-md__code-inline">{m[2].trim()}</code>);
    else if (m[3] !== undefined) nodes.push(m[3]);
    else if (m[4] !== undefined) nodes.push(<strong key={key}>{inline(m[4], key)}</strong>);
    else if (m[5] !== undefined) nodes.push(<em key={key}>{inline(m[5], key)}</em>);
    else if (m[6] !== undefined) {
      nodes.push(SAFE_HREF.test(m[7])
        ? <a key={key} href={m[7]} target="_blank" rel="noopener noreferrer">{inline(m[6], key)}</a>
        : <Fragment key={key}>{inline(m[6], key)}</Fragment>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/* ───────────── block renderer ───────────── */

function renderBlocks(blocks: Block[], keyBase: string, headingBase: number): ReactNode[] {
  return blocks.map((b, i) => {
    const key = `${keyBase}-${i}`;
    switch (b.t) {
      case 'heading':
        return createElement(`h${Math.min(6, headingBase + b.level - 1)}`, { key, className: `ws-md__h ws-md__h${b.level}` }, inline(b.text, key));
      case 'para':
        return <p key={key}>{inline(b.text, key)}</p>;
      case 'code':
        return <CodeBlock key={key} className="ws-md__code" code={b.code} language={b.lang || 'text'} maxHeight={360} />;
      case 'quote':
        return <blockquote key={key}>{renderBlocks(b.blocks, key, headingBase)}</blockquote>;
      case 'hr':
        return <hr key={key} />;
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={`${key}-${j}`}>
            {inline(it.text, `${key}-${j}`)}
            {it.children.length > 0 && renderBlocks(it.children, `${key}-${j}`, headingBase)}
          </li>
        ));
        return b.ordered
          ? <ol key={key} role="list" start={b.start}>{items}</ol>
          : <ul key={key} role="list">{items}</ul>;
      }
      case 'table':
        return (
          <div key={key} className="ws-md__table" role="region" aria-label="表格" tabIndex={0}>
            <table>
              <thead>
                <tr>{b.head.map((c, j) => <th key={j} scope="col" style={{ textAlign: b.align[j] }}>{inline(c, `${key}-h${j}`)}</th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>{b.head.map((_, j) => <td key={j} style={{ textAlign: b.align[j] }}>{inline(row[j] ?? '', `${key}-${r}-${j}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** Renders Markdown as a readable document. `headingLevel` is the DOM level of a `#` heading
 *  (default h3, so the document sits under the page's own h1 / h2 without breaking the outline). */
export function Markdown({ source, headingLevel = 3, className }: { source: string; headingLevel?: number; className?: string }) {
  const blocks = useMemo(() => parseBlocks(source.replace(/\r\n?/g, '\n').split('\n')), [source]);
  return <article className={className ? `ws-md ${className}` : 'ws-md'}>{renderBlocks(blocks, 'md', headingLevel)}</article>;
}
