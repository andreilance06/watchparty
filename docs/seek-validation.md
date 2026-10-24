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
