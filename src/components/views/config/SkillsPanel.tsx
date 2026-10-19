/* 技能 on 工具与连接: install your own skills (a folder with SKILL.md, the Claude Code / DeepSeek
   Harness format), turn them on or off, open, delete; plus the bundled examples and a template. */
import { AlertTriangle, BookOpen, FolderOpen, Plus, RefreshCw, Sparkles, Trash2, Upload } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { REPO_URL } from '../../../lib/terms';
import { skillActions } from '../../../state/skills';
import { useApp } from '../../../state/store';
import { Badge, Button, EmptyState, IconButton, Panel, Switch } from '../../ui';

const MODE_LABEL = { chat: '闲聊', work: '工作' } as const;

export function SkillsPanel() {
  const desktopOk = useApp((s) => s.models.desktop);
  const skills = useApp((s) => s.skills);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('my-skill');
  const id = useId();
  useEffect(() => { void skillActions.refresh(); }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (await skillActions.create(name.trim())) { setNaming(false); setName('my-skill'); }
  };

  const list = skills?.list ?? [];
  return (
    <Panel label="技能" title="自定义技能" icon={Sparkles} energy className="skills-panel"
      actions={desktopOk ? <IconButton icon={RefreshCw} size="sm" label="刷新技能列表" onClick={() => void skillActions.refresh()} /> : undefined}>
      <p className="skills-panel__lead">
        技能是一个带 <code>SKILL.md</code> 的文件夹：写清楚「什么时候用」和「怎么做」，接入模型时 Agent 会在合适的时候照着做，也可以带上脚本和参考资料。格式与 Claude Code、DeepSeek Harness 的技能相同，可以直接导入。
        <a href={`${REPO_URL}/blob/main/docs/SKILLS.md`} target="_blank" rel="noreferrer"><BookOpen size={12} aria-hidden />怎么写一个技能</a>
      </p>

      {!desktopOk ? (
        <p className="skills-panel__muted">技能需要桌面版。</p>
      ) : (
        <>
          <div className="skills-panel__actions">
            <Button size="sm" variant="primary" icon={Upload} onClick={() => void skillActions.import()}>导入技能</Button>
            <Button size="sm" variant="secondary" icon={Plus} onClick={() => setNaming((v) => !v)} aria-expanded={naming}>新建技能</Button>
            <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => void skillActions.installExamples()}>装入示例技能</Button>
            <Button size="sm" variant="ghost" icon={FolderOpen} onClick={() => skillActions.open()}>打开技能文件夹</Button>
          </div>
          {naming && (
            <form className="skills-panel__new" onSubmit={create}>
              <label htmlFor={`${id}-n`}>名称</label>
              <input id={`${id}-n`} className="input mono" value={name} maxLength={64} spellCheck={false} autoComplete="off" autoFocus
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
              <Button type="submit" size="sm" variant="primary" disabled={!/^[a-z0-9][a-z0-9-]*$/.test(name)}>创建并打开</Button>
              <span className="skills-panel__muted">小写字母、数字和连字符。会生成一份带说明的 SKILL.md 模板。</span>
            </form>
          )}

          {list.length === 0 ? (
            <EmptyState compact icon={Sparkles} title="还没有技能" body="导入一个，或先装入示例看看技能长什么样。" />
          ) : (
            <ul className="skills-list">
              {list.map((s) => (
                <li key={s.folder} className="skills-item" data-off={!s.enabled || undefined}>
                  <div className="skills-item__main">
                    <p className="skills-item__name">
                      <span className="mono">{s.name}</span>
                      {s.modes.map((m) => <Badge key={m} tone="neutral">{MODE_LABEL[m]}</Badge>)}
                      {s.version && <span className="skills-item__ver">v{s.version}</span>}
                    </p>
                    <p className="skills-item__desc">{s.description || '（没有说明）'}</p>
                    {s.error && <p className="skills-item__err"><AlertTriangle size={12} aria-hidden />{s.error}</p>}
                  </div>
                  <div className="skills-item__tools">
                    <Switch label={`启用 ${s.name}`} checked={s.enabled && !s.error} disabled={!!s.error} onChange={(v) => void skillActions.setEnabled(s.folder, v)} />
                    <IconButton icon={FolderOpen} size="sm" label={`打开 ${s.name} 的文件夹`} onClick={() => skillActions.open(s.folder)} />
                    <IconButton icon={Trash2} size="sm" label={`删除 ${s.name}`} onClick={() => void skillActions.remove(s.folder)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="skills-panel__muted">
            只导入你信任的技能：技能可以让 Agent 运行其中的脚本（运行前仍会按「工具策略」征求确认）。通过 API 接入的模型只读技能说明，不能运行脚本。
          </p>
        </>
      )}
    </Panel>
  );
}
