import { ExternalLink, FileText, FlaskConical, ImageIcon, Info, Keyboard, Palette, Play, RotateCcw, Settings, Unplug } from 'lucide-react';
import { ISSUES_URL, REPO_URL, TERMS } from '../../lib/terms';
import { useId, type ReactNode } from 'react';
import { useMedia, useReducedMotion } from '../../lib/hooks';
import type { MotionPref, ParticleDensity, SimSpeed } from '../../lib/types';
import { actions } from '../../state/actions';
import { GATEWAY_ID } from '../../state/engine';
import { gateway } from '../../state/selectors';
import { useApp } from '../../state/store';
import { Button, Kbd, Panel, Segmented, SimTag, Slider, Switch, cx } from '../ui';
import { WALLPAPERS } from '../decor/wallpapers';
import { DEFAULT_SETTINGS } from '../../state/seed';
import { ModePicker } from './config/ModePicker';
import { ViewHeader } from './config/ViewHeader';

const APP_VERSION = '0.1.0';

const MOTION_OPTIONS: Array<{ value: MotionPref; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'reduced', label: '减少' },
  { value: 'full', label: '完整' },
];
const PARTICLE_OPTIONS: Array<{ value: ParticleDensity; label: string }> = [
  { value: 'off', label: '关闭' },
  { value: 'low', label: '少量' },
  { value: 'normal', label: '标准' },
];
type SpeedKey = '1' | '2' | '4';
const SPEED_OPTIONS: Array<{ value: SpeedKey; label: string }> = [
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
  { value: '4', label: '4×' },
];

/** A setting with its title and hint on the left and the control on the right (wraps when narrow). */
function SettingRow({ title, desc, descId, children }: { title: string; desc?: ReactNode; descId?: string; children: ReactNode }) {
  return (
    <div className="settings-item">
      <div className="settings-row">
        <div className="settings-row__text">
          <p className="settings-row__title">{title}</p>
          {desc && <p className="settings-row__desc" id={descId}>{desc}</p>}
        </div>
        <div className="settings-row__control">{children}</div>
      </div>
    </div>
  );
}

