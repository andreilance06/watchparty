// Explicit ownership for imperative media adapters mounted by React.
export function createLifecycle() {
  const cleanups = [];
  return {
    listen(target, type, handler, options) {
      target?.addEventListener?.(type, handler, options);
      cleanups.push(() => target?.removeEventListener?.(type, handler, options));
    },
    interval(handler, delay) { const id = setInterval(handler, delay); cleanups.push(() => clearInterval(id)); return id; },
    add(cleanup) { cleanups.push(cleanup); },
    dispose() { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); },
  };
}
