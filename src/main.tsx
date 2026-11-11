import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { LedgerProvider } from './state/LedgerContext';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LedgerProvider>
      <App />
    </LedgerProvider>
  </React.StrictMode>
);
