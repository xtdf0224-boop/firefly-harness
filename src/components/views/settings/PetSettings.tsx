/* 桌宠 settings (docs/PET.md §2): one panel on the 设置 page. Everything is plain PetSettings in the
   store except the voice-service keys, which go straight to the desktop process and never come back. */
import {
  Cpu, ExternalLink, Eye, Info, Keyboard, KeyRound, ListFilter, MessageCircle, PawPrint, Pencil, Play, Plus, Radio, RefreshCw, RotateCcw, ShieldCheck, Trash2, TriangleAlert, Volume2, X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { desktop } from '../../../lib/desktop';
import { PROVIDER_BY_ID, engineLabel } from '../../../lib/providers';
import { PERSONA } from '../../../lib/persona';
import type { AgentEngine, ModelState, PetProactivity, PetVoiceProvider, ProviderId } from '../../../lib/types';
import { hotkeyStore } from '../../../pet/brain';
import type { TtsModel } from '../../../pet/contracts';
import { actions } from '../../../state/actions';
import { menuValue, parseMenuValue, petChatEngine, petVisionEngine, petVisionOptions, petWebOptions } from '../../../state/models';
import { DEFAULT_PET } from '../../../state/seed';
import { useApp } from '../../../state/store';
import { Button, IconButton, Panel, Segmented, Slider, Switch, cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { MAX_NAMES, parseAccelerator, parseExe, parseIntIn, type Checked } from './petInput';

/** The desktop side of the pet. Absent in the browser dev build. */
const bridge = desktop?.pet;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');

/** Scroll the 桌宠 panel into view and put keyboard focus on its heading (the 桌宠 menu's 「设置」 uses this
 *  after it has switched to the 设置 page; the panel may not be mounted yet, so it waits a few frames). */
export function focusPetSettings() {
  let tries = 0;
  const go = () => {
    const panel = document.getElementById('settings-pet');
    if (!panel) { if (++tries < 30) requestAnimationFrame(go); return; }
    const calm = document.documentElement.dataset.motion === 'reduced' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panel.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' });
    const heading = panel.querySelector<HTMLElement>('h2');
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  };
  go();
}

/* ───────────── building blocks ───────────── */

/** A titled block of the panel. */
function Group({ icon: Icon, title, actions: right, children }: { icon: LucideIcon; title: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-item pet-set" aria-labelledby={id}>
      <div className="pet-set__head">
        <h3 id={id} className="pet-set__title"><Icon size={15} aria-hidden />{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Title and hint on the left, the control on the right; `wide` puts the control on its own line. */
function Row({ title, desc, wide, children }: { title: string; desc?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <p className="settings-row__title">{title}</p>
        {desc && <p className="settings-row__desc">{desc}</p>}
      </div>
      <div className={cx('settings-row__control', wide && 'pet-set__wide')}>{children}</div>
    </div>
  );
}

/** A text field that is checked and saved when you leave it (Enter saves, Esc puts the old value back). An
 *  invalid entry stays on screen with the reason, and nothing is saved until it is fixed. */
function CommitInput({ label, value, parse, onCommit, placeholder, mono, maxLength, disabled, unit, className, inputMode }: {
  label: string; value: string; parse: (draft: string) => Checked; onCommit: (value: string) => void;
  placeholder?: string; mono?: boolean; maxLength?: number; disabled?: boolean; unit?: string; className?: string; inputMode?: 'numeric' | 'text';
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  // The setting changed from somewhere else (reset, another window): show it.
  useEffect(() => { setDraft(value); setError(undefined); }, [value]);
  const commit = () => {
    const r = parse(draft);
    if (!r.ok) { setError(r.error); return; }
    setError(undefined);
    setDraft(r.value);
    if (r.value !== value) onCommit(r.value);
  };
  return (
    <div className="pet-set__commit">
      <span className="pet-set__with-unit">
        <input
          className={cx('input', mono && 'mono', className)} aria-label={label} value={draft} placeholder={placeholder} maxLength={maxLength} disabled={disabled}
          inputMode={inputMode} autoComplete="off" spellCheck={false}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => { setDraft(e.target.value); setError(undefined); }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { setDraft(value); setError(undefined); }
          }}
        />
        {unit && <span className="pet-set__unit">{unit}</span>}
      </span>
      {error && <p id={`${id}-e`} className="pet-set__err" role="alert">{error}{value ? `（没有保存，仍是 ${value}）` : '（没有保存）'}</p>}
    </div>
  );
}

const asInt = (n: number, lo: number, hi: number) => ({ parse: parseIntIn(lo, hi), value: String(n) });

/** An editable list of program names (lower-case exe files). `onAdd` gets the new names in one go and may
 *  refuse with a reason; `onRemove` drops one. */
function NameList({ title, desc, names, onAdd, onRemove }: {
  title: string; desc: string; names: string[]; onAdd: (added: string[]) => string | undefined; onRemove: (name: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const submit = () => {
    if (!draft.trim()) return;
    const added: string[] = [];
    for (const part of draft.split(/[,，;；\n]+/)) {
      if (!part.trim()) continue;
      const r = parseExe(part);
      if (!r.ok) { setError(r.error); return; }
      if (!names.includes(r.value) && !added.includes(r.value)) added.push(r.value);
    }
    if (!added.length) { setError('已经在名单里了'); return; }
    if (names.length + added.length > MAX_NAMES) { setError(`名单最多 ${MAX_NAMES} 个`); return; }
    const refused = onAdd(added);
    if (refused) { setError(refused); return; }
    setDraft('');
    setError(undefined);
  };
  return (
    <div className="pet-set__listbox">
      <div>
        <p className="pet-set__listname" id={`${id}-t`}>{title}</p>
        <p className="pet-set__hint">{desc}</p>
      </div>
      {names.length > 0 ? (
        <ul className="pet-tags" aria-labelledby={`${id}-t`}>
          {names.map((n) => (
            <li key={n} className="pet-tag">
              <span>{n}</span>
              <button type="button" aria-label={`从「${title}」移除 ${n}`} title="移除" onClick={() => onRemove(n)}><X size={12} aria-hidden /></button>
            </li>
          ))}
        </ul>
      ) : <p className="pet-set__empty">还没有</p>}
      <div className="pet-set__add">
        <input
          className="input mono" aria-label={`添加到「${title}」`} placeholder="starrail.exe" value={draft} autoComplete="off" spellCheck={false}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => { setDraft(e.target.value); setError(undefined); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        <Button size="sm" icon={Plus} disabled={!draft.trim()} onClick={submit}>添加</Button>
      </div>
      {error && <p id={`${id}-e`} className="pet-set__err" role="alert">{error}</p>}
    </div>
  );
}

/* ───────────── 模型 ───────────── */

/** 「Claude Sonnet 5.5 · Claude Code」 for a saved choice, whether or not its way is still connected. */
function engineText(models: ModelState, e: AgentEngine) {
  const [provider, auth] = e.key.split(':');
  const p = PROVIDER_BY_ID[provider as ProviderId];
  if (!p) return e.key;
  return engineLabel(p, auth === 'api' ? 'api' : 'cli', auth === 'api' ? undefined : models.providers[p.id].driver, e.model);
}

/** 自动, or one of the models that are connected right now. */
function EnginePick({ label, models, options, value, autoSub, emptyHint, onChange }: {
  label: string; models: ModelState; options: Array<{ key: string; model: string; label: string }>;
  value: AgentEngine | undefined; autoSub: string; emptyHint: string; onChange: (e: AgentEngine | undefined) => void;
}) {
  const current = value ? menuValue(value.key, value.model) : '';
  const gone = !!value && !options.some((o) => menuValue(o.key, o.model) === current);
  const list = [
    { value: '', label: '自动', sub: autoSub },
    ...options.map((o) => ({ value: menuValue(o.key, o.model), label: o.label, sub: o.model && o.model !== o.label ? o.model : undefined })),
  ];
  return (
    <div className="pet-set__pick">
      <MenuSelect
        variant="field" label={label} icon={Cpu} value={current} options={list} minWidth={300}
        display={gone && value ? `${engineText(models, value)}（现在不可用）` : undefined}
        onChange={(v) => { if (!v) { onChange(undefined); return; } const { key, model } = parseMenuValue(v); onChange({ key, model }); }}
        footer={<Button size="sm" variant="ghost" onClick={() => actions.navigate('models')}>去模型接入</Button>}
      />
      {gone && <p className="pet-set__warn"><TriangleAlert size={13} aria-hidden />这个模型现在连不上，她会先按「自动」选。</p>}
      {!gone && options.length === 0 && <p className="pet-set__hint">{emptyHint}</p>}
    </div>
  );
}

/* ───────────── 语音 ───────────── */

type KeyedProvider = 'elevenlabs' | 'minimax';
const KEYED: Array<{ id: KeyedProvider; name: string; url: string }> = [
  { id: 'elevenlabs', name: 'ElevenLabs', url: 'https://elevenlabs.io/app/settings/api-keys' },
  { id: 'minimax', name: 'MiniMax', url: PROVIDER_BY_ID.minimax.keyUrl },
];
const PROVIDER_OPTIONS: Array<{ value: PetVoiceProvider; label: string; hint: string }> = [
  { value: 'elevenlabs', label: 'ElevenLabs', hint: '音质最好，需要 API Key' },
  { value: 'minimax', label: 'MiniMax', hint: '中文音色多，可以设计自己的音色，需要 API Key' },
  { value: 'edge', label: '微软在线朗读', hint: '晓晓等声音，不需要密钥；用的是非官方的免费接口' },
];
const SERVICE_NAME: Record<PetVoiceProvider, string> = { elevenlabs: 'ElevenLabs', minimax: 'MiniMax', edge: '微软在线朗读' };

/** The services her words go to, in order: the chosen one, then (with 备用) the rest in ElevenLabs → MiniMax → 微软在线朗读
 *  order. A keyed service with no key is skipped before anything is sent, as electron/pet/tts.cjs does. */
function voiceRoute(provider: PetVoiceProvider, fallback: boolean, hints: Partial<Record<PetVoiceProvider, string>>): PetVoiceProvider[] {
  const order: PetVoiceProvider[] = ['elevenlabs', 'minimax', 'edge'];
  const chain = fallback ? [provider, ...order.filter((p) => p !== provider)] : [provider];
  return chain.filter((p) => p === 'edge' || !!hints[p]);
}

/** Says plainly which services the reply text is sent to, and what 微软在线朗读 is. */
function VoiceRoute({ provider, fallback, enabled, hints }: {
  provider: PetVoiceProvider; fallback: boolean; enabled: boolean; hints?: Partial<Record<PetVoiceProvider, string>>;
}) {
  const route = hints ? voiceRoute(provider, fallback, hints) : [];
  const unkeyed = !!hints && provider !== 'edge' && !hints[provider];
  return (
    <div className="pet-set__route" role="note">
      <p className="pet-set__route-title"><Info size={14} aria-hidden />她说的话会发给谁</p>
      <p className="pet-set__route-text">读出来的是气泡里显示的那部分回复（可能复述了你屏幕上的内容），它会发给语音服务合成声音：</p>
      <ul>
        <li><strong>ElevenLabs</strong>、<strong>MiniMax</strong>：官方接口，用你自己的 API Key。没保存密钥的那家不会被用到，也就收不到文字。</li>
        <li><strong>微软在线朗读</strong>：Edge 浏览器朗读功能背后的<strong>非官方免费接口</strong>，不需要密钥，没有任何服务保证，随时可能失效。</li>
      </ul>
      {enabled ? (
        <>
          {route.length > 0 && (
            <p className="pet-set__route-text">
              按现在的设置，文字发给：<strong>{route.map((p) => SERVICE_NAME[p]).join(' → ')}</strong>{route.length > 1 ? '（前一个出错了才发给后一个）' : ''}。
            </p>
          )}
          {unkeyed && (
            <p className="pet-set__warn">
              <TriangleAlert size={13} aria-hidden />
              {fallback
                ? `还没有保存 ${SERVICE_NAME[provider]} 的密钥，所以她的话现在由备用声音读出：${SERVICE_NAME[route[0] ?? 'edge']}。`
                : `还没有保存 ${SERVICE_NAME[provider]} 的密钥，又没开备用声音，她现在不会出声。`}
            </p>
          )}
          {route.includes('edge') && provider !== 'edge' && <p className="pet-set__route-text">不想让文字发给微软在线朗读：关掉上面的「失败时自动换用备用声音」。</p>}
        </>
      ) : <p className="pet-set__route-text">语音现在是关的，不会把文字发给任何服务。</p>}
    </div>
  );
}

/** A voice-service key: password field, 保存; once saved only the hint is shown (更换 / 删除). */
function TtsKey({ provider, name, url, hint, onHint }: { provider: KeyedProvider; name: string; url: string; hint?: string; onHint: (hint: string | undefined) => void }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const show = !hint || editing;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key || !bridge) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await bridge.saveTtsKey(provider, key);
      if (r.ok) {
        setValue('');
        setEditing(false);
        onHint(r.hint);
        actions.toast({ tone: 'success', title: '密钥已加密保存', body: `${name} · ${r.hint}` });
      } else setError(r.error);
    } catch (err) { setError(errText(err)); }
    setBusy(false);
  };
  const clear = async () => {
    if (!bridge) return;
    setError(undefined);
    try {
      const r = await bridge.clearTtsKey(provider);
      // The file could not be written: the key is still saved, so the hint stays.
      if (!r.ok) { setError(r.error); return; }
      onHint(undefined);
      setEditing(false);
      setValue('');
      actions.toast({ tone: 'info', title: '密钥已删除', body: name });
    } catch (err) { setError(errText(err)); }
  };
  return (
    <div className="model-field">
      <span className="model-field__label" id={`${id}-l`}>{name} API Key</span>
      {show ? (
        <form className="model-key" onSubmit={save}>
          <input className="input mono" type="password" aria-labelledby={`${id}-l`} value={value} autoComplete="off" spellCheck={false}
            placeholder="粘贴密钥" onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!value.trim()}>保存</Button>
          {hint && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(''); setError(undefined); }}>取消</Button>}
        </form>
      ) : (
        <div className="model-key model-key--saved">
          <KeyRound size={14} aria-hidden />
          <span className="mono">已保存 {hint}</span>
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>更换</Button>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void clear()}>删除</Button>
        </div>
      )}
      {error && <p className="pet-set__err" role="alert">{error}</p>}
      <p className="model-field__hint"><a href={url} target="_blank" rel="noreferrer">去获取密钥<ExternalLink size={11} aria-hidden /></a></p>
    </div>
  );
}

