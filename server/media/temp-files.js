const fs = require("fs");
const path = require("path");
const os = require("os");

function isWatchPartyTempDirectory(directory) {
  if (!directory) return false;
  const resolved = path.resolve(directory);
  return path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("watchparty-hls-");
}

function removeTempDirectory(directory) {
  if (isWatchPartyTempDirectory(directory)) fs.rm(directory, { recursive: true, force: true }, () => {});
}

module.exports = { isWatchPartyTempDirectory, removeTempDirectory };
