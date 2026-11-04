/* One vendor on 模型接入: choose 「命令行登录」 or 「API 密钥」, set it up, pick its model and 推理强度, test it.
   The key field is write-only — after saving, only its last four characters are ever shown. */
import { CheckCircle2, Cpu, ExternalLink, Gauge, KeyRound, Layers, LogIn, Pencil, Plug, RefreshCw, Star, Terminal, Trash2, XCircle } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Effort } from '../../../lib/effort';
import { DRIVERS, contextOf, ctxLabel, isCodingPlan, isCustomBase, readiness, regionOf, type ProviderInfo } from '../../../lib/providers';
import type { AuthMode, DriverId, ModelState, ProviderConfig } from '../../../lib/types';
import { TESTING, choiceEfforts, cleanPath, defaultChoice, effortMenu, modelActions, modelOptions } from '../../../state/models';
import { useApp } from '../../../state/store';
import { Badge, Button, CopyButton, Segmented, cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';

const AUTH_OPTIONS: Array<{ value: AuthMode; label: string; icon: typeof Terminal; hint: string }> = [
  { value: 'cli', label: '命令行登录', icon: Terminal, hint: '用官方命令行工具（Claude Code、Codex…）登录账号后驱动它' },
  { value: 'api', label: 'API 密钥', icon: KeyRound, hint: '用这家的 API Key 直接调用接口；工作任务里，模型也能用萤火自己的工具读写文件、执行命令，按「工具与技能」的策略执行（写文件、执行命令默认先问你）' },
];

function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`;
}

export function ProviderCard({ info, disabled }: { info: ProviderInfo; disabled: boolean }) {
  const cfg = useApp((s) => s.models.providers[info.id]);
  const models = useApp((s) => s.models);
  // The vendor new tasks start with, as 「新建时默认使用」 shows it (the first ready one when none is set).
  const isDefault = useApp((s) => defaultChoice(s.models)?.provider === info.id);
  const [busy, setBusy] = useState<'' | 'test' | 'detect'>('');
  const auth = cfg.auth;
  const ready = readiness(info, cfg, auth);
  const tested = cfg.test && cfg.test.auth === auth && (auth === 'api' || cfg.test.driver === cfg.driver) ? cfg.test : undefined;
  const testing = !!tested && !tested.ok && tested.message === TESTING;
  const state = !ready.ready ? 'off' : tested?.ok ? 'ok' : tested && !testing ? 'error' : 'ready';
  const stateText = state === 'ok' ? '已连通' : state === 'error' ? '测试失败' : state === 'ready' ? '已配置' : '未接入';
  const stateTone = state === 'ok' ? 'success' : state === 'error' ? 'danger' : state === 'ready' ? 'info' : 'neutral';

  const run = async (kind: 'test' | 'detect') => {
    setBusy(kind);
    try { await (kind === 'test' ? modelActions.test(info.id, auth) : modelActions.detect(info.id)); } finally { setBusy(''); }
  };

  return (
    <article className={cx('panel model-card', `model-card--${state}`)} aria-labelledby={`model-${info.id}`} data-provider={info.id}>
      <header className="model-card__head">
        <span className="model-card__glyph" aria-hidden>{info.glyph}</span>
        <div className="model-card__title">
          <h2 id={`model-${info.id}`}>{info.name}</h2>
          <p>{info.vendor}</p>
        </div>
        <span className="model-card__badges">
          {isDefault && <Badge tone="running" title="新建闲聊和工作时默认选它"><Star size={11} aria-hidden />默认</Badge>}
          <Badge tone={stateTone}>{stateText}</Badge>
        </span>
      </header>

      <Segmented<AuthMode> size="sm" className="model-card__auth" label={`${info.name} 的接入方式`} options={AUTH_OPTIONS} value={auth}
        onChange={(v) => modelActions.set(info.id, { auth: v })} />

      <div className="model-card__body">
        {auth === 'cli'
          ? <CliPane info={info} cfg={cfg} models={models} disabled={disabled} busy={busy === 'detect'} onDetect={() => run('detect')} />
          : <ApiPane info={info} cfg={cfg} models={models} disabled={disabled} />}
      </div>

      <footer className="model-card__foot">
        <div className="model-card__result" role="status">
          {!ready.ready && <span className="model-card__muted">{ready.reason}</span>}
          {ready.ready && !tested && <span className="model-card__muted">已配置，建议测试一次连接。</span>}
          {tested && testing && <span className="model-card__muted">测试中…</span>}
          {tested && !testing && (
            <span className={cx('model-card__test', tested.ok ? 'is-ok' : 'is-bad')} title={tested.message}>
              {tested.ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}
              <span className="truncate">{tested.ok ? `连接正常 · ${(tested.ms / 1000).toFixed(1)} 秒 · ${tested.message}` : tested.message}</span>
              <span className="model-card__when">{ago(tested.at)}</span>
            </span>
          )}
        </div>
        <div className="model-card__actions">
          {!isDefault && ready.ready && <Button size="sm" variant="ghost" icon={Star} onClick={() => modelActions.setDefault(info.id)}>设为默认</Button>}
          <Button size="sm" variant="secondary" icon={Plug} busy={busy === 'test'} disabled={disabled || !ready.ready || !!busy} onClick={() => run('test')}>测试连接</Button>
        </div>
      </footer>
    </article>
  );
}

/* ───────────── 命令行 ───────────── */

function CliPane({ info, cfg, models, disabled, busy, onDetect }: { info: ProviderInfo; cfg: ProviderConfig; models: ModelState; disabled: boolean; busy: boolean; onDetect: () => void }) {
  const ids = useId();
  const d = DRIVERS[cfg.driver];
  const cli = cfg.cli;
  const canLogin = d.auth === 'account' && (cfg.driver === 'claude-code' || cfg.driver === 'codex' || cfg.driver === 'kimi' || cfg.driver === 'mcode');

  // Changing the tool resets the model to that tool's first suggestion (see modelActions.set), so the saved 强度 may no longer fit.
  const onDriver = (driver: DriverId) => {
    const model = info.cliModels[driver]?.[0]?.id ?? '';
    modelActions.set(info.id, { driver, ...effortReset(models, cfg, 'cli', driver, model) });
  };

  return (
    <div className="model-pane">
      {info.drivers.length > 1 ? (
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-drv`}>命令行工具</label>
          <MenuSelect<DriverId> variant="field" id={`${ids}-drv`} label="命令行工具" icon={Terminal} value={cfg.driver} disabled={disabled}
            options={info.drivers.map((id) => ({ value: id, label: DRIVERS[id].label, sub: DRIVERS[id].auth === 'account' ? '用账号登录' : '用这家的 API Key' }))}
            onChange={onDriver} />
        </div>
      ) : (
        <p className="model-pane__driver"><Terminal size={14} aria-hidden /><strong>{d.label}</strong><span>{d.auth === 'account' ? '账号登录' : '用 API Key'}</span></p>
      )}
      <p className="model-pane__note">{d.note}</p>

      <div className={cx('model-cli', cli && (cli.found ? 'is-found' : 'is-missing'))}>
        <div className="model-cli__state">
          {!cli && <span className="model-card__muted">还没有检测</span>}
          {cli && !cli.found && <span><XCircle size={14} aria-hidden /> {cli.path && cli.detail ? cli.detail : `没有找到 ${d.bin}${cli.detail ? `：${cli.detail}` : ''}`}</span>}
          {cli?.found && (
            <span className="model-cli__found">
              <CheckCircle2 size={14} aria-hidden />
              <span className="mono truncate" title={cli.path}>{cli.version || d.bin}</span>
              {cli.login === 'yes' && <Badge tone="success">已登录{cli.account ? ` · ${cli.account}` : ''}</Badge>}
              {cli.login === 'no' && <Badge tone="warning">未登录</Badge>}
              {cli.login === 'unknown' && d.auth === 'account' && <Badge tone="neutral" title="这个工具不报告登录状态，测试一次连接即可确认">登录状态未知</Badge>}
            </span>
          )}
          {cli?.found && cli.detail && <span className="model-card__muted">{cli.detail}</span>}
        </div>
        <div className="model-cli__actions">
          <Button size="sm" variant="ghost" icon={RefreshCw} busy={busy} disabled={disabled} onClick={onDetect}>检测</Button>
          {canLogin && cli?.found && <Button size="sm" variant={cli.login === 'no' ? 'primary' : 'ghost'} icon={LogIn} disabled={disabled} onClick={() => void modelActions.login(info.id)}>登录</Button>}
        </div>
      </div>
      {cli && !cli.found && !cli.path && (
        <p className="model-pane__install">
          <span>安装：</span><code className="mono">{d.install}</code>
          {d.install.startsWith('npm') && <CopyButton text={d.install} label="复制安装命令" />}
        </p>
      )}

      {d.auth === 'key' && <KeyField info={info} cfg={cfg} disabled={disabled} />}

      <ModelField info={info} cfg={cfg} models={models} auth="cli" disabled={disabled} />
      <EffortField info={info} cfg={cfg} models={models} auth="cli" disabled={disabled} />

      <details className="model-adv">
        <summary>高级</summary>
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-p`}>命令路径<span className="model-field__opt">（不在 PATH 里时填写）</span></label>
          <PathField id={`${ids}-p`} value={cfg.cliPath} disabled={disabled} onCommit={(cliPath) => modelActions.set(info.id, { cliPath })}
            placeholder={cfg.driver === 'dsh' ? '例如 D:\\DeepSeek Harness（它的安装文件夹）' : `例如 C:\\…\\${d.bin}.cmd`} />
        </div>
        {cfg.driver === 'codex' && (
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-sb`}>Codex 沙箱</label>
            <MenuSelect<NonNullable<ProviderConfig['codexSandbox']>> variant="field" id={`${ids}-sb`} label="Codex 沙箱" value={cfg.codexSandbox ?? 'workspace-write'} disabled={disabled}
              options={[
                { value: 'workspace-write', label: '工作文件夹内可写', sub: '推荐' },
                { value: 'danger-full-access', label: '不使用沙箱', sub: 'Windows 沙箱起不来时才用' },
              ]}
              onChange={(v) => modelActions.set(info.id, { codexSandbox: v })} />
            {cfg.codexSandbox === 'danger-full-access' && <p className="model-field__hint model-field__hint--warn">不使用沙箱时，Codex 可以在整台电脑上执行命令。</p>}
          </div>
        )}
      </details>
    </div>
  );
}

