/* Home (view 'new'): greeting → the centered message box → recent conversations.
   Components live in ./tasks; styles in styles/views-live.css (.home-*) and views-tasks.css. */
import { Composer } from './tasks/Composer';
import { Hero } from './tasks/Hero';
import { RecentTasks } from './tasks/RecentTasks';

export function NewTaskView() {
  return (
    <div className="view home-view">
      <div className="home">
        <div className="home__center">
          <Hero />
          <Composer />
        </div>
        <RecentTasks />
      </div>
    </div>
  );
}
