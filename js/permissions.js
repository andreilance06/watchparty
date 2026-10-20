export const DEFAULT_PERMISSIONS = Object.freeze({ playPause: true, seek: false, playbackRate: false });

export function canControl(state, mode) {
  if (state.role === "host") return true;
  const key = ({ play: "playPause", pause: "playPause", seek: "seek", rate: "playbackRate" })[mode];
  return Boolean(key && (state.permissions || DEFAULT_PERMISSIONS)[key]);
}
