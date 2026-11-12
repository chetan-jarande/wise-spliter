import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { LedgerProvider } from './state/LedgerContext';
import { App } from './App';

const isDevEnv = Boolean(
  (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV
);

if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (isDevEnv) {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(registrations.map((reg) => reg.unregister()))
        )
        .catch(() => {});
      if ('caches' in window) {
        caches
          .keys()
          .then((keys) =>
            Promise.all(
              keys
                .filter((k) => k.startsWith('wise-spliter-'))
                .map((k) => caches.delete(k))
            )
          )
          .catch(() => {});
      }
    } else {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Ignore service worker registration errors in unsupported or test environments
      });
    }
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LedgerProvider>
      <App />
    </LedgerProvider>
  </React.StrictMode>
);

