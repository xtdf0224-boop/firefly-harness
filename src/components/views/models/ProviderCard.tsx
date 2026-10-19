/* One vendor on 模型接入: choose 「命令行登录」 or 「API 密钥」, set it up, test it.
   The key field is write-only — after saving, only its last four characters are ever shown. */
import { CheckCircle2, ExternalLink, KeyRound, LogIn, Pencil, Plug, RefreshCw, Star, Terminal, Trash2, XCircle } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { DRIVERS, readiness, regionOf, type ProviderInfo } from '../../../lib/providers';
import type { AuthMode, DriverId, ProviderConfig } from '../../../lib/types';
import { modelActions } from '../../../state/models';
import { useApp } from '../../../state/store';
import { Badge, Button, CopyButton, Segmented, cx } from '../../ui';

const AUTH_OPTIONS: Array<{ value: AuthMode; label: string; icon: typeof Terminal; hint: string }> = [
  { value: 'cli', label: '命令行登录', icon: Terminal, hint: '用官方命令行工具（Claude Code、Codex…）登录账号后驱动它' },
  { value: 'api', label: 'API 密钥', icon: KeyRound, hint: '用这家的 API Key 直接调用接口' },
];

function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`;
}

export function ProviderCard({ info, disabled }: { info: ProviderInfo; disabled: boolean }) {
  const cfg = useApp((s) => s.models.providers[info.id]);
  const isDefault = useApp((s) => s.models.defaultEngine === info.id);
  const [busy, setBusy] = useState<'' | 'test' | 'detect'>('');
  const auth = cfg.auth;
  const ready = readiness(info, cfg, auth);
  const tested = cfg.test && cfg.test.auth === auth && (auth === 'api' || cfg.test.driver === cfg.driver) ? cfg.test : undefined;
  const testing = !!tested && !tested.ok && tested.message === '测试中…';
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
        {auth === 'cli' ? <CliPane info={info} cfg={cfg} disabled={disabled} busy={busy === 'detect'} onDetect={() => run('detect')} /> : <ApiPane info={info} cfg={cfg} disabled={disabled} />}
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

function CliPane({ info, cfg, disabled, busy, onDetect }: { info: ProviderInfo; cfg: ProviderConfig; disabled: boolean; busy: boolean; onDetect: () => void }) {
  const ids = useId();
  const d = DRIVERS[cfg.driver];
  const cli = cfg.cli;
  // Codex lists the account's models itself; otherwise the catalog's suggestions.
  const live = useApp((s) => s.models.live?.[cfg.driver]);
  const cliModels = live?.length ? [{ id: '', note: '工具默认' }, ...live.map((m) => ({ id: m.id, note: m.note ?? m.label }))] : info.cliModels[cfg.driver] ?? [];
  const canLogin = d.auth === 'account' && (cfg.driver === 'claude-code' || cfg.driver === 'codex' || cfg.driver === 'kimi' || cfg.driver === 'mcode');
  return (
    <div className="model-pane">
      {info.drivers.length > 1 ? (
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-drv`}>命令行工具</label>
          <select id={`${ids}-drv`} className="select" value={cfg.driver} disabled={disabled}
            onChange={(e) => modelActions.set(info.id, { driver: e.target.value as DriverId })}>
            {info.drivers.map((id) => <option key={id} value={id}>{DRIVERS[id].label}{DRIVERS[id].auth === 'account' ? '（账号登录）' : '（用 API Key）'}</option>)}
          </select>
        </div>
      ) : (
        <p className="model-pane__driver"><Terminal size={14} aria-hidden /><strong>{d.label}</strong><span>{d.auth === 'account' ? '账号登录' : '用 API Key'}</span></p>
      )}
      <p className="model-pane__note">{d.note}</p>

      <div className={cx('model-cli', cli && (cli.found ? 'is-found' : 'is-missing'))}>
        <div className="model-cli__state">
          {!cli && <span className="model-card__muted">还没有检测</span>}
          {cli && !cli.found && <span><XCircle size={14} aria-hidden /> 没有找到 {d.bin}{cli.detail ? `：${cli.detail}` : ''}</span>}
          {cli?.found && (
            <span className="model-cli__found">
              <CheckCircle2 size={14} aria-hidden />
              <span className="mono truncate" title={cli.path}>{cli.version || d.bin}</span>
              {cli.login === 'yes' && <Badge tone="success">已登录{cli.account ? ` · ${cli.account}` : ''}</Badge>}
              {cli.login === 'no' && <Badge tone="warning">未登录</Badge>}
              {cli.login === 'unknown' && d.auth === 'account' && <Badge tone="neutral" title="这个工具不报告登录状态，测试一次连接即可确认">登录状态未知</Badge>}
            </span>
          )}
        </div>
        <div className="model-cli__actions">
          <Button size="sm" variant="ghost" icon={RefreshCw} busy={busy} disabled={disabled} onClick={onDetect}>检测</Button>
          {canLogin && cli?.found && <Button size="sm" variant={cli.login === 'no' ? 'primary' : 'ghost'} icon={LogIn} disabled={disabled} onClick={() => void modelActions.login(info.id)}>登录</Button>}
        </div>
      </div>
      {cli && !cli.found && (
        <p className="model-pane__install">
          <span>安装：</span><code className="mono">{d.install}</code>
          {d.install.startsWith('npm') && <CopyButton text={d.install} label="复制安装命令" />}
        </p>
      )}

      {d.auth === 'key' && <KeyField info={info} cfg={cfg} disabled={disabled} />}

      <div className="model-field">
        <label className="model-field__label" htmlFor={`${ids}-m`}>模型<span className="model-field__opt">（留空用工具默认）</span></label>
        <input id={`${ids}-m`} className="input mono" list={`${ids}-ml`} value={cfg.cliModel} disabled={disabled} spellCheck={false} autoComplete="off"
          placeholder={cliModels[0]?.note ?? '默认'} onChange={(e) => modelActions.set(info.id, { cliModel: e.target.value.trim() })} />
        <datalist id={`${ids}-ml`}>{cliModels.filter((m) => m.id).map((m) => <option key={m.id} value={m.id}>{m.note}</option>)}</datalist>
      </div>

      <details className="model-adv">
        <summary>高级</summary>
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-p`}>命令路径<span className="model-field__opt">（不在 PATH 里时填写）</span></label>
          <input id={`${ids}-p`} className="input mono" value={cfg.cliPath} disabled={disabled} spellCheck={false} autoComplete="off"
            placeholder={`例如 C:\\…\\${d.bin}.cmd`} onChange={(e) => modelActions.set(info.id, { cliPath: e.target.value.trim() })} />
        </div>
        {cfg.driver === 'codex' && (
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-sb`}>Codex 沙箱</label>
            <select id={`${ids}-sb`} className="select" value={cfg.codexSandbox ?? 'workspace-write'} disabled={disabled}
              onChange={(e) => modelActions.set(info.id, { codexSandbox: e.target.value as ProviderConfig['codexSandbox'] })}>
              <option value="workspace-write">工作文件夹内可写（推荐）</option>
              <option value="danger-full-access">不使用沙箱（Windows 沙箱起不来时才用，Codex 可以在整台电脑上执行命令）</option>
            </select>
          </div>
        )}
      </details>
    </div>
  );
}

