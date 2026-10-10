import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installSessionExpiryWatcher } from './utils/sessionExpiry';
import { installChunkRecovery } from './utils/chunkRecovery';
import { initErrorReporting } from './utils/errorReporting';
import './styles/globals.css';

// Installed before anything else loads so it also observes fetch calls made
// by federated module bundles once they mount later.
installSessionExpiryWatcher();
installChunkRecovery();
void initErrorReporting();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
