/* Home (view 'new'): greeting → the centered message box → recent conversations.
   Until a model is ready the box is locked and a card says how to connect one.
   Components live in ./tasks; styles in styles/views-live.css (.home-*) and views-tasks.css. */
import { useApp } from '../../state/store';
import { Composer } from './tasks/Composer';
import { FirstRun } from './tasks/FirstRun';
import { Hero } from './tasks/Hero';
import { RecentTasks } from './tasks/RecentTasks';
import { useChoices, useModelsKnown } from './tasks/choices';

export function NewTaskView() {
  const { choices } = useChoices();
  const known = useModelsKnown();
  const desktopOk = useApp((s) => s.models.desktop);

  return (
    <div className="view home-view">
      <div className="home">
        <div className="home__center">
          <Hero />
          {known && choices.length === 0 && <FirstRun desktopOk={desktopOk} />}
          <Composer />
        </div>
        <RecentTasks />
      </div>
    </div>
  );
}
