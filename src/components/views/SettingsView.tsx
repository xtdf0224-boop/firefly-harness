import { Database, ExternalLink, FileText, Heart, ImageIcon, Info, Keyboard, Palette, Play, RotateCcw, Settings, Trash2 } from 'lucide-react';
import { ISSUES_URL, REPO_URL, TERMS } from '../../lib/terms';
import { useState, type ReactNode } from 'react';
import { PERSONA } from '../../lib/persona';
import { useMedia, useReducedMotion } from '../../lib/hooks';
import type { MotionPref, ParticleDensity } from '../../lib/types';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import { Button, Kbd, Panel, Segmented, Slider, Switch, cx } from '../ui';
import { WALLPAPERS } from '../decor/wallpapers';
import { DEFAULT_SETTINGS } from '../../state/seed';
import { version as APP_VERSION } from '../../../package.json';
import { ModePicker } from './config/ModePicker';
import { ViewHeader } from './config/ViewHeader';

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
  { id: 'nav', label: '切换导航', keys: <><Kbd>Alt</Kbd><span aria-hidden>+</span><Kbd>1</Kbd><span aria-hidden>…</span><Kbd>7</Kbd></> },
  { id: 'send', label: '发送或创建（Shift + Enter 换行）', keys: <Kbd>Enter</Kbd> },
  { id: 'peek', label: '赏图（淡出界面看壁纸）', keys: <><Kbd>Alt</Kbd><span aria-hidden>+</span><Kbd>W</Kbd></> },
  { id: 'esc', label: '关闭对话框、状态抽屉或赏图', keys: <Kbd>Esc</Kbd> },
];

export function SettingsView() {
  const settings = useApp((s) => s.settings);
  const desktop = useApp((s) => s.models.desktop);
  const osReduced = useMedia('(prefers-reduced-motion: reduce)');
  const reduced = useReducedMotion();

  return (
    <div className="view settings-view">
      <ViewHeader icon={Settings} title="设置" desc="外观、人设、运行行为和数据。设置保存在本机。" />

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
              <div className="settings-item">
                <Switch
                  label="主题光标"
                  description="流萤模式是带一只小萤火虫的银白箭头，可点击的地方变成薄荷色；萨姆模式是装甲箭头配萤火绿能量核心。关掉恢复系统光标。"
                  checked={settings.themeCursor}
                  onChange={(v) => actions.setSetting('themeCursor', v)}
                />
              </div>
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

          <PersonaSettings />

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
              {desktop && (
                <div className="settings-item">
                  <Switch
                    label="关闭窗口时缩小到系统托盘"
                    description="点右上角的关闭，萤火会留在系统托盘里，运行中的任务继续进行；有操作等你确认或任务完成时会弹出系统通知。关掉这一项则关闭即退出。"
                    checked={settings.closeToTray}
                    onChange={(v) => actions.setSetting('closeToTray', v)}
                  />
                </div>
              )}
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

          <Panel label="存储" title="数据" icon={Database} energy>
            <div className="settings-list">
              <SettingRow title="清除所有任务记录" desc="删除全部任务、运行记录和事件时间线。模型接入、Agent、工具策略和外观设置都会保留。">
                <Button variant="danger" icon={Trash2} onClick={() => actions.openDialog({ kind: 'clear-history' })}>清除所有任务记录</Button>
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
              <div><dt>数据保存</dt><dd>任务和设置只保存在这台电脑上；API 密钥由系统加密另存</dd></div>
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

/* ───────────── 人设与活人感 ───────────── */

function PersonaSettings() {
  const st = useApp((s) => s.settings);
  const [name, setName] = useState(st.callName);
  const p = PERSONA[st.mode];
  const other = PERSONA[st.mode === 'sam' ? 'firefly' : 'sam'];
  const commit = () => {
    const v = name.trim().slice(0, 20) || '开拓者';
    setName(v);
    if (v !== st.callName) actions.setSetting('callName', v);
  };
  return (
    <Panel label="人设" title="人设与活人感" icon={Heart} energy>
      <div className="settings-list">
        <div className="settings-item">
          <Switch
            label={`编排 Agent 以「${p.name}」的身份说话`}
            description={`流萤模式下是流萤：${PERSONA.firefly.summary} 萨姆模式下是萨姆：${PERSONA.sam.summary} 切换视觉模式，口吻随之切到${other.name}。`}
            checked={st.persona}
            onChange={(v) => actions.setSetting('persona', v)}
          />
        </div>
        <SettingRow title="她怎么称呼你" desc="闲聊、汇报和问候里都会这样叫你。">
          <input className="input settings-callname" value={name} maxLength={20} aria-label="称呼" disabled={!st.persona}
            onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
        </SettingRow>
        <SettingRow title="回复显示方式" desc="边写边显示：回复一点点出现；写完再显示：先显示「正在输入」，整段写完后一次出现。">
          <Segmented<'natural' | 'instant'> size="sm" label="回复显示方式" value={st.typing} onChange={(v) => actions.setSetting('typing', v)}
            options={[{ value: 'natural', label: '边写边显示' }, { value: 'instant', label: '写完再显示' }]} />
        </SettingRow>
        <div className="settings-item">
          <Switch label="按时间问候" description="欢迎页和新的闲聊里，她会按清晨、深夜等时段打招呼；很久没来时会说「你回来啦」。" checked={st.lifeGreeting} disabled={!st.persona}
            onChange={(v) => actions.setSetting('lifeGreeting', v)} />
        </div>
        <div className="settings-item">
          <Switch label="小状态" description="空闲时名字旁显示她在做什么（在看星星、待命中……），随时段变化；她也知道自己刚才在干嘛。" checked={st.lifeMood} disabled={!st.persona}
            onChange={(v) => actions.setSetting('lifeMood', v)} />
        </div>
        <div className="settings-item">
          <Switch label="主动搭话" description="闲聊安静 8 分钟后，她可能会主动说一句，你不回复时最多连续两次。每次搭话会调用一次模型。" checked={st.lifeNudge}
            onChange={(v) => actions.setSetting('lifeNudge', v)} />
        </div>
      </div>
    </Panel>
  );
}
