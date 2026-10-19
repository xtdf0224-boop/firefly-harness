/* Welcome + new task (view 'new'). Hero → composer → recent tasks.
   Components live in ./tasks; styles in styles/views-tasks.css (.new-task-*). */
import { Composer } from './tasks/Composer';
import { Hero } from './tasks/Hero';
import { RecentTasks } from './tasks/RecentTasks';

export function NewTaskView() {
  return (
    <div className="view new-task-view">
      <div className="new-task">
        <Hero />
        <Composer />
        <RecentTasks />
      </div>
    </div>
  );
}
