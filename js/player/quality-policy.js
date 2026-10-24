export function chooseAutomaticQuality({ options, bitrate = "auto", bps = 0, sourceBitrate = 0,
  sourceSupported = false, providerBps = 0, pressure = 0, encodingRatio = 0, current }) {
  const budget = bps > 0 ? bps * 0.7 : 0;
  const candidates = options.map(option => ({ ...option, bitrate: bitrate === "auto" ? option.bitrate : Math.min(option.bitrate, bitrate) }))
    .filter(option => !budget || (option.bitrate + 192000) * 1.1 <= budget);
  const overloaded = pressure > 0.9 || encodingRatio > 1.1;
  if (sourceSupported && bitrate === "auto" && (!budget || sourceBitrate > 0 && sourceBitrate * 1.15 <= budget) &&
      (!providerBps || !sourceBitrate || providerBps >= sourceBitrate * 1.15)) return { id: "source", reason: "Original playback fits this connection" };
  let profile = candidates[0] || options.at(-1);
  if (!profile) return null;
  if (!budget) profile = candidates.find(option => Number(option.quality) <= 720) || profile;
  if (overloaded && current && current.id !== "source") {
    profile = candidates.find(option => option.height < current.height) || candidates.at(-1) || profile;
  }
  profile = { ...profile, bitrate: bitrate === "auto" ? profile.bitrate : Math.min(profile.bitrate, bitrate) };
  return { ...profile, id: `${profile.width}x${profile.height}_${profile.bitrate}`,
    reason: overloaded ? "Adjusting to server demand" : budget ? "Selected for measured connection speed" : "Measuring connection speed" };
}

export function createQualityHysteresis() {
  let lastSwitch = 0, poor = 0, upgradeSince = 0;
  return {
    reset(now = 0) { lastSwitch = now; poor = 0; upgradeSince = 0; },
    evaluate({ now, current, candidate, urgent = false }) {
      if (!candidate || !current || candidate.id === current.id) { poor = 0; upgradeSince = 0; return false; }
      const lower = candidate.id !== "source" && (current.id === "source" || candidate.height < current.height ||
        candidate.height === current.height && candidate.bitrate < current.bitrate);
      if (lower) { poor++; upgradeSince = 0; }
      else { poor = 0; upgradeSince ||= now; }
      if (now - lastSwitch < 10000 || !(lower ? poor >= 2 || urgent : now - upgradeSince >= 30000)) return false;
      lastSwitch = now; poor = 0; upgradeSince = 0; return true;
    }
  };
}
