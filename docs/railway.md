# Deploy WatchParty on Railway

Use a Railpack-built Node service with the repository root as its root directory and one running instance. The Node server serves the frontend, WebSockets, and media; this is not a static-only Vite deployment.

The root [railpack.json](../railpack.json) selects Node 24 and separates the phases:

| Phase | Command |
| --- | --- |
| Install | `npm ci --include=dev` |
| Build | `npm run build` |
| Start | `npm start` |

In Railway's service settings, set **Build Command** to `npm run build` (or clear the custom command and use the repository plan). Set **Start Command** to `npm start` and **Healthcheck Path** to `/healthz`. Remove the old combined `npm ci --include=dev && npm run build` build override. Development dependencies are required during installation because Vite and the frontend tooling compile the app; the running server uses the built `dist` directory.

Set `PUBLIC_ORIGIN` to the service's public HTTPS origin. Keep Railway's automatic `PORT` and the application's default `HOST=0.0.0.0`. For a small instance, set `WATCHPARTY_LOW_MEMORY=1`, `WATCHPARTY_MAX_ENCODERS=1`, and `WATCHPARTY_ENCODER=libx264`. Rooms are in memory, so a restart clears them. Screen sharing also needs suitable ICE/TURN configuration for the participants' networks; see [screen sharing](screen-sharing.md).

## EBUSY on node_modules/.vite

If a log shows `npm ci` failing to remove `/app/node_modules/.vite` during the build command, installation is being repeated in the compilation phase. Railpack mounts that Vite directory as a build cache, and a mounted cache directory cannot be deleted. `npm ci` removes the existing `node_modules` tree, causing the conflict. Keep it in the install phase and compile separately. See [Railpack's cache documentation](https://railpack.com/config/file#caches) and [Node build phases](https://railpack.com/languages/node).

Do not add cache-deletion commands or dependency-resolution flags to work around a mounted-directory error. If the error still appears after correcting the build command, inspect the generated plan for another reinstall command or temporarily set `RAILPACK_DISABLE_CACHES=*` to diagnose cache mounts, then remove that diagnostic override after resolving the plan. The `npm warn config production` warning is separate from the fatal EBUSY error.

The combined install/build command in the [Render guide](render.md) is specific to Render's build phase. Use the separate Railpack phases on Railway.
