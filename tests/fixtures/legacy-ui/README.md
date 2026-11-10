# Media regression harness

These frozen pre-React DOM fixtures let the existing VM-based media tests exercise
the retained player adapters without running Movi or a browser. The test loaders
resolve their imports against the current production media and transport modules.

They are not application entrypoints and are never included in `dist` or served by
the backend. Current UI behavior is tested with React Testing Library in `src`.
