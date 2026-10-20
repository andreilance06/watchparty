// Movi 0.4.1's native wrapper forwards transport state but omits seek/rate
// events. Bridge those through its public video getter without patching Movi.
export function createMediaEventBridge(video) {
  let native, player, originalSeek, wrappedSeek, handlers = [];
  function connect() {
    const nextPlayer = video.player;
    const next = nextPlayer?.getHLSVideoElement?.() || nextPlayer?.getVideoElement?.() || null;
    if (next === native && nextPlayer === player) return;
    for (const [type, handler] of handlers) native?.removeEventListener(type, handler);
    if (player?.seek === wrappedSeek && originalSeek) player.seek = originalSeek;
    handlers = []; native = next; player = nextPlayer;
    originalSeek = wrappedSeek = null;
    if (!native) return;
    // UI/property seeks use the public method; HLS recovery writes the native
    // clock directly and must never become a room seek command.
    if (player.getHLSVideoElement?.() && typeof player.seek === "function") {
      originalSeek = player.seek;
      const activePlayer = player, seek = originalSeek;
      wrappedSeek = function(time, options) {
        if (!options?.internal && !video.dispatchEvent(new CustomEvent("watchparty-seek-intent", { detail: { time }, cancelable: true }))) return;
        return seek.call(activePlayer, time, options);
      };
      player.seek = wrappedSeek;
    }
    for (const type of ["seeking", "seeked", "ratechange", "timeupdate"]) {
      const handler = () => video.dispatchEvent(new Event(type));
      native.addEventListener(type, handler); handlers.push([type, handler]);
    }
  }
  video.addEventListener("nativefallback", connect);
  return { connect };
}
