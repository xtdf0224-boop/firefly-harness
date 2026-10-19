/* 模型接入: the eight vendors, each usable through its CLI (account login) or an API key, with the
   model and 推理强度 each one starts with, plus the vendor new 闲聊 / 工作 start on.
   Model calls only work in the desktop app. */
import { Cpu, ShieldCheck, Star, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { DRIVERS, PROVIDERS, modelName } from '../../lib/providers';
import type { ProviderId } from '../../lib/types';
import { defaultChoice, engineChoices, modelActions, refreshModels } from '../../state/models';
import { useApp } from '../../state/store';
import '../../styles/models-agents.css';
import { Badge, Panel } from '../ui';
import { MenuSelect } from '../ui/MenuSelect';
import { ProviderCard } from './models/ProviderCard';
import { ViewHeader } from './config/ViewHeader';

export function ModelsView() {
  const models = useApp((s) => s.models);
  useEffect(() => { void refreshModels(); }, []);
  const choices = engineChoices(models);
  const options = PROVIDERS.flatMap((p) => {
    const mine = choices.filter((c) => c.provider === p.id);
    if (!mine.length) return [];
    return [{
      value: p.id as string,
      label: p.name,
      sub: mine.map((c) => (c.auth === 'api' ? 'API 密钥' : DRIVERS[c.driver ?? p.drivers[0]].label)).join(' · '),
      meta: mine[0].model ? modelName(p, mine[0].model) : '工具默认模型',
    }];
  });
  const current = defaultChoice(models, choices)?.provider ?? '';

  return (
    <div className="view models-view">
      <ViewHeader icon={Cpu} title="模型接入" desc="每家服务可以用官方命令行工具登录账号，或保存 API 密钥。在卡片里选好模型和推理强度，新建闲聊或工作时就会用它们。" />

      {!models.desktop && (
        <div className="callout callout--warning" role="note">
          <TriangleAlert size={18} aria-hidden className="callout__icon" />
          <div className="callout__body">
            <p className="callout__text">浏览器开发版不能调用模型，也不能保存密钥。请使用桌面版（安装包，或在源码目录运行 <code>npm run app</code>）。</p>
          </div>
        </div>
      )}
      {models.desktop && !models.encryption && (
        <div className="callout callout--warning" role="note">
          <TriangleAlert size={18} aria-hidden className="callout__icon" />
          <div className="callout__body"><p className="callout__text">系统加密不可用，暂时无法保存 API 密钥；命令行登录不受影响。</p></div>
        </div>
      )}

      <Panel label="默认" title="新建时默认使用" icon={Star} energy className="models-default"
        actions={<Badge tone={options.length ? 'success' : 'neutral'}>{options.length ? `${options.length} 家可用` : '还没有接入'}</Badge>}>
        <div className="models-default__row">
          {options.length > 0 ? (
            <>
              <label className="sr-only" htmlFor="models-default">新建闲聊和工作时默认使用的模型</label>
              <div className="models-default__select">
                <MenuSelect variant="field" id="models-default" label="新建时默认使用" icon={Cpu} value={current} options={options}
                  onChange={(v) => modelActions.setDefault(v as ProviderId)} minWidth={300} />
              </div>
              <p className="models-default__hint">新建时先选这一家，也可以临时换成别的。只有已经接好的服务会出现在这里。</p>
            </>
          ) : (
            <p className="models-default__empty">还没有可用的模型，先在下面接入一个</p>
          )}
        </div>
      </Panel>

      <div className="models-grid">
        {PROVIDERS.map((p) => <ProviderCard key={p.id} info={p} disabled={!models.desktop} />)}
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
