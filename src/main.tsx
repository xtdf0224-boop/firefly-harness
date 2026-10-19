import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { flushSave, loadState, saveSoon } from './state/persist';
import { startEngine } from './state/runner';
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

const initial = loadState(Date.now());
document.documentElement.dataset.mode = initial.settings.mode;
store.init(initial, saveSoon);
startEngine();
window.addEventListener('pagehide', flushSave);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
