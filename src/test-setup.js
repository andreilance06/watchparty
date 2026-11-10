import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); history.replaceState(null, '', '/'); });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
window.matchMedia = vi.fn(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
HTMLElement.prototype.scrollIntoView = vi.fn();
if (!globalThis.CSS) globalThis.CSS = {};
CSS.escape ||= value => String(value).replace(/[^\w-]/g, '\\$&');