/** 命令路径: the text stays as typed (a path can hold spaces, and one typed at the end must not be trimmed away) and
 *  is saved cleaned up on Enter, on leaving the box, or after a pause in typing — each save re-detects the tool. */
const PATH_PAUSE_MS = 600;

function PathField({ id, value, disabled, placeholder, onCommit }: { id: string; value: string; disabled: boolean; placeholder: string; onCommit: (path: string) => void }) {
  const [draft, setDraft] = useState(value);
  const live = useRef({ draft, value, onCommit });
  live.current = { draft, value, onCommit };
  const timer = useRef<number | undefined>(undefined);

  const stop = () => { window.clearTimeout(timer.current); timer.current = undefined; };
  const commit = (raw: string) => {
    stop();
    const next = cleanPath(raw);
    if (next !== live.current.value) live.current.onCommit(next);
  };

  // A change that did not come from this box (the tool was switched, which clears the path) replaces what is typed.
  useEffect(() => {
    if (value === cleanPath(live.current.draft)) return;
    stop();
    setDraft(value);
  }, [value]);
  // Leaving while a pause is pending (the card closes, the way of connecting changes) still saves what was typed.
  useEffect(() => () => {
    if (timer.current !== undefined) commit(live.current.draft);
  }, []);

  return (
    <input id={id} className="input mono" value={draft} disabled={disabled} spellCheck={false} autoComplete="off" placeholder={placeholder}
      onChange={(e) => {
        setDraft(e.target.value);
        stop();
        timer.current = window.setTimeout(() => commit(e.target.value), PATH_PAUSE_MS);
      }}
      onBlur={() => { commit(draft); setDraft(cleanPath(draft)); }}
      onKeyDown={(e) => { if (e.key === 'Enter') { commit(draft); setDraft(cleanPath(draft)); } }} />
  );
}