type VoiceItem = { id: string; name: string; preview?: string };
type VoiceList = { provider: PetVoiceProvider; status: 'loading' | 'ready' | 'error' | 'need-key'; list: VoiceItem[]; message?: string };
type ModelList = { provider: KeyedProvider; status: 'loading' | 'ready' | 'error'; list: TtsModel[]; live: boolean; message?: string };

/** The speech-model picker of ElevenLabs / MiniMax. '' = the recommended model (which may change with the service). */
function ModelPicker({ provider, keyed, tick }: { provider: KeyedProvider; keyed: boolean; tick: number }) {
  const models = useApp((s) => s.settings.pet.voice.models);
  const value = models[provider];
  const [state, setState] = useState<ModelList>({ provider, status: 'loading', list: [], live: false });
  useEffect(() => {
    if (!bridge) return;
    let stale = false;
    setState({ provider, status: 'loading', list: [], live: false });
    bridge.ttsModels(provider).then(
      (r) => {
        if (stale) return;
        if ('models' in r) setState({ provider, status: 'ready', list: r.models, live: r.live });
        else setState({ provider, status: 'error', list: [], live: false, message: r.error || '读取模型列表失败' });
      },
      (e) => { if (!stale) setState({ provider, status: 'error', list: [], live: false, message: errText(e) }); },
    );
    return () => { stale = true; };
    // A saved key turns ElevenLabs' built-in list into the account's live one.
  }, [provider, keyed, tick]);
  const shown = state.provider === provider ? state : { provider, status: 'loading' as const, list: [], live: false };
  const rec = shown.list.find((m) => m.recommended);
  const opt = (m: TtsModel) => ({ value: m.id, label: m.name || m.id, sub: m.note ? `${m.id} · ${m.note}` : m.id });
  const current = shown.list.filter((m) => !m.legacy);
  const legacy = shown.list.filter((m) => m.legacy);
  const groups = [
    { options: [{ value: '', label: rec ? `推荐：${rec.name || rec.id}` : '推荐', sub: rec?.note ?? '用这家服务推荐的模型' }] },
    ...(current.length ? [{ label: '可选模型', hint: shown.live ? '来自你的账号' : undefined, options: current.map(opt) }] : []),
    ...(legacy.length ? [{ label: '旧模型', hint: '还能用，效果一般不如新的', options: legacy.map(opt) }] : []),
    // A saved choice the list no longer has stays visible (the service may have renamed or retired it).
    ...(value && !shown.list.some((m) => m.id === value) ? [{ options: [{ value, label: value, sub: '当前选择（列表里没有）' }] }] : []),
  ];
  const chosen = shown.list.find((m) => m.id === (value || rec?.id));
  const name = provider === 'minimax' ? 'MiniMax' : 'ElevenLabs';
  return (
    <Row title="模型" desc={`同一个声音换模型，音质、语气和速度都会不一样。${name} 的声音编号在它的各个模型之间通用。`} wide>
      <MenuSelect variant="field" label="模型" icon={Cpu} value={value} groups={groups} placeholder={shown.status === 'loading' ? '读取中…' : '推荐'} minWidth={320}
        disabled={!bridge || shown.status === 'loading'}
        onChange={(v) => actions.setPet({ voice: { models: { ...models, [provider]: v } } })} />
      {chosen?.note && <p className="pet-set__hint">{chosen.name || chosen.id}：{chosen.note}</p>}
      {shown.status === 'error' && <p className="pet-set__err" role="alert">{shown.message}</p>}
    </Row>
  );
}

