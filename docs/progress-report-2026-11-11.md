# WatchParty - November 11, 2026

**Latest application fix:** `4d0a4b7` - Recover quality segments after encoder capacity conflicts.

**Deployment status:** Three local commits await the project owner's push; the updated Render deployment has not been verified.

## Public deployment

![WatchParty running at ypothesi.space](screenshots/deployment-2026-11-11.png)

WatchParty is accessible at **https://ypothesi.space** on Render. The custom-domain origin mismatch was corrected, and Cloudflare proxying was disabled by the project owner. This screenshot shows the public room directory; it does not establish that the new memory fixes are deployed.

## Reload and chat fixes

![The same named host connected after reloading](screenshots/reload-2026-11-11.png)

Reloading now restores the tab's server-verified connection ID and accepted name. A browser check confirmed the same ID after reload, without the duplicate-name warning. Ordinary reconnects can replace a lingering socket or restore a closed connection. Hosting still follows the existing reconnect grace period.

![Generated test video and an outgoing chat message](screenshots/playback-chat-2026-11-11.png)

Outgoing messages retain their ownership after a reconnect, so old messages stay on the right. The screenshot uses a generated sample video and a test message on the local validation server; it is not a public playback-capacity benchmark. Participant controls also received layout improvements earlier today.

## Lower memory use

Small containers now default to one encoder and bounded decoder/filter/encoder threads, with smaller source caches and fewer concurrent reads. Software conversion avoids lookahead buffering. Static assets stream to viewers instead of being read fully into memory for every request. Thumbnails also use bounded filter threads.

The local `/healthz` check returned `lowMemory: true`, `ffmpegThreads: 1`, and `maxEncoders: 1`. The four-viewer regression successfully delivered the same converted video fragment to all four viewers using one active encoder. The low-memory profile reduces resource demand; arbitrary 4K/HDR conversion is not guaranteed to fit in Render Free.

## Quality-switch segment recovery

The reported failure happened while switching quality and fetching a video segment. Local tests reproduced encoder-capacity races and replacement requests arriving before the previous FFmpeg process finished shutting down.

Temporary capacity failures no longer stay cached as permanent segment errors. Replacement streams wait for the old process to release its slot, and previously created qualities obey the same limit as new ones. When another quality cannot start, the player keeps the current video playing and shows a clear server-busy notice.

**Resource limit:** One encoder can serve multiple viewers of the same quality. Two simultaneously converted qualities still require two encoder slots; the fix does not raise Render's memory limits or enable a second encoder on the low-memory profile.

## Validation and deployment handoff

- **390 backend/browser tests passed**, including quality-capacity recovery and replacement with a single encoder slot.
- **19 React tests passed**, and the production build passed.
- Real-browser reload retained the client ID and name; generated sample video playback loaded without console errors.
- Quality-switch tests cover a race for the final encoder slot, successful segment retry after capacity becomes free, and stream replacement without exceeding the one-encoder limit.
- The project owner will push the commits. The new Render deployment is **pending verification**.

A [Render setup guide](render.md) and [Blueprint](../render.yaml) now document the build, environment, and health check. Existing services should set `WATCHPARTY_LOW_MEMORY=1`, keep `WATCHPARTY_MAX_ENCODERS=1` and `WATCHPARTY_ENCODER=libx264`, and use `/healthz` for health checks. After pushing and deployment, `/healthz` should show the latest commit, `lowMemory: true`, `ffmpegThreads: 1`, and `maxEncoders: 1`.

**Next check:** After deployment, repeat the reported quality switch. Confirm that playable segments load when an encoder slot is available, and that a rejected change preserves current playback. No usable replacement HAR was available for this follow-up; capture a fresh export and matching Render logs if the deployed build still fails.