/* ───────────── API ───────────── */

function ApiPane({ info, cfg, models, disabled }: { info: ProviderInfo; cfg: ProviderConfig; models: ModelState; disabled: boolean }) {
  const ids = useId();
  const region = regionOf(info, cfg);
  return (
    <div className="model-pane">
      {info.regions.length > 1 && (
        <div className="model-field">
          <span className="model-field__label">服务地区</span>
          <Segmented<string> size="sm" label="服务地区" options={info.regions.map((r) => ({ value: r.id, label: r.label }))} value={cfg.region}
            onChange={(v) => modelActions.set(info.id, { region: v })} />
          {isCodingPlan(info, cfg) && <p className="model-field__hint model-field__hint--warn">Coding Plan 的密钥按服务商条款只能在官方支持的编程工具里用；在工作任务里让模型调用工具可能被风控。</p>}
        </div>
      )}
      <KeyField info={info} cfg={cfg} disabled={disabled} />
      <ModelField info={info} cfg={cfg} models={models} auth="api" disabled={disabled} />
      <EffortField info={info} cfg={cfg} models={models} auth="api" disabled={disabled} />
      <details className="model-adv">
        <summary>高级</summary>
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-u`}>服务地址<span className="model-field__opt">（留空用官方地址）</span></label>
          <input id={`${ids}-u`} className="input mono" value={cfg.baseUrl} disabled={disabled} spellCheck={false} autoComplete="off"
            placeholder={region.baseUrl} onChange={(e) => modelActions.set(info.id, { baseUrl: e.target.value.trim() })} />
          {isCustomBase(info, cfg) && <p className="model-field__hint model-field__hint--warn">不是官方地址：工作任务里，这个地址的服务能看到模型读到的文件内容，所以每次工具调用都要先经你确认。</p>}
        </div>
      </details>
    </div>
  );
}

/* ───────────── 模型 / 推理强度 ───────────── */

/** Value of the 「自定义模型…」 entry; never a real model id. */
const CUSTOM = '__custom__';

/** The change that drops the saved 推理强度 when the new model (or tool) does not offer it. */
function effortReset(models: ModelState, cfg: ProviderConfig, auth: AuthMode, driver: DriverId | undefined, model: string): Partial<Pick<ProviderConfig, 'effort' | 'cliEffort'>> {
  const saved = auth === 'api' ? cfg.effort : cfg.cliEffort;
  if (!saved || choiceEfforts(models, { provider: cfg.id, auth, driver }, model).includes(saved)) return {};
  return auth === 'api' ? { effort: undefined } : { cliEffort: undefined };
}

/** What the model's context window is, for the line under the model menu. */
function contextNote(info: ProviderInfo, model: string, tool?: string) {
  if (!model) return tool ? { text: `${tool} 自己选模型，上下文窗口随模型而定` } : undefined;
  const ctx = contextOf(info, model);
  return ctx.known ? { text: ctxLabel(ctx.tokens), known: true } : { text: '没有收录这个模型的上下文窗口，按 1M 估算' };
}

/** 模型: the catalog (or the CLI's own list) as a menu, with 「自定义模型…」 for any other id. */
function ModelField({ info, cfg, models, auth, disabled }: { info: ProviderInfo; cfg: ProviderConfig; models: ModelState; auth: AuthMode; disabled: boolean }) {
  const ids = useId();
  const api = auth === 'api';
  const current = api ? cfg.model : cfg.cliModel;
  const driver = api ? undefined : cfg.driver;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const closed = useRef(false);

  useEffect(() => { if (custom) input.current?.focus(); }, [custom]);

  // The id typed earlier stays in the list (modelOptions adds it) so it is visible as the current value.
  const options = [
    ...modelOptions(models, { provider: info.id, auth, driver }).map((o) => ({ value: o.id, label: o.label, sub: o.id && o.id !== o.label ? o.id : undefined, meta: o.note })),
    { value: CUSTOM, label: '自定义模型…', sub: '输入这家支持的任意模型 ID', icon: Pencil },
  ];

  const commit = (next: string) => {
    if (next === current) return;
    modelActions.set(info.id, { ...(api ? { model: next } : { cliModel: next }), ...effortReset(models, cfg, auth, driver, next) });
  };
  const choose = (v: string) => {
    if (v === CUSTOM) { closed.current = false; setDraft(current); setCustom(true); return; }
    setCustom(false);
    commit(v);
  };
  // Enter or leaving the box keeps what was typed; Escape drops it. An API model cannot be empty.
  const finish = (keep: boolean) => {
    if (closed.current) return;
    closed.current = true;
    setCustom(false);
    const next = draft.trim();
    if (keep && (next || !api)) commit(next);
  };

  const note = contextNote(info, current, api ? undefined : DRIVERS[cfg.driver].label);
  return (
    <div className="model-field">
      <label className="model-field__label" htmlFor={`${ids}-m`}>模型{!api && <span className="model-field__opt">（不选就用工具默认）</span>}</label>
      <MenuSelect variant="field" id={`${ids}-m`} label="模型" icon={Cpu} value={custom ? CUSTOM : current} options={options} onChange={choose} disabled={disabled} minWidth={320} />
      {custom && (
        <input ref={input} className="input mono" aria-label="自定义模型 ID" value={draft} spellCheck={false} autoComplete="off" placeholder={`例如 ${info.models[0].id}`}
          onChange={(e) => setDraft(e.target.value)} onBlur={() => finish(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
          }} />
      )}
      {custom
        ? <p className="model-field__hint">输入模型 ID，按回车保存；按 Esc 放弃。</p>
        : note && <p className={cx('model-field__meta', note.known && 'is-known')}><Layers size={13} aria-hidden />{note.text}</p>}
    </div>
  );
}

/** 推理强度: the levels this model (or tool) offers, saved as the default for new tasks on this way. */
function EffortField({ info, cfg, models, auth, disabled }: { info: ProviderInfo; cfg: ProviderConfig; models: ModelState; auth: AuthMode; disabled: boolean }) {
  const ids = useId();
  const api = auth === 'api';
  const levels = choiceEfforts(models, { provider: info.id, auth, driver: api ? undefined : cfg.driver }, api ? cfg.model : cfg.cliModel);
  const saved = api ? cfg.effort : cfg.cliEffort;
  const value = saved && levels.includes(saved) ? saved : '';
  const set = (v: string) => {
    const effort = (v || undefined) as Effort | undefined;
    modelActions.set(info.id, api ? { effort } : { cliEffort: effort });
  };
  const caption = <>推理强度<span className="model-field__opt">（新建任务时的默认值）</span></>;
  return levels.length > 0 ? (
    <div className="model-field">
      <label className="model-field__label" htmlFor={`${ids}-e`}>{caption}</label>
      <MenuSelect variant="field" id={`${ids}-e`} label="推理强度" icon={Gauge} value={value} options={effortMenu(levels)} onChange={set} disabled={disabled} minWidth={260} />
    </div>
  ) : (
    <div className="model-field">
      <span className="model-field__label">{caption}</span>
      <p className="model-field__static"><Gauge size={14} aria-hidden />这个模型不能调节推理强度</p>
    </div>
  );
}

function KeyField({ info, cfg, disabled }: { info: ProviderInfo; cfg: ProviderConfig; disabled: boolean }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const show = !cfg.keyHint || editing;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    const done = await modelActions.saveKey(info.id, value.trim());
    setSaving(false);
    if (done) { setValue(''); setEditing(false); }
  };
  return (
    <div className="model-field">
      <span className="model-field__label" id={`${id}-l`}>{info.name} API Key</span>
      {show ? (
        <form className="model-key" onSubmit={save}>
          <input className="input mono" type="password" aria-labelledby={`${id}-l`} value={value} disabled={disabled} autoComplete="off" spellCheck={false}
            placeholder="粘贴密钥" onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" size="sm" variant="primary" busy={saving} disabled={disabled || !value.trim()}>保存</Button>
          {cfg.keyHint && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(''); }}>取消</Button>}
        </form>
      ) : (
        <div className="model-key model-key--saved">
          <KeyRound size={14} aria-hidden />
          <span className="mono">已保存 {cfg.keyHint}</span>
          <Button size="sm" variant="ghost" icon={Pencil} disabled={disabled} onClick={() => setEditing(true)}>更换</Button>
          <Button size="sm" variant="ghost" icon={Trash2} disabled={disabled} onClick={() => void modelActions.clearKey(info.id)}>删除</Button>
        </div>
      )}
      <p className="model-field__hint">
        {info.keyHelp}{' '}
        <a href={info.keyUrl} target="_blank" rel="noreferrer">去获取密钥<ExternalLink size={11} aria-hidden /></a>
      </p>
    </div>
  );
}