/* ───────────── API ───────────── */

function ApiPane({ info, cfg, disabled }: { info: ProviderInfo; cfg: ProviderConfig; disabled: boolean }) {
  const ids = useId();
  const region = regionOf(info, cfg);
  return (
    <div className="model-pane">
      {info.regions.length > 1 && (
        <div className="model-field">
          <span className="model-field__label" id={`${ids}-r`}>服务地区</span>
          <Segmented<string> size="sm" label="服务地区" options={info.regions.map((r) => ({ value: r.id, label: r.label }))} value={cfg.region}
            onChange={(v) => modelActions.set(info.id, { region: v })} />
        </div>
      )}
      <KeyField info={info} cfg={cfg} disabled={disabled} />
      <div className="model-field">
        <label className="model-field__label" htmlFor={`${ids}-m`}>模型</label>
        <input id={`${ids}-m`} className="input mono" list={`${ids}-ml`} value={cfg.model} disabled={disabled} spellCheck={false} autoComplete="off"
          onChange={(e) => modelActions.set(info.id, { model: e.target.value.trim() })} />
        <datalist id={`${ids}-ml`}>{info.models.map((m) => <option key={m.id} value={m.id}>{m.note}</option>)}</datalist>
      </div>
      <details className="model-adv">
        <summary>高级</summary>
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-u`}>服务地址<span className="model-field__opt">（留空用官方地址）</span></label>
          <input id={`${ids}-u`} className="input mono" value={cfg.baseUrl} disabled={disabled} spellCheck={false} autoComplete="off"
            placeholder={region.baseUrl} onChange={(e) => modelActions.set(info.id, { baseUrl: e.target.value.trim() })} />
        </div>
      </details>
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