function VoiceSettings() {
  const voice = useApp((s) => s.settings.pet.voice);
  const mode = useApp((s) => s.settings.mode);
  const [hints, setHints] = useState<Partial<Record<PetVoiceProvider, string>>>();
  const [voices, setVoices] = useState<VoiceList>({ provider: voice.provider, status: 'loading', list: [] });
  const [tick, setTick] = useState(0);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ sig: string; ok: boolean; text: string }>();
  const provider = voice.provider;
  const model = provider === 'edge' ? '' : voice.models[provider];
  const sig = `${provider}|${voice.voiceId}|${model}`;

  // Which services already have a key.
  useEffect(() => {
    let stale = false;
    (bridge ? bridge.ttsKeys() : Promise.resolve({})).then((h) => { if (!stale) setHints(h); }, () => { if (!stale) setHints({}); });
    return () => { stale = true; };
  }, []);

  // The list of voices for the chosen service. A service that needs a key is not asked until it has one.
  const keyed = provider === 'edge' || !!hints?.[provider];
  const known = hints !== undefined;
  useEffect(() => {
    if (!bridge || !known) return;
    if (!keyed) { setVoices({ provider, status: 'need-key', list: [] }); return; }
    let stale = false;
    setVoices({ provider, status: 'loading', list: [] });
    bridge.voices(provider).then(
      (r) => {
        if (stale) return;
        if (Array.isArray(r)) setVoices({ provider, status: 'ready', list: r });
        else setVoices({ provider, status: 'error', list: [], message: r?.error || '读取声音列表失败' });
      },
      (e) => { if (!stale) setVoices({ provider, status: 'error', list: [], message: errText(e) }); },
    );
    return () => { stale = true; };
  }, [provider, keyed, known, tick]);

  // A list that belongs to the service you just switched away from is not shown while the new one loads.
  const shown: VoiceList = voices.provider === provider ? voices : { provider, status: 'loading', list: [] };
  const options = [
    ...(provider === 'edge' ? [{ value: '', label: '默认', sub: '微软在线朗读的默认声音' }] : []),
    // The saved voice stays visible even when the list could not be read.
    ...(voice.voiceId && !shown.list.some((v) => v.id === voice.voiceId) ? [{ value: voice.voiceId, label: voice.voiceId, sub: '当前选择' }] : []),
    ...shown.list.map((v) => ({ value: v.id, label: v.name || v.id, sub: v.name && v.name !== v.id ? v.id : undefined })),
  ];
  const placeholder = !bridge ? '需要桌面版' : shown.status === 'loading' ? '读取中…' : shown.status === 'need-key' ? '先保存密钥' : '还没选声音';
  const canTest = !!bridge && (provider === 'edge' || !!voice.voiceId) && keyed;

  const runTest = async () => {
    if (!bridge) return;
    setTesting(true);
    setTest(undefined);
    const text = mode === 'sam' ? `${PERSONA.sam.name}，已就位。这个声音可以吗？` : `我是${PERSONA.firefly.name}。这个声音，你觉得怎么样？`;
    try {
      const r = await bridge.testVoice({ provider, voiceId: voice.voiceId, model, text });
      setTest({ sig, ok: r.ok, text: r.ok ? '已发出试听' : r.error });
    } catch (e) { setTest({ sig, ok: false, text: errText(e) }); }
    setTesting(false);
  };

  return (
    <Group icon={Volume2} title="语音">
      <Switch label="让她开口说话" description="气泡里的话同时读出来。长回答只读前两句。" checked={voice.enabled} onChange={(v) => actions.setPet({ voice: { enabled: v } })} />
      <Row title="语音服务" desc="换服务后要重新选声音，每家的声音编号不通用。">
        <Segmented<PetVoiceProvider> label="语音服务" options={PROVIDER_OPTIONS} value={provider}
          onChange={(v) => actions.setPet({ voice: { provider: v, voiceId: '' } })} />
      </Row>

      <div className="pet-set__box">
        <p className="pet-set__boxtitle">语音服务密钥</p>
        <p className="pet-set__hint">密钥由系统加密，只保存在桌面版的主进程里，这里保存后不再显示。微软在线朗读不需要密钥。</p>
        {hints ? (
          <div className="pet-set__keys">
            {KEYED.map((k) => (
              <TtsKey key={k.id} provider={k.id} name={k.name} url={k.url} hint={hints[k.id]}
                onHint={(h) => { setHints((cur) => ({ ...cur, [k.id]: h })); window.dispatchEvent(new Event(TTS_KEYS_EVENT)); }} />
            ))}
          </div>
        ) : <p className="pet-set__hint">读取中…</p>}
      </div>

      <Row title="声音" desc={provider === 'minimax' ? '选一个现成的音色。' : provider === 'elevenlabs' ? '选你账号里可用的声音。' : '微软在线朗读的声音，晓晓是默认的一个。'} wide>
        <div className="pet-set__voicebar">
          <div className="pet-set__grow">
            <MenuSelect variant="field" label="声音" icon={Volume2} value={voice.voiceId} options={options} placeholder={placeholder} minWidth={280}
              disabled={shown.status === 'loading' || shown.status === 'need-key'}
              onChange={(v) => actions.setPet({ voice: { voiceId: v } })} />
          </div>
          <IconButton icon={RefreshCw} label="刷新声音列表" variant="secondary" disabled={!bridge || !keyed || shown.status === 'loading'} onClick={() => setTick((t) => t + 1)} />
          <Button icon={Play} busy={testing} disabled={!canTest} onClick={() => void runTest()}>试听</Button>
        </div>
        {shown.status === 'error' && <p className="pet-set__err" role="alert">{shown.message}</p>}
        {shown.status === 'need-key' && <p className="pet-set__hint">先在上面保存 {provider === 'minimax' ? 'MiniMax' : 'ElevenLabs'} 的 API Key，才能列出声音。</p>}
        {test?.sig === sig && <p className={test.ok ? 'pet-set__ok' : 'pet-set__err'} role={test.ok ? 'status' : 'alert'}>{test.text}</p>}
        {/* TODO(tts): MiniMax 音色设计 (describe a voice, get a voiceId back) goes here once the desktop bridge exposes it. */}
      </Row>
      {provider !== 'edge' && <ModelPicker provider={provider} keyed={keyed} tick={tick} />}

      <Slider label="音量" value={voice.volume} min={0} max={100} step={5} onChange={(v) => actions.setPet({ voice: { volume: v } })}
        description="只影响桌宠说话的音量，不是系统音量。" />
      <Switch label="失败时自动换用备用声音" description="当前服务出错或没配好时，按 ElevenLabs → MiniMax → 微软在线朗读依次换，让她总能出声。没有密钥的服务直接跳过。" checked={voice.fallback}
        onChange={(v) => actions.setPet({ voice: { fallback: v } })} />
      <VoiceRoute provider={provider} fallback={voice.fallback} enabled={voice.enabled} hints={hints} />
    </Group>
  );
}

