# WebCodecs validation — 2026-10-21

Automatic selection remains native first, then suitable WebCodecs playback, then compatibility streaming. The measurements below support that order on the tested machine: native playback has the lowest browser memory cost and fastest seeks, while WebCodecs avoids the additional server encoding cost for supported MKV files.

## Environment and method

- Windows, AMD Ryzen 7 7435HS, 8 cores / 16 logical processors; headless Chrome 155, 1280×900 viewport, no CPU or network throttling.
- Browser and Node server ran on the same machine over loopback. Localhost was a secure context with `crossOriginIsolated === false`.
- Generated a 45-second 1920×1080, 30 fps H.264 test pattern with stereo 48 kHz AAC. MP4 and MKV samples shared compressed streams; the original file was approximately 84.4 MiB. Compatibility used the existing CPU libx264 encoder and stereo AAC output.
- Three 30-second playback runs per path, followed by a paused seek to 39 seconds. Page assets were warm. First-frame times use `watchpartyMetrics.firstPictureMs`, excluding file selection and page/asset loading.
- CPU values approximate the average percentage of one CPU core across opening, playback, and seeking; 100% represents one core. Browser values sum its processes. FFmpeg processes were sampled during compatibility playback so retired encoders remained included. Node and FFmpeg costs are reported separately.
- Heap values are the median sampled peak JavaScript heap, not total browser/GPU memory. Transfer values count completed media resource timing entries, including prefetch and seek requests. These figures are local observations, not battery, GPU, mobile-device, or WAN benchmarks.

## Results

Medians across three runs:

| Path | First frame | Seek after 30 s | Browser CPU | Node CPU | FFmpeg CPU | Peak JS heap | Media transferred |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Native MP4 | 166 ms | 52 ms | 43.1% | 3.1% | 0% | 12.9 MiB | 84.4 MiB |
| WebCodecs MKV | 404 ms | 1,965 ms | 51.0% | 2.9% | 0% | 205.5 MiB | 87.4 MiB |
| Compatibility HLS | 1,167 ms | 209 ms | 49.6% | 5.7% | 105.6% | 33.3 MiB | 32.8 MiB |

All nine runs advanced approximately 30 seconds without a detected stall lasting one second. Native reported zero dropped frames, WebCodecs rendered 905–907 frames, and compatibility reported 0–1 dropped frames. The WebCodecs drop counter was sampled after seeking, when it had reset, and is excluded from the comparison. All first frames met the project's three-second target; all measured seeks met its two-second target on this setup. WebCodecs steady-playback seek results were close to that limit (1,954–1,976 ms).

The original-file paths eagerly downloaded the entire short sample. Their seeks after 30 seconds therefore used buffered bytes. A separate seek immediately after opening a fresh MKV completed in 511 ms, with Movi's downloaded counter increasing from 2.0 to 41.0 MiB and new original-file requests observed. Fresh-source MP4 and HLS seeks measured 160 ms and 198 ms respectively; those observations do not establish that their target data was uncached.

Movi reported `Hardware (WebCodecs)` for video and `Software (FFmpeg)` for AAC audio, despite AAC passing the browser capability check. WebCodecs playback produced a nonzero audio signal and used the audio clock. These results include that runtime audio fallback. Native MP4 and compatibility playback also decoded audio. Headless Chrome mutes physical output, so listening on real viewer devices remains a deployment check.

Compatibility reduced transferred media for this sample but added approximately one CPU core of encoding work. WebCodecs saved that server work at the cost of more client heap and original-file bandwidth. No selection thresholds or software support for unusual audio were added based on this single-machine comparison.

## Functional and HTTPS checks

- Silent MKV played through WebCodecs with `AudioDecoder` removed from the page. An AC-3 MKV selected compatibility streaming. A supported HEVC MKV selected WebCodecs.
- A measured hardware-stutter event switched a paused WebCodecs session to compatibility at the same timestamp, preserving speed and the selected caption. The caption remained visibly rendered after the switch.
- All 117 automated tests passed, including capability deadlines, late rejection handling, supported browser versus standalone WASM decoding, stale source selection, and hardware/software stutter fallback.
- Both existing Caddyfiles adapted successfully with Caddy 2.11.7. Their routing rules were then tested on temporary localhost HTTPS ports against a separate app instance, with an internal test CA explicitly trusted by the test client and system trust installation disabled.
- Both proxy configurations passed certificate verification, room creation with Secure cookies, `/vendor/movi.wasm` MIME checks, exact authenticated byte-range responses (206), and control/source `wss` connections. The public rules returned 404 for default-room media endpoints.
- Public DNS, Internet routing, public ACME issuance, and certificate installation on viewer devices were not exercised. The supplied production Caddyfiles are unchanged; use the [HTTPS setup guide](https.md) for deployment.

To repeat the comparison, generate equivalent MP4/MKV streams, open the app through a real browser, and inspect `watchpartyMetrics` and Movi's player statistics. Run each path three times for 30 seconds on the target device, then test a fresh-source seek, sound, captions, and a compatibility switch. Record browser and server resource costs separately; use the same encoder and network conditions for each comparison.
