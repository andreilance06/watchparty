const RESOLUTIONS = [360, 480, 720, 1080, 1440, 2160];
const FRAME_RATES = [15, 24, 30, 60];

export function captureQuality(track) {
  const actual = track.getSettings?.() || {}, capabilities = track.getCapabilities?.() || {};
  const width = capabilities.width?.max || actual.width;
  const height = capabilities.height?.max || actual.height;
  const shortEdge = width && height ? Math.min(width, height) : Infinity;
  const maxRate = capabilities.frameRate?.max || 60;
  const resolutions = RESOLUTIONS.filter(value => value <= shortEdge);
  const frameRates = FRAME_RATES.filter(value => value <= maxRate);
  if (!frameRates.length) frameRates.push(Math.max(1, Math.floor(maxRate)));
  return { resolution: shortEdge < 1080 ? 'source' : '1080', frameRate: frameRates.includes(30) ? 30 : frameRates.at(-1),
    resolutions: ['source', ...resolutions.map(String)], frameRates,
    supported: typeof track.applyConstraints === 'function', actual, pending: false, error: '' };
}

export function captureConstraints({ resolution, frameRate }, actual = {}) {
  const constraints = { frameRate: { ideal: frameRate, max: frameRate } };
  if (resolution !== 'source') {
    const shortEdge = Number(resolution), longEdge = Math.round(shortEdge * 16 / 9);
    const portrait = actual.height > actual.width;
    constraints.width = { max: portrait ? shortEdge : longEdge };
    constraints.height = { max: portrait ? longEdge : shortEdge };
  }
  return constraints;
}