const KEYS: Array<{ id: string; label: string; keys: ReactNode }> = [
  { id: 'console', label: '展开/收起控制台', keys: <><Kbd>Ctrl</Kbd><span aria-hidden>+</span><Kbd>`</Kbd></> },
  { id: 'nav', label: '切换导航', keys: <><Kbd>Alt</Kbd><span aria-hidden>+</span><Kbd>1</Kbd><span aria-hidden>…</span><Kbd>6</Kbd></> },
  { id: 'send', label: '发送或创建', keys: <><Kbd>Ctrl</Kbd><span aria-hidden>+</span><Kbd>Enter</Kbd></> },
  { id: 'peek', label: '赏图（淡出界面看壁纸）', keys: <><Kbd>Alt</Kbd><span aria-hidden>+</span><Kbd>W</Kbd></> },
  { id: 'esc', label: '关闭对话框、状态抽屉或赏图', keys: <Kbd>Esc</Kbd> },
];

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const gw = useApp(gateway);
  const osReduced = useMedia('(prefers-reduced-motion: reduce)');
  const reduced = useReducedMotion();
  const gwNoteId = useId();
  const gwDown = gw?.status === 'disconnected' || gw?.status === 'reconnecting';

  return (
    <div className="view settings-view">
      <ViewHeader icon={Settings} title="设置" desc="外观、运行行为与演示控制。设置保存在本浏览器中。" />

      <div className="settings-body">
        <div className="settings-grid">
          <Panel className="settings-span" label="界面" title="外观" icon={Palette} energy>
            <div className="settings-list">
              <ModePicker />
              <SettingRow
                title="减少动态效果"
                desc={`系统偏好：${osReduced ? '已开启减少动态效果' : '未开启减少动态效果'} · 当前生效：${reduced ? '减少' : '完整'}`}
              >
                <Segmented<MotionPref> label="减少动态效果" options={MOTION_OPTIONS} value={settings.motion} onChange={(v) => actions.setSetting('motion', v)} />
              </SettingRow>
              <SettingRow title="背景粒子" desc="控制背景星点与萤火的数量。减少动态效果时只保留静止星点。">
                <Segmented<ParticleDensity> label="背景粒子" options={PARTICLE_OPTIONS} value={settings.particles} onChange={(v) => actions.setSetting('particles', v)} />
              </SettingRow>
              <SettingRow title="开机动画" desc="仿崩铁版本开屏：先播一段流萤 PV 短片（萨姆模式是萨姆），再停在标题画面「点击进入」。短片可按任意键跳过。">
                <div className="settings-boot">
                  <Button size="sm" variant="ghost" icon={Play} onClick={() => actions.playBoot()}>预览</Button>
                  <Segmented<'on' | 'off'>
                    size="sm"
                    label="开机动画"
                    options={[{ value: 'on', label: '开启' }, { value: 'off', label: '关闭' }]}
                    value={settings.bootAnimation ? 'on' : 'off'}
                    onChange={(v) => actions.setSetting('bootAnimation', v === 'on')}
                  />
                </div>
              </SettingRow>
              <SettingRow title="进入方式" desc="标题画面上等你点击进入，或停留片刻后自动进入。">
                <Segmented<'click' | 'auto'>
                  size="sm"
                  label="开机动画进入方式"
                  options={[{ value: 'click', label: '点击进入' }, { value: 'auto', label: '自动进入' }]}
                  value={settings.bootEnter}
                  onChange={(v) => actions.setSetting('bootEnter', v)}
                />
              </SettingRow>
              <WallpaperSettings />
            </div>
          </Panel>

          <Panel label="行为" title="运行" icon={Play} energy>
            <div className="settings-list">
              <div className="settings-item">
                <Switch
                  label="取消运行前确认"
                  description="取消时先弹出确认框，避免误操作。"
                  checked={settings.confirmBeforeCancel}
                  onChange={(v) => actions.setSetting('confirmBeforeCancel', v)}
                />
              </div>
              <div className="settings-item">
                <Switch
                  label="出错时自动打开控制台"
                  description="工具调用出错时自动展开底部控制台，方便查看错误详情。"
                  checked={settings.openConsoleOnError}
                  onChange={(v) => actions.setSetting('openConsoleOnError', v)}
                />
              </div>
            </div>
          </Panel>

          <Panel label="键盘" title="快捷键" icon={Keyboard} energy>
            <dl className="settings-keys">
              {KEYS.map((k) => (
                <div key={k.id} className="settings-keys__row">
                  <dt>{k.label}</dt>
                  <dd>{k.keys}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel className="settings-span" label="模拟器" title="演示控制" icon={FlaskConical} energy actions={<SimTag />}>
            <p className="settings-note"><FlaskConical size={14} aria-hidden />这些选项只影响模拟器，用于演示各种状态。</p>
            <div className="settings-list">
              <SettingRow title="模拟速度" desc="加快模拟器的计时，更快看到运行结果。">
                <Segmented<SpeedKey>
                  label="模拟速度"
                  options={SPEED_OPTIONS}
                  value={String(settings.simSpeed) as SpeedKey}
                  onChange={(v) => actions.setSetting('simSpeed', Number(v) as SimSpeed)}
                />
              </SettingRow>
              <div className="settings-item">
                <Switch
                  label="注入失败"
                  description="「代码重构」模板首次运行时，在「运行测试」步骤模拟失败，用来演示失败与重试"
                  checked={settings.injectFailure}
                  onChange={(v) => actions.setSetting('injectFailure', v)}
                />
              </div>
              <SettingRow
                title="模拟模型网关断开"
                descId={gwNoteId}
                desc={gwDown
                  ? (gw?.status === 'reconnecting' ? '模型网关正在重连，恢复后才能再次模拟断开。' : '模型网关已断开，将自动重连。')
                  : '运行中的任务会自动暂停，并在倒计时后重连，用来演示连接异常。'}
              >
                <Button icon={Unplug} disabled={gwDown} aria-describedby={gwNoteId} onClick={() => actions.simulateDisconnect(GATEWAY_ID)}>模拟断开</Button>
              </SettingRow>
              <SettingRow title="重置演示数据" desc="清空当前所有任务与运行，恢复 3 个示例任务。设置会保留。">
                <Button variant="danger" icon={RotateCcw} onClick={() => actions.openDialog({ kind: 'reset-demo' })}>重置演示数据</Button>
              </SettingRow>
            </div>
          </Panel>

          <Panel className="settings-span" label="条款" title="免责声明与使用条款" icon={FileText} energy id="terms">
            <p className="settings-terms__lead">使用本软件前，请阅读并理解以下条款。</p>
            <div className="settings-terms">
              {TERMS.map((s) => (
                <article key={s.title} className="settings-terms__section">
                  <h3>{s.title}</h3>
                  {s.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
                  {s.items && (
                    <ul>
                      {s.items.map((it, i) => (
                        <li key={i}>
                          {it.href
                            ? <a href={it.href} target="_blank" rel="noopener noreferrer">{it.text}<ExternalLink size={11} aria-hidden /><span className="sr-only">（在新窗口打开）</span></a>
                            : it.text}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
            </div>
          </Panel>

          <Panel className="settings-span" label="版本" title="关于" icon={Info} energy>
            <dl className="settings-about">
              <div><dt>版本</dt><dd>{APP_VERSION}</dd></div>
              <div><dt>源代码</dt><dd><a href={REPO_URL} target="_blank" rel="noopener noreferrer">GitHub · xtdf0224-boop/firefly-harness</a>（MIT，仅限源代码）</dd></div>
              <div><dt>反馈</dt><dd><a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">GitHub Issues</a></dd></div>
              <div><dt>后端</dt><dd>模拟（<code>mockBackend</code>）</dd></div>
              <div><dt>数据保存</dt><dd>本浏览器（<code>localStorage</code>）</dd></div>
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** 背景壁纸: on/off, the two transparency sliders, per-page adjustment and credits. */
function WallpaperSettings() {
  const on = useApp((s) => s.settings.wallpaper);
  const visibility = useApp((s) => s.settings.wallpaperVisibility);
  const glass = useApp((s) => s.settings.panelGlass);
  const adaptive = useApp((s) => s.settings.wallpaperAdaptive);
  const mode = useApp((s) => s.settings.mode);
  const base = import.meta.env.BASE_URL;
  const isDefault = visibility === DEFAULT_SETTINGS.wallpaperVisibility && glass === DEFAULT_SETTINGS.panelGlass && adaptive === DEFAULT_SETTINGS.wallpaperAdaptive;
  const reset = () => {
    actions.setSetting('wallpaperVisibility', DEFAULT_SETTINGS.wallpaperVisibility);
    actions.setSetting('panelGlass', DEFAULT_SETTINGS.panelGlass);
    actions.setSetting('wallpaperAdaptive', DEFAULT_SETTINGS.wallpaperAdaptive);
  };
  return (
    <section className="settings-item settings-wallpaper" aria-labelledby="settings-wallpaper-title">
      <div className="settings-wallpaper__head">
        <h3 id="settings-wallpaper-title" className="settings-wallpaper__title"><ImageIcon size={15} aria-hidden />背景壁纸</h3>
        <Button size="sm" variant="ghost" icon={RotateCcw} disabled={!on || isDefault} onClick={reset}>恢复默认透明度</Button>
      </div>
      <Switch
        label="显示壁纸"
        description="流萤模式是星空下飞行的流萤，萨姆模式是青焰中的流萤；切换视觉模式时壁纸跟着切换。"
        checked={on}
        onChange={(v) => actions.setSetting('wallpaper', v)}
      />
      <div className="settings-wallpaper__thumbs" role="list" aria-label="壁纸">
        {WALLPAPERS.map((w) => (
          <figure key={w.id} role="listitem" className={cx('settings-wallpaper__thumb', w.mode === mode && 'is-current', !on && 'is-off')}>
            <img src={`${base}wallpapers/${w.id}-1600.avif`} alt={`${w.mode === 'firefly' ? '流萤' : '萨姆'}模式壁纸：${w.title}`} loading="lazy" decoding="async" style={{ objectPosition: w.focus }} />
            <figcaption>
              <span className="settings-wallpaper__mode">{w.mode === 'firefly' ? '流萤模式' : '萨姆模式'}{w.mode === mode && <span className="settings-wallpaper__now">当前</span>}</span>
              <a href={w.credit.url} target="_blank" rel="noopener noreferrer">{w.credit.label}<ExternalLink size={11} aria-hidden /><span className="sr-only">（在新窗口打开）</span></a>
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="settings-wallpaper__sliders">
        <Slider
          label="壁纸可见度"
          value={visibility}
          onChange={(v) => actions.setSetting('wallpaperVisibility', v)}
          disabled={!on}
          ends={['朦胧', '清晰']}
          description="壁纸透过夜色遮罩的程度。文字周围有一圈淡淡的深色光晕，调到最清晰也能读。"
        />
        <Slider
          label="面板通透度"
          value={glass}
          onChange={(v) => actions.setSetting('panelGlass', v)}
          disabled={!on}
          ends={['稳重', '通透']}
          description="面板像烟色玻璃一样透出壁纸，越通透透出越多，文字光晕也随之加强。代码、日志和输入框始终不透明。"
        />
      </div>
      <Switch
        label="按页面自动调节"
        description="欢迎页让壁纸更清楚；工作区、运行历史等信息密集的页面自动压暗。"
        checked={adaptive}
        disabled={!on}
        onChange={(v) => actions.setSetting('wallpaperAdaptive', v)}
      />
      <p className="settings-wallpaper__credit">想完整看壁纸：点导航栏底部的眼睛图标或按 Alt + W（赏图），Esc 返回。</p>
      <p className="settings-wallpaper__credit">两张壁纸都是同人作品，经 wallhaven 获取，版权归原作者，仅供本机使用。</p>
    </section>
  );
}
