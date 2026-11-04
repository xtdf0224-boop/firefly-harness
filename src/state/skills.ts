/* 技能: what is installed (read from the desktop side), and how a task's skills reach the model.
   A turn that can act (a command-line agent, or an API model with the workbench's tools in a 工作 task)
   gets a list with each SKILL.md path and reads the ones that fit (scripts run under the usual
   approvals); a turn that cannot read files (chat, the summary, older API tasks, an API turn whose
   tools lack read_file) gets the instructions themselves in the system prompt. */
import { desktop } from '../lib/desktop';
import type { SkillInfo, Task, TaskKind } from '../lib/types';
import { announce, toast } from './engine';
import { store } from './store';

const feedback = (tone: 'success' | 'danger' | 'info' | 'warning', title: string, body?: string) =>
  store.update((d) => { toast(d, { tone, title, body }); announce(d, `${title}${body ? `：${body}` : ''}`); });

export async function refreshSkills() {
  if (!desktop?.skills) return;
  try {
    const r = await desktop.skills.list();
    store.update((d) => { d.skills = { root: r.root, list: r.skills, loaded: true }; });
  } catch { /* keep what we had */ }
}

export const skillActions = {
  refresh: refreshSkills,
  async import() {
    if (!desktop?.skills) return;
    let r = await desktop.skills.import();
    if (!r.ok && r.conflict && r.token) {
      if (!window.confirm(`已经有名为「${r.conflict}」的技能了。用新导入的替换它吗？`)) return;
      r = await desktop.skills.confirmImport(r.token);
    }
    if (r.ok) { await refreshSkills(); feedback('success', '技能已导入', r.name); }
    else if (!('canceled' in r && r.canceled)) feedback('danger', '没能导入技能', r.error);
  },
  /** Electron has no window.prompt: the name comes from the panel's own input. */
  async create(name: string) {
    if (!desktop?.skills) return false;
    const r = await desktop.skills.create(name);
    if (!r.ok) { feedback('danger', '没能新建技能', r.error); return false; }
    await refreshSkills();
    await desktop.skills.open(r.name);
    feedback('success', '已新建技能', `在打开的文件夹里编辑 SKILL.md，改好后回来点「刷新」。`);
    return true;
  },
  async installExamples() {
    if (!desktop?.skills) return;
    const r = await desktop.skills.installExamples();
    if (!r.ok) { feedback('danger', '没能装入示例', r.error); return; }
    await refreshSkills();
    feedback('success', r.added.length ? `已装入 ${r.added.length} 个示例技能` : '示例技能都已经装过了', r.added.join('、') || undefined);
  },
  async setEnabled(folder: string, enabled: boolean) {
    if (!desktop?.skills) return;
    await desktop.skills.setEnabled(folder, enabled);
    store.update((d) => { const s = d.skills?.list.find((x) => x.folder === folder); if (s) s.enabled = enabled; });
  },
  async remove(folder: string) {
    if (!desktop?.skills) return;
    if (!window.confirm(`删除技能「${folder}」？文件夹会移到回收站，可以从那里恢复。`)) return;
    const r = await desktop.skills.remove(folder);
    if (!r.ok) { feedback('danger', '没能删除技能', r.error); return; }
    await refreshSkills();
    feedback('info', '技能已删除', `${folder} 已移到回收站。`);
  },
  open: (folder?: string) => void desktop?.skills?.open(folder),
};

/** Skills offered for a kind of task: installed, enabled, valid, and meant for that kind. */
export function skillsForKind(list: SkillInfo[] | undefined, kind: TaskKind): SkillInfo[] {
  return (list ?? []).filter((s) => s.enabled && !s.error && s.modes.includes(kind));
}

/** The skills a task uses: its own pick, else every enabled one for its kind. */
export function taskSkills(task: Task): SkillInfo[] {
  const offered = skillsForKind(store.get().skills?.list, task.kind ?? 'work');
  return task.skills ? offered.filter((s) => task.skills!.includes(s.folder)) : offered;
}

const BODY_BUDGET = 30_000;

/** System-prompt section for a task's skills. `inline`: the turn cannot read files (no tools, or tools without read_file), so it gets the
    text itself; otherwise it reads the files. `shell`: such a turn still has a command tool, so it is also told where each skill's folder
    is and that the scripts there can be run. */
export function skillsPrompt(task: Task, inline: boolean, shell = false): string {
  const list = taskSkills(task);
  if (!list.length) return '';
  if (!inline) {
    return [
      '## 技能',
      '使用者安装了下面这些技能。当前请求和某个技能的说明相符时，先用读取工具读它的 SKILL.md，再按里面的步骤做；技能文件夹里的脚本和资料可以按说明使用（路径相对那个 SKILL.md 所在的文件夹）。不相关就不要读。',
      ...list.map((s) => `- ${s.name}：${s.description}\n  SKILL.md：${s.skillFile}`),
    ].join('\n');
  }
  let used = 0;
  const full: string[] = [];
  const brief: string[] = [];
  const where = (s: SkillInfo) => (shell ? `\n文件夹：${s.dir}` : '');
  for (const s of list) {
    if (used + s.body.length <= BODY_BUDGET) { full.push(`### ${s.name}\n说明：${s.description}${where(s)}\n\n${s.body}`); used += s.body.length; }
    else brief.push(`- ${s.name}：${s.description}${where(s).replace('\n', '；')}（正文太长，没有放进来）`);
  }
  return [
    '## 技能',
    shell
      ? '下面是使用者安装的技能。当前请求和某个技能相关时，按它的说明行事；不相关就忽略。这一轮没有读取文件的工具，所以说明已经附在下面；技能文件夹里的脚本可以用命令行工具运行（路径见各技能的「文件夹」，会先征求使用者确认），里面的资料文件也只能这样看。'
      : '下面是使用者安装的技能。当前请求和某个技能相关时，按它的说明行事；不相关就忽略。这一轮不能运行脚本或读写文件；技能里需要这些的步骤，请说明要在「新建 › 工作」任务里做。',
    ...full,
    ...(brief.length ? ['其他技能：', ...brief] : []),
  ].join('\n\n');
}
