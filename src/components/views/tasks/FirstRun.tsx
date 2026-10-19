/* 先接入一个模型: what the home page and the task list show until at least one model is ready.
   萤火 ships no model of its own; this says the two ways to connect one and goes to 模型接入. */
import { ArrowRight, KeyRound, Plug, TerminalSquare } from 'lucide-react';
import { actions } from '../../../state/actions';
import { Button, Panel } from '../../ui';

export function FirstRun({ desktopOk }: { desktopOk: boolean }) {
  return (
    <Panel className="first-run" label="开始之前" title="先接入一个模型" icon={Plug} energy>
      <p className="first-run__lead">萤火自己不带模型：接入一个之后，才能聊天，也才能把目标交给 Agent。有两种接法，选一种就行。</p>
      <ul className="first-run__ways">
        <li>
          <TerminalSquare size={16} aria-hidden />
          <p><strong>命令行工具登录</strong><span>已经装了 Claude Code、Codex 等？用自己的账号登录它，Agent 就能在工作文件夹里读写文件、执行命令。</span></p>
        </li>
        <li>
          <KeyRound size={16} aria-hidden />
          <p><strong>API 密钥</strong><span>填一家模型服务的 API Key，密钥加密保存在本机。只用来思考和写作，不会动你的文件。</span></p>
        </li>
      </ul>
      {desktopOk ? (
        <div className="first-run__actions">
          <Button variant="primary" iconRight={ArrowRight} onClick={() => actions.navigate('models')}>去模型接入</Button>
        </div>
      ) : (
        <p className="first-run__note">模型接入需要桌面版。你现在打开的是浏览器里的网页版，没法调用模型。</p>
      )}
    </Panel>
  );
}
