import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './shared.jsx';
import { Hub } from './Hub.jsx';
import './styles.css';

const Watch = lazy(() => import('./Watch.jsx').then(module => ({ default: module.Watch })));

// Discard the obsolete preference for the removed reaction bar.
try { localStorage.removeItem('watchparty-reaction-presets'); } catch { /* Optional browser storage. */ }

createRoot(document.getElementById('root')).render(
  <React.StrictMode><ThemeProvider><Suspense fallback={<p className="p-8 text-muted" role="status">Opening your watch party…</p>}>{location.pathname === '/watch' ? <Watch /> : <Hub />}</Suspense></ThemeProvider></React.StrictMode>,
);
