import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './lib/presence';
import { refreshModels } from './state/models';
import { flushSave, loadState, saveSoon } from './state/persist';
import { startEngine } from './state/runner';
import { startShellSync } from './state/shell';
import { store } from './state/store';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';
import './styles/decor.css';
import './styles/shell.css';
import './styles/console.css';
import './styles/workspace.css';
import './styles/views-tasks.css';
import './styles/views-config.css';
import './styles/views-live.css';
import './styles/menu.css';
import './styles/cursors.css';

const initial = loadState(Date.now());
document.documentElement.dataset.mode = initial.settings.mode;
document.documentElement.dataset.cursor = initial.settings.themeCursor ? 'on' : 'off';
store.init(initial, saveSoon);
startEngine();
void refreshModels();
startShellSync();
window.addEventListener('pagehide', flushSave);
// A file dropped on the window must never replace the app page.
for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, (e) => { if (!e.defaultPrevented) e.preventDefault(); });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
