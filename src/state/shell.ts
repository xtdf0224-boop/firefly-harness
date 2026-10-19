/* 系统托盘 and system notifications: keeps the desktop shell in step with the page. The shell hides the
   window into the tray when 关闭窗口时缩小到托盘 is on, shows a notification for what needs the user
   (an approval, a finished or failed run) while the window is hidden or in the background, and sends
   back what the tray menu or a clicked notification asks for. */
import { desktop, type DesktopCommand } from '../lib/desktop';
import type { Toast } from '../lib/types';
import { actions } from './actions';
import { store } from './store';

/** The toasts worth a system notification, and what clicking it opens. */
function notification(t: Toast): { title: string; body?: string; command?: DesktopCommand } | undefined {
  const cmd = t.action?.command;
  if (t.key?.startsWith('approval:')) return { title: t.title, body: t.body, command: { type: 'approvals' } };
  const task = cmd && cmd.type === 'open-task' ? cmd.taskId : cmd && cmd.type === 'open-console' ? cmd.taskId : undefined;
  if (t.title === '任务完成' || (t.tone === 'danger' && t.key?.startsWith('run:'))) {
    return { title: t.title, body: t.body, command: task ? { type: 'open-task', taskId: task } : undefined };
  }
  return undefined;
}

function run(cmd: DesktopCommand) {
  switch (cmd.type) {
    case 'new': actions.navigate('new'); actions.requestFocus('composer'); return;
    case 'close-to-tray': actions.setSetting('closeToTray', !!cmd.value); return;
    case 'approvals': actions.run({ type: 'show-approvals' }); return;
    case 'open-task': if (store.get().tasks[cmd.taskId]) actions.openTask(cmd.taskId); return;
    default: return;
  }
}

export function startShellSync() {
  const shell = desktop?.app;
  if (!shell) return;
  let closeToTray = store.get().settings.closeToTray;
  shell.setPrefs({ closeToTray });
  const seen = new Set(store.get().toasts.map((t) => t.id));
  store.subscribe(() => {
    const s = store.get();
    if (s.settings.closeToTray !== closeToTray) {
      closeToTray = s.settings.closeToTray;
      shell.setPrefs({ closeToTray });
    }
    for (const t of s.toasts) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      // The shell only shows it when the window is hidden, minimized or not in front.
      const n = notification(t);
      if (n) shell.notify(n);
    }
    if (seen.size > 300) { seen.clear(); for (const t of s.toasts) seen.add(t.id); }
  });
  shell.onCommand(run);
}