/* ───────────── the panel ───────────── */

const PROACTIVITY: Array<{ value: PetProactivity; label: string; hint: string }> = [
  { value: 'off', label: '不主动', hint: '只在你问她的时候说话' },
  { value: 'low', label: '很少', hint: '很少打扰你' },
  { value: 'normal', label: '偶尔', hint: '偶尔搭一句' },
  { value: 'high', label: '常常', hint: '话比较多' },
];
/** Fired on window when a voice-service key is saved or removed (the 实时陪玩 checklist reads them again). */
const TTS_KEYS_EVENT = 'pet-tts-keys';

const LISTEN: Array<{ value: 'auto' | 'key'; label: string }> = [
  { value: 'auto', label: '自动听' },
  { value: 'key', label: '按键说一句' },
];

/** What 实时陪玩 needs that is not there yet: an ElevenLabs key (it hears and speaks with it) and an API model. */
function LiveNeeds() {
  const models = useApp((s) => s.models);
  const pet = useApp((s) => s.settings.pet);
  const [keys, setKeys] = useState<Partial<Record<PetVoiceProvider, string>>>();
  useEffect(() => {
    let stale = false;
    const read = () => { (bridge ? bridge.ttsKeys() : Promise.resolve({})).then((k) => { if (!stale) setKeys(k); }, () => { if (!stale) setKeys({}); }); };
    read();
    // A key saved or removed in 语音 above.
    window.addEventListener(TTS_KEYS_EVENT, read);
    return () => { stale = true; window.removeEventListener(TTS_KEYS_EVENT, read); };
  }, []);
  const vision = petVisionEngine(models, pet.vision);
  const chat = petChatEngine(models, { vision: pet.vision });
  const engine = vision ?? (chat?.auth === 'api' ? chat : undefined);
  const items: ReactNode[] = [];
  if (keys && !keys.elevenlabs) items.push(<span key="el">还没有保存 ElevenLabs 的密钥：实时陪玩用它听你说话、用她的声音回答。在上面的「语音」里保存。</span>);
  if (!engine) items.push(<span key="m">还没有用 API 接入的模型：实时陪玩要它来马上回答（命令行方式启动太慢）。</span>);
  else if (!vision) items.push(<span key="v">现在接的模型不能看图：她能听能说，但看不到游戏画面。</span>);
  if (!items.length) return null;
  return (
    <div className="pet-set__qwen is-missing">
      <TriangleAlert size={14} aria-hidden />
      <span className="pet-set__needs">{items}</span>
      {!engine && <Button size="sm" variant="ghost" onClick={() => actions.navigate('models')}>去模型接入</Button>}
    </div>
  );
}


