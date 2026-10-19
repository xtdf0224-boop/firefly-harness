/* Home greeting, the way chat apps open: the light-wing mark, a title, and — with the persona on —
   流萤 (or 萨姆) saying hello for the time of day, with her little status. */
import { useNow } from '../../../lib/hooks';
import { greeting, mood, PERSONA } from '../../../lib/persona';
import { awayMs } from '../../../lib/presence';
import { shallow, useApp } from '../../../state/store';
import { WingMark } from '../../decor/WingMark';

export function Hero() {
  const st = useApp((s) => ({ mode: s.settings.mode, persona: s.settings.persona, greet: s.settings.lifeGreeting, moodOn: s.settings.lifeMood, name: s.settings.callName }), shallow);
  const now = useNow(60_000);
  const p = PERSONA[st.mode];
  const line = st.persona && st.greet ? greeting(st.mode, st.name.trim() || '开拓者', awayMs, new Date(now)) : '';

  return (
    <section className="home-hero" aria-labelledby="home-title">
      <WingMark size={84} glow animated className="home-hero__mark" />
      <h1 className="home-hero__title" id="home-title">让萤火照亮下一步</h1>
      {line ? (
        <p className="home-hero__greet">
          <span className="home-hero__who">{p.name}{st.moodOn && <span className="home-hero__mood">{mood(st.mode, 'idle', new Date(now))}</span>}</span>
          <span className="home-hero__say">{line}</span>
        </p>
      ) : (
        <p className="home-hero__lead">可以只是闲聊，也可以交给 Agent 一个目标：它会拆解计划、调用工具，并在关键操作前征求你的确认。</p>
      )}
    </section>
  );
}
