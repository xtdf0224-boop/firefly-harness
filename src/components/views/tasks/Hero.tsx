/* Welcome hero — the one place (besides the completion toast) that carries character atmosphere.
   The light-wing arcs and armour plates are pure CSS (views-tasks.css); 流萤 shows the soft arcs,
   萨姆 swaps in sharper plating. */
import { SimTag } from '../../ui';
import { WingMark } from '../../decor/WingMark';

export function Hero() {
  return (
    <section className="new-task-hero" aria-labelledby="new-task-hero-title">
      <div className="new-task-hero__art" aria-hidden>
        <span className="new-task-hero__arcs" />
        <span className="new-task-hero__plates" />
      </div>
      <WingMark size={152} glow animated className="new-task-hero__mark" />
      <div className="new-task-hero__copy">
        <p className="label new-task-hero__eyebrow">萤火 · Agent 工作台</p>
        <h1 className="new-task-hero__title" id="new-task-hero-title">让萤火照亮下一步</h1>
        <p className="new-task-hero__lead">
          描述一个目标，编排 Agent 会拆解计划、分派给合适的 Agent，并在写文件、执行命令等关键操作前征求你的确认。
        </p>
        <p className="new-task-hero__demo">
          <SimTag />
          <span>当前为演示模式：任务由浏览器内的模拟器执行，不会调用真实模型或命令。</span>
        </p>
      </div>
    </section>
  );
}
