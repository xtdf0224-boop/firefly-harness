/* 产物: list on the left, preview on the right (stacked when narrow). Reports render as a
   document, files and diffs as code. Download saves the text as a local file. */
import { Download, FileCode, FileDiff, FileText, Package, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { bytes, relative } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import type { Artifact } from '../../lib/types';
import { actions } from '../../state/actions';
import { shallow, useApp } from '../../state/store';
import { Button, CodeBlock, CopyButton, EmptyState, cx } from '../ui';
import { Markdown } from './Markdown';

const NO_ARTIFACTS: Artifact[] = [];

const KIND: Record<Artifact['kind'], { icon: LucideIcon; label: string }> = {
  report: { icon: FileText, label: '报告' },
  diff: { icon: FileDiff, label: '差异' },
  file: { icon: FileCode, label: '文件' },
};

const MIME: Array<[RegExp, string]> = [
  [/\.(md|markdown)$/i, 'text/markdown'],
  [/\.(diff|patch)$/i, 'text/x-diff'],
  [/\.json$/i, 'application/json'],
  [/\.(html?)$/i, 'text/plain'], // never offer HTML as something a browser might render
];

function download(a: Artifact) {
  const type = `${MIME.find(([re]) => re.test(a.name))?.[1] ?? 'text/plain'};charset=utf-8`;
  const url = URL.createObjectURL(new Blob([a.content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = a.name.replace(/[\\/:*?"<>|]+/g, '_');
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  actions.toast({ tone: 'info', title: '已开始下载', body: a.name });
}

const isMarkdown = (a: Artifact) => a.kind === 'report' && (!a.language || /^(md|markdown)$/i.test(a.language));

export function ArtifactsView({ runId }: { runId?: string }) {
  const run = useApp((s) => {
    const r = runId ? s.runs[runId] : undefined;
    return r ? { artifacts: r.artifacts, plan: r.plan } : undefined;
  }, shallow);
  const [pickedId, setPickedId] = useState<string>();
  const now = useNow(30_000);

  const artifacts = run?.artifacts ?? NO_ARTIFACTS;
  const stepTitles = useMemo(() => new Map((run?.plan ?? []).map((st) => [st.id, st.title])), [run?.plan]);

  if (!run || artifacts.length === 0) {
    return <EmptyState icon={Package} title="还没有产物" body="Agent 生成的文件、差异和报告会出现在这里。" />;
  }

  const selected = artifacts.find((a) => a.id === pickedId) ?? artifacts[0];
  const markdown = isMarkdown(selected);

  return (
    <div className="ws-arts">
      <div className="ws-arts__grid">
        <section className="ws-arts__list" aria-label="产物列表">
          <div className="ws-arts__listbar">
            <span className="label">共 {artifacts.length} 个产物</span>
          </div>
          <ul role="list">
            {artifacts.map((a) => {
              const kind = KIND[a.kind];
              const Icon = kind.icon;
              return (
                <li key={a.id}>
                  <button type="button" className="ws-art" aria-pressed={a.id === selected.id} onClick={() => setPickedId(a.id)}>
                    <span className="ws-art__icon" aria-hidden><Icon size={16} /></span>
                    <span className="ws-art__main">
                      <span className="ws-art__name">{a.name}</span>
                      <span className="ws-art__step">{kind.label} · {stepTitles.get(a.stepId) ?? '—'}</span>
                      <span className="ws-art__meta">{relative(a.createdAt, now)} · {bytes(a.content)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="ws-arts__preview" aria-label={`预览：${selected.name}`}>
          <header className="ws-arts__head">
            <div className="ws-arts__title">
              <h3>{selected.name}</h3>
              <p>{KIND[selected.kind].label} · {bytes(selected.content)}</p>
            </div>
            <div className="ws-arts__tools">
              {markdown && <CopyButton text={selected.content} label="复制 Markdown" />}
              <Button size="sm" icon={Download} onClick={() => download(selected)}>下载</Button>
            </div>
          </header>
          <div className={cx('ws-arts__content', markdown && 'is-doc')} tabIndex={0} role="region" aria-label="产物内容">
            {markdown ? (
              <Markdown source={selected.content} />
            ) : (
              <CodeBlock
                code={selected.content} language={selected.kind === 'diff' ? 'diff' : (selected.language ?? 'text')}
                caption={selected.name} maxHeight="none"
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
