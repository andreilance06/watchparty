import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './shared.jsx';
import { Hub } from './Hub.jsx';
import { RoomLoading } from './RoomLoading.jsx';
import './styles.css';

const Watch = lazy(() => import('./Watch.jsx').then(module => ({ default: module.Watch })));

// Discard the obsolete preference for the removed reaction bar.
try { localStorage.removeItem('watchparty-reaction-presets'); } catch { /* Optional browser storage. */ }

createRoot(document.getElementById('root')).render(
  <React.StrictMode><ThemeProvider><Suspense fallback={<RoomLoading />}>{location.pathname === '/watch' ? <Watch /> : <Hub />}</Suspense></ThemeProvider></React.StrictMode>,
);
