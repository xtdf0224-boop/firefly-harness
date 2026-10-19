/* The notice for a task whose own model cannot run right now: nothing is connected yet, the way it used
   (a key, a signed-in CLI) is gone, or the task never recorded a model. Says what to do and where.
   Renders nothing while the model is fine. */
import { Cpu, Plus, TriangleAlert } from 'lucide-react';
import { actions } from '../../state/actions';
import { Button } from '../ui';
import { useTaskEngine } from './shared';

export function ModelNotice({ taskId, chat }: { taskId: string; chat: boolean }) {
  const { engine, choices, state } = useTaskEngine(taskId);
  if (state === 'ready') return null;
  const verb = chat ? '聊天' : '运行';

  let title: string;
  let body: string;
  let button: 'models' | 'new' | undefined;
  if (!choices.length) {
    title = '还没有接入模型';
    body = `到「模型接入」登录命令行工具，或填入 API 密钥，之后才能${verb}。`;
    button = 'models';
  } else if (state === 'unavailable') {
    title = `${engine!.label} 现在用不了`;
    body = `可能是登录过期、密钥被删除，或者找不到命令行工具。${chat ? '在输入框下方换一个模型，或到「模型接入」重新配置。' : '到「模型接入」重新配置后就可以继续。'}`;
    button = 'models';
  } else if (chat) {
    title = '这段闲聊还没有选模型';
    body = '在输入框下方的模型菜单里选一个，就可以开始了。';
  } else {
    title = '这个任务没有记录模型';
    body = '它可能来自旧版本。请回到首页新建一个任务，选好模型再运行。';
    button = 'new';
  }

  return (
    <div className="callout callout--warning ws-notice" role="status">
      <TriangleAlert className="callout__icon" size={18} aria-hidden />
      <div className="callout__body">
        <p className="callout__title">{title}</p>
        <p className="callout__text">{body}</p>
      </div>
      {button && (
        <div className="callout__actions">
          {button === 'models'
            ? <Button variant="primary" size="sm" icon={Cpu} onClick={() => actions.navigate('models')}>去模型接入</Button>
            : <Button size="sm" icon={Plus} onClick={() => actions.navigate('new')}>新建任务</Button>}
        </div>
      )}
    </div>
  );
}
