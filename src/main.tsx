import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/600.css';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@xyflow/react/dist/base.css';
import './ui/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { useApp } from './ui/state/store';
import sample from '../fixtures/05-pg-dump-realistic.sql?raw';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Start with a realistic example so the tool explains itself.
useApp.getState().loadSql(sample, '05-pg-dump-realistic.sql');
