import { DEFAULT_PERMISSIONS } from "../shared/permission-catalog.mjs";
export { PERMISSION_CATALOG, DEFAULT_PERMISSIONS } from "../shared/permission-catalog.mjs";

export function can(state, key) {
  return state.role === "host" || Boolean(({ ...DEFAULT_PERMISSIONS, ...state.permissions })[key]);
}
export function canControl(state, mode) {
  return can(state, ({ play: "playPause", pause: "playPause", seek: "seek", rate: "playbackRate" })[mode]);
}
