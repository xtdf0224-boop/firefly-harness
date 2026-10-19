/* 模型接入: the eight vendors, each usable through its CLI (account login) or an API key, plus the
   default for new 闲聊 / 工作. Model calls only work in the desktop app. */
import { Cpu, Info, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { PROVIDERS, PROVIDER_BY_ID, readiness } from '../../lib/providers';
import type { ProviderId } from '../../lib/types';
import { modelActions, refreshModels } from '../../state/models';
import { useApp } from '../../state/store';
import { Panel } from '../ui';
import { ProviderCard } from './models/ProviderCard';
import { ViewHeader } from './config/ViewHeader';

export function ModelsView() {
  const desktopOk = useApp((s) => s.models.desktop);
  const encryption = useApp((s) => s.models.encryption);
  const def = useApp((s) => s.models.defaultEngine);
  const readyIds = useApp((s) => PROVIDERS.filter((p) => readiness(p, s.models.providers[p.id], s.models.providers[p.id].auth).ready).map((p) => p.id).join(','));
  useEffect(() => { void refreshModels(); }, []);
  const ready = readyIds ? (readyIds.split(',') as ProviderId[]) : [];

  return (
    <div className="view models-view">
      <ViewHeader icon={Cpu} title="模型接入" desc="接入真实模型后，新建闲聊或工作时就能选它。每家都可以用命令行工具登录，或保存 API 密钥。" />

      {!desktopOk && (
        <div className="callout callout--warning" role="note">
          <TriangleAlert size={18} aria-hidden className="callout__icon" />
          <div className="callout__body">
            <p className="callout__text">浏览器开发版不能调用模型，也不能保存密钥。请使用桌面版（安装包，或在源码目录运行 <code>npm run app</code>）。</p>
          </div>
        </div>
      )}
      {desktopOk && !encryption && (
        <div className="callout callout--warning" role="note">
          <TriangleAlert size={18} aria-hidden className="callout__icon" />
          <div className="callout__body"><p className="callout__text">系统加密不可用，暂时无法保存 API 密钥；命令行登录不受影响。</p></div>
        </div>
      )}

      <Panel label="默认" title="新建时默认使用" icon={Info} energy className="models-default">
        <div className="models-default__row">
          <label className="sr-only" htmlFor="models-default">新建闲聊和工作时默认使用的模型</label>
          <select id="models-default" className="select" value={ready.includes(def as ProviderId) || def === 'demo' ? def : 'demo'}
            onChange={(e) => modelActions.setDefault(e.target.value as ProviderId | 'demo')}>
            <option value="demo">演示模式（不调用模型，回复是预设的）</option>
            {ready.map((id) => <option key={id} value={id}>{PROVIDER_BY_ID[id].name}</option>)}
          </select>
          <p className="models-default__hint">新建时还可以临时换成别的。只有已配置好的服务会出现在这里。</p>
        </div>
      </Panel>

      <div className="models-grid">
        {PROVIDERS.map((p) => <ProviderCard key={p.id} info={p} disabled={!desktopOk} />)}
      </div>

      <p className="models-foot">
        <ShieldCheck size={14} aria-hidden />
        <span>
          API 密钥由系统加密（Windows DPAPI）保存在本机的应用数据目录，不写入浏览器存储，界面上只显示末四位。命令行登录由各工具自己保存，萤火不会读取你的账号密码。
          使用真实模型会按各服务商的价格计费，或消耗你的订阅额度。
        </span>
      </p>
    </div>
  );
}
