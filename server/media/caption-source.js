const fs = require("node:fs/promises");
const { matroskaCaptions } = require("./containers/matroska");
const { isoCaptions } = require("./containers/iso");
const { aviCaptions, oggCaptions } = require("./containers/legacy");
const { checkedReader, unsupported } = require("./containers/bytes");

// A caption job may only give FFmpeg a small, local subtitle-only input. It
// must never fall back to demuxing the original browser file over HTTP.
function createCaptionSource(source, signal) {
  const reader = checkedReader(source, signal);
  let catalog;
  function discover() {
    if (!catalog) catalog = (async () => {
      const signature = await reader.read(0, Math.min(16, reader.size));
      if (signature.readUInt32BE(0) === 0x1a45dfa3) return matroskaCaptions(reader);
      if (["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(signature.toString("ascii", 4, 8))) return isoCaptions(reader);
      if (signature.toString("ascii", 0, 4) === "RIFF" && signature.toString("ascii", 8, 12) === "AVI ") return aviCaptions(reader);
      if (signature.toString("ascii", 0, 4) === "OggS") return oggCaptions(reader);
      throw unsupported();
    })();
    return catalog;
  }
  async function extract(subtitle, output) {
    const started = performance.now();
    const entries = await discover();
    const index = Number(subtitle.map?.split(":")[1]);
    const track = subtitle.streamId != null
      ? entries.tracks.find(item => item.trackId === subtitle.streamId)
      : entries.tracks.find(item => item.streamIndex === index);
    if (!track) throw unsupported("This embedded subtitle track cannot be read selectively.");
    const input = await track.extract();
    signal.throwIfAborted();
    const filePath = `${output}.input.${input.extension}`;
    try { await fs.writeFile(filePath, input.bytes, { signal }); }
    catch (error) { await fs.rm(filePath, { force: true }).catch(() => {}); throw error; }
    return { filePath, metrics: { ...reader.metrics(), indexMode: input.indexMode || "samples", indexMs: input.indexMs || 0,
      extractionMs: performance.now() - started } };
  }
  async function font(entry, output) {
    const { fonts } = await discover();
    const match = fonts.find(item => item.streamIndex === Number(entry.map));
    if (!match) throw unsupported("This font attachment cannot be read selectively.");
    const bytes = await match.load();
    signal.throwIfAborted();
    await fs.writeFile(output, bytes, { signal });
  }
  return { discover, extract, font };
}

module.exports = { createCaptionSource };
