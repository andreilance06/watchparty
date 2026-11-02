# Seek presentation and ffprobe validation

Validated on Windows with desktop Chrome, Movi 0.4.1, and local browser-hosted 45-second fixtures. The MKV fixture uses H.264/PCM to require compatibility streaming; its MP4 counterpart uses H.264/AAC for native Original playback. Compatibility output selected the NVIDIA hardware decode/scale/encode pipeline.

| Check | Result |
| --- | --- |
| Delayed compatibility preparation | A two-second prefetch delay retained the previous picture, requested `00:28`, and `00:45` duration. The replacement frame released the overlay. |
| Paused backward and playing forward seeks | Both native and compatibility playback reached their targets and cleared the hold without zeroing the UI clock or duration. |
| Rapid seeks | The final target won, one held frame remained, and obsolete frame callbacks could not complete the latest seek. |
| Seek to zero | Zero appeared as the requested position while the known duration remained visible. |
| Fullscreen compatibility seek | The held frame stayed inside the player, the clock remained stable, and the hold cleared at the target. |
| Encoder status | The hardware pipeline label survived compatibility seeks and preparation/replacement. Native Original showed Direct playback. |
| Discovery and probing | The richer external ffprobe was selected independently of FFmpeg. The bundled ffprobe passed JSON/capability inspection. Real media and fragmented timeline tests used ffprobe metadata. |

Frame-by-frame browser sampling checked the visible clock/duration and overlay lifecycle; a screenshot during delayed preparation confirmed the previous picture remained visible. These checks exposed Movi's direct label reset during disposal and paused native frames arriving before callback registration; both have regression coverage.

Automated tests cover structured subtitle/font/HDR metadata, rational rates, silent media, timeline fallback, probe cancellation, executable selection/fallback, bounded frame capture, stale callbacks, retired players, native/HLS paused completion, timeout, cleanup, and the unchanged synchronization clock. All 290 Node tests pass with no skips. Desktop Firefox/Safari, mobile browsers, and visual WASM/WebCodecs playback were not exercised in this run.

## Rapid-seek regression validation (2026-11-02)

Compatibility preparation now cancels superseded fetches and waits for the accepted seek acknowledgement. Replacement notifications carry playback and stream generations, so repeated notifications cannot restart the same preparation or restore an obsolete target. Recovery uses the accepted room clock rather than the retired player's position.

Automated stress cases cover bursts of 3, 5, 10, and 20 forward, backward, and alternating seeks, both paused and playing, with grouped acknowledgements and interleaved fragment downloads. They exercise obsolete successful/error responses, delayed bodies, duplicate notifications, manual quality, endpoint targets, held-frame completion, and rejected seeks. A real FFmpeg/server integration case replaces 20 generations with requests in flight, verifies the final fragment and obsolete URLs, and checks encoder permits are released.

An isolated headless desktop Chrome instance also played a browser-hosted 150-second H.264/PCM MKV through Auto compatibility streaming with the CPU encoder. Six bursts of 20 seeks covered forward, backward, and alternating directions while paused and playing. Each reached its final target, released the held frame, retained Auto and transport state, and produced no quality or seek errors, including an additional eleven-second timeout observation window. This run used the actual Movi player/controller and WebSocket/server pipeline; Firefox, Safari, mobile browsers, and hardware encoding were not exercised in this regression check.
