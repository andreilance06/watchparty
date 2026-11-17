# Deploy WatchParty on Railway

Use a Railpack-built Node service with the repository root as its root directory and one running instance. The Node server serves the frontend, WebSockets, and media; this is not a static-only Vite deployment.

The root [railpack.json](../railpack.json) selects Node 24 and separates the phases:

The install step explicitly copies `package.json` and `package-lock.json` before running npm. Railpack 0.43.0 replaces generated commands when `steps.install.commands` is overridden, including its generated file-copy commands. A bare `npm ci` override therefore loses the manifests even though they are committed. Both npm and Bun lockfiles are preserved. The `packageManager` field selects npm 11.20.0 ahead of lockfile detection; the install step prepares that version through Corepack 0.36.0 because its command override also replaces Railpack's generated package-manager setup. Both versions support the deployed Node 24.22.2.

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

## EUSAGE: npm ci cannot find a lockfile

Check the generated install plan for copies of both npm manifests before `npm ci --include=dev`. Seeing the files in Git or the final build context does not mean they exist in the isolated install layer. Keep the explicit `COPY:` commands in `railpack.json`; do not remove either lockfile or substitute `npm install` for the project installation to bypass the failure. The detection log should now say **Using npm package manager**. If it still says Bun, verify that the snapshot contains the `packageManager` declaration in the root `package.json` and that the root directory and deployed revision are correct.
