import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { LedgerProvider } from './state/LedgerContext';
import { App } from './App';

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Ignore service worker registration errors in unsupported or test environments
    });
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LedgerProvider>
      <App />
    </LedgerProvider>
  </React.StrictMode>
);