export function PetSettingsPanel() {
  const pet = useApp((s) => s.settings.pet);
  const models = useApp((s) => s.models);
  const set = actions.setPet;
  const hotkeysAreDefault = pet.hotkeyAsk === DEFAULT_PET.hotkeyAsk && pet.hotkeyPause === DEFAULT_PET.hotkeyPause;
  // What the desktop could register (electron/pet/hotkeys.cjs words each failure with 呼出… / 暂停… in front).
  // Before it has said anything, nothing is assumed to have failed.
  const registered = useSyncExternalStore(hotkeyStore.subscribe, hotkeyStore.get);
  const hotkeyErrors = registered?.errors ?? [];
  const askErrors = hotkeyErrors.filter((e) => e.startsWith('呼出'));
  const pauseErrors = hotkeyErrors.filter((e) => e.startsWith('暂停'));
  const otherErrors = hotkeyErrors.filter((e) => !e.startsWith('呼出') && !e.startsWith('暂停'));
  const failed = (list: string[]) => list.map((e) => <p key={e} className="pet-set__err" role="alert">{e}</p>);

  /** A hotkey is valid when Electron can read it and it differs from the other one. */
  const hotkey = (other: string) => (draft: string): Checked => {
    const r = parseAccelerator(draft);
    if (!r.ok) return r;
    const o = parseAccelerator(other);
    return o.ok && o.value === r.value ? { ok: false, error: '和另一个热键重复了' } : r;
  };

  // Marking a program as never / don't watch takes it out of the 可以看 list (the stricter list wins anyway);
  // the other way round is refused, so the lists never contradict each other.
  const addStrict = (key: 'neverWatch' | 'gameDeny') => (added: string[]) => {
    set({ [key]: [...pet[key], ...added], gameAllow: pet.gameAllow.filter((x) => !added.includes(x)) });
    return undefined;
  };
  const addAllow = (added: string[]) => {
    const blocked = added.find((x) => pet.neverWatch.includes(x) || pet.gameDeny.includes(x));
    if (blocked) return `${blocked} 在「永远不看」或「不要看」里，那边优先。先把它从那里移除。`;
    set({ gameAllow: [...pet.gameAllow, ...added] });
    return undefined;
  };
  const remove = (key: 'neverWatch' | 'gameAllow' | 'gameDeny') => (name: string) => set({ [key]: pet[key].filter((x) => x !== name) });

  return (
    <Panel className="settings-span" label="桌面" title="桌宠" icon={PawPrint} energy id="settings-pet">
      {!bridge && (
        <div className="callout callout--warning pet-set__note" role="note">
          <Info size={16} aria-hidden className="callout__icon" />
          <div className="callout__body">
            <p className="callout__title">需要桌面版</p>
            <p className="callout__text">桌宠是一个独立的透明小窗口，只有桌面版才有。在浏览器里预览时，下面的选项只能看，不能改。</p>
          </div>
        </div>
      )}
      <fieldset className="pet-set__fields" disabled={!bridge}>
        <legend className="sr-only">桌宠设置</legend>
        <div className="settings-list">
          <Group icon={PawPrint} title="形象">
            <Switch label="显示桌宠" description="屏幕角落里一只 Q 版的小人，流萤模式是 Q 版流萤，萨姆模式是 Q 版萨姆。可以拖动，右键有菜单。" checked={pet.enabled} onChange={(v) => set({ enabled: v })} />
            <Slider label="大小" value={Math.round(pet.scale * 100)} min={60} max={160} step={5} format={(v) => `${v}%`} ends={['小', '大']}
              onChange={(v) => set({ scale: v / 100 })} />
          </Group>

          <Group icon={Eye} title="看画面">
            <Switch label="允许她看游戏画面" description="开着时，她能在本机看一眼你正在玩的游戏，聊剧情、帮你看看卡在哪里。" checked={pet.watch} onChange={(v) => set({ watch: v })} />
            <div className="pet-set__privacy" role="group" aria-label="隐私说明">
              <p className="pet-set__privacy-title"><ShieldCheck size={15} aria-hidden />她怎么看，看到的去了哪里</p>
              <ul>
                <li>只看当前在前台的<strong>游戏窗口</strong>，不看整个桌面。聊天、网银、浏览器这类不是游戏的窗口不会被截取。</li>
                <li>画面默认<strong>留在这台电脑上</strong>，只在本机判断「有没有在动、是不是过场」。</li>
                <li>她可以看前台的游戏时，你向她提问（包括实时陪玩里开口问），或她看到过场结束、画面久不动准备主动搭话，都可能把<strong>一帧</strong>发给看图模型（每小时有上限）；和游戏有关的问话、搭话，还会带上从画面里识别出的几行文字（在本机识别）。</li>
                <li>攻略、配装这类要联网查的问题交给 Claude Code，会带上游戏名、识别出的几行文字和最近的几句对话，问到画面时再加一句画面描述，不带图；只有 Codex 可用时，不给它屏幕文字、画面描述和对话记录。</li>
                <li>竞技反作弊游戏<strong>不看画面</strong>：它们在前台时她会自己藏起来、不说话，离开后再出现。不注入游戏、不读内存、不模拟键鼠。</li>
                <li>她会读前台程序的名字和窗口标题，用来认出你在玩什么；只有你自己标成游戏的程序，窗口标题会当作游戏名发给模型。看画面时桌宠上有小眼睛标记，按暂停热键立刻停止。</li>
              </ul>
            </div>
          </Group>

          <Group icon={MessageCircle} title="主动搭话">
            <Row title="主动程度" desc="她自己开口的频率。你问过她、点过她或开口说过话的一分钟内，以及她正在想、正在说的时候，她不会插嘴；连续两次没人理会就安静 10 分钟。">
              <Segmented<PetProactivity> label="主动程度" options={PROACTIVITY} value={pet.proactivity} onChange={(v) => set({ proactivity: v })} />
            </Row>
            <Row title="冷却" desc="她上一次开口（回答或主动搭话都算）之后，至少隔多久才会再主动搭话，60 秒到 1 小时。">
              <CommitInput label="冷却（秒）" unit="秒" inputMode="numeric" className="pet-set__num" disabled={pet.proactivity === 'off'}
                {...asInt(pet.cooldownSec, 60, 3600)} onCommit={(v) => set({ cooldownSec: Number(v) })} />
            </Row>
            <Row title="每小时最多发几张截图" desc="一小时里最多发给看图模型几张截图，回答你的提问和她主动搭话都算在内；其中留出几张专给你的提问。用来控制花费，0 表示一张也不发（回答你时也不看画面）。">
              <CommitInput label="每小时最多发几张截图" unit="张" inputMode="numeric" className="pet-set__num"
                {...asInt(pet.imagesPerHour, 0, 240)} onCommit={(v) => set({ imagesPerHour: Number(v) })} />
            </Row>
          </Group>

          <Group icon={Cpu} title="模型">
            <Row title="看图模型" desc="看截图用的 API 模型，要支持图片。自动：用已接入的便宜视觉模型。看画面关着时它不再收到截图，但仍负责文字回答。" wide>
              <EnginePick label="看图模型" models={models} options={petVisionOptions(models)} value={pet.vision} autoSub="用已接入的便宜视觉模型"
                emptyHint="还没有接入能看图的 API 模型。到「模型接入」连一个再回来选。" onChange={(e) => set({ vision: e })} />
            </Row>
            <Row title="联网答疑模型" desc="问攻略、配装、版本信息时用的命令行模型，要能联网搜索。自动：用已登录的 Claude Code 或 Codex。" wide>
              <EnginePick label="联网答疑模型" models={models} options={petWebOptions(models)} value={pet.web} autoSub="用已登录的 Claude Code 或 Codex"
                emptyHint="还没有登录可用的命令行工具。到「模型接入」登录 Claude Code 或 Codex。" onChange={(e) => set({ web: e })} />
            </Row>
          </Group>

          <VoiceSettings />

          <Group
            icon={Keyboard} title="热键"
            actions={!hotkeysAreDefault && <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => set({ hotkeyAsk: DEFAULT_PET.hotkeyAsk, hotkeyPause: DEFAULT_PET.hotkeyPause })}>恢复默认</Button>}
          >
            <Row title="呼出聊天框" desc="在任何程序里按它，桌宠头上弹出聊天框，和她来回聊；再按一次收起。至少带 Ctrl、Alt 或 Win；建议用 Ctrl+Alt 开头，不容易和别的程序的快捷键冲突，例如 Ctrl+Alt+F。">
              <CommitInput label="呼出聊天框的热键" mono className="pet-set__key" value={pet.hotkeyAsk} maxLength={40} parse={hotkey(pet.hotkeyPause)} onCommit={(v) => set({ hotkeyAsk: v })} />
              {failed(askErrors)}
            </Row>
            <Row title="暂停 / 继续观看" desc="按一下立刻停止看画面，再按一下继续。">
              <CommitInput label="暂停或继续观看的热键" mono className="pet-set__key" value={pet.hotkeyPause} maxLength={40} parse={hotkey(pet.hotkeyAsk)} onCommit={(v) => set({ hotkeyPause: v })} />
              {failed(pauseErrors)}
            </Row>
            {failed(otherErrors)}
            <p className="pet-set__hint">如果别的程序已经占用了这个组合，热键会注册失败，换一个就好。</p>
          </Group>

          <Group icon={ListFilter} title="名单">
            <p className="pet-set__hint">
              填程序的文件名，比如 starrail.exe；直接粘贴完整路径也行，会自动取文件名。桌宠的右键菜单里也能把前台程序加进来。
              认出来的反作弊游戏最严：她一定会隐藏，这里的名单都改不了。其余程序的优先级：永远不看 &gt; 不要看 &gt; 游戏，可以看。
            </p>
            <div className="pet-set__lists">
              <NameList title="永远不看" desc="这些程序在前台时，她完全不看画面。" names={pet.neverWatch} onAdd={addStrict('neverWatch')} onRemove={remove('neverWatch')} />
              <NameList title="不要看" desc="只聊天、不看画面。认出来的反作弊游戏更严：在前台时她直接隐藏。" names={pet.gameDeny} onAdd={addStrict('gameDeny')} onRemove={remove('gameDeny')} />
              <NameList title="游戏，可以看" desc="内置名单没认出来的游戏，加在这里她才会看它的画面。" names={pet.gameAllow} onAdd={addAllow} onRemove={remove('gameAllow')} />
            </div>
          </Group>

          <Group icon={Radio} title="实时陪玩">
            <div className="callout callout--info" role="note">
              <Info size={16} aria-hidden className="callout__icon" />
              <div className="callout__body">
                <p className="callout__title">边玩边用语音聊</p>
                <p className="callout__text">
                  开着时她听着你的麦克风：你说完一句，她马上用自己的声音回答；她可以看前台的游戏时，你开口提问可能会带上此刻的游戏画面（每小时有张数上限）。听你说话用 ElevenLabs，回答由你在「模型接入」里接的 API 模型来写，再用上面「语音」里选的声音读出来；问到攻略、配队、版本这类要联网查的事，有已登录的 Claude Code 或 Codex 时会转给它去查，答得慢一些。
                  <strong>约每小时 2–5 元</strong>，取决于聊多少和用的模型。麦克风里比环境噪声明显更响的声音会被送去 ElevenLabs 识别：本机只按音量判断，你的话、游戏声音、旁边的人声都可能送出；安静时不送声音，只保持一条空闲的连接。从桌宠的右键菜单开始和结束。
                </p>
              </div>
            </div>
            <LiveNeeds />
            <Row title="怎么听" desc={pet.realtime.listen === 'key'
              ? `按 ${pet.hotkeyAsk} 后说一句话，说完自动停。外放声音或游戏很吵时用这个，免得把游戏里的人声当成你在说话。`
              : '你一开口她就在听，说完一句就回答；她说话时你开口会打断她。建议戴耳机。'}>
              <Segmented<'auto' | 'key'> label="怎么听" options={LISTEN} value={pet.realtime.listen} onChange={(v) => set({ realtime: { listen: v } })} />
            </Row>
            <Slider label="灵敏度" value={pet.realtime.sensitivity} min={0} max={100} step={5} onChange={(v) => set({ realtime: { sensitivity: v } })}
              description="越高越容易听到小声说话，也越容易把杂音当成说话；游戏声音大时调低一些。" />
            <Switch label="更快开口" description="她的回答用 ElevenLabs Flash v2.5 来读：开口快大约半秒，音质比你选的模型略逊。只对 ElevenLabs 有效。"
              checked={pet.realtime.fastVoice} onChange={(v) => set({ realtime: { fastVoice: v } })} />
            <Row title="自动结束" desc="这么久没听到声音就自动结束，免得忘了关。游戏里的人声和较响的音效也会让计时重来，游戏一直有声音时请手动结束。5 到 120 分钟。">
              <CommitInput label="自动结束（分钟）" unit="分钟" inputMode="numeric" className="pet-set__num"
                {...asInt(pet.realtime.autoOffMin, 5, 120)} onCommit={(v) => set({ realtime: { autoOffMin: Number(v) } })} />
            </Row>
            <p className="pet-set__hint">
              外放时她自己的声音和游戏声会漏进麦克风，戴耳机最稳；不方便时用「按键说一句」。开始实时陪玩后如果游戏声音突然变小，是 Windows 的通信闪避：
              到 控制面板 › 声音 › 通信，选「不执行任何操作」。语音识别的连接目前不走系统代理，需要代理才能访问 ElevenLabs 的网络会连不上。
            </p>
          </Group>
        </div>
      </fieldset>
    </Panel>
  );
}
