const { check, safe, MAX_ENTRIES } = require("./bytes");
const { parseBoxes, child, descend, boxHeader } = require("./iso-boxes");

const signatures = new Set(["ftyp", "moov", "mdat", "free", "wide", "skip", "moof", "styp"]);

// Metadata only: every mdat is skipped by its declared length. The caller owns
// cancellation and its read budget; captions can later supply their own reader.
async function inspectIso(reader) {
  if (!signatures.has((await reader.read(0, Math.min(16, reader.size))).toString("ascii", 4, 8))) return null;
  const headers = new Map();
  async function header(input, at) {
    if (!headers.has(at)) headers.set(at, await boxHeader(input, at));
    return headers.get(at);
  }
  let moov, after = 0;
  for (let count = 0; after < reader.size; count++) {
    check(count < MAX_ENTRIES);
    const entry = await header(reader, after);
    after += entry.size;
    if (entry.type === "moov") {
      moov = { type: "moov", children: parseBoxes(await reader.read(entry.at + entry.head, entry.size - entry.head)) };
      break;
    }
  }
  check(moov, "MP4 track metadata is missing.");
  let fragmentJob;
  const metadata = {
    moov, fragmented: Boolean(child(moov, "mvex")) || [...headers.values()].some(entry => entry.type === "moof"),
    header,
    fragments(input) {
      if (!fragmentJob) fragmentJob = (async () => {
        const fragments = [];
        for (let at = 0, count = 0; at < input.size; count++) {
          check(count < MAX_ENTRIES);
          const entry = await header(input, at);
          if (entry.type === "moof") fragments.push(entry);
          at += entry.size;
        }
        return fragments;
      })();
      return fragmentJob;
    }
  };
  return metadata;
}

function tracksOf(moov) {
  const mvhd = child(moov, "mvhd");
  check(mvhd?.data.length >= 24);
  const movieScale = mvhd.data.readUInt32BE(mvhd.data[0] === 1 ? 20 : 12);
  check(movieScale > 0);
  return moov.children.filter(node => node.type === "trak").map(trak => {
    const tkhd = child(trak, "tkhd"), mdhd = descend(trak, "mdia", "mdhd");
    check(tkhd?.data.length >= 24 && mdhd?.data.length >= 24);
    const version = mdhd.data[0], scale = mdhd.data.readUInt32BE(version === 1 ? 20 : 12);
    check(scale > 0 && (!version || mdhd.data.length >= 36));
    const id = tkhd.data.readUInt32BE(tkhd.data[0] === 1 ? 20 : 12);
    let shift = 0;
    const edit = descend(trak, "edts", "elst");
    if (edit) {
      const data = edit.data, wide = data[0] === 1, width = wide ? 20 : 12;
      check(data.length >= 8);
      const count = data.readUInt32BE(4);
      check(count <= MAX_ENTRIES && 8 + count * width <= data.length);
      // Only the initial empty edit and a normal media edit have a single
      // timeline shift. More complex edit lists require the bounded fallback.
      for (let i = 0; i < count; i++) {
        const at = 8 + i * width;
        const duration = wide ? safe(data.readBigUInt64BE(at)) : data.readUInt32BE(at);
        const media = wide ? Number(data.readBigInt64BE(at + 8)) : data.readInt32BE(at + 4);
        check(Number.isSafeInteger(media) && data.readInt32BE(at + (wide ? 16 : 8)) === 0x10000);
        if (media === -1) shift += duration / movieScale;
        else { check(media >= 0 && i === count - 1); shift -= media / scale; }
      }
    }
    const duration = version ? safe(mdhd.data.readBigUInt64BE(24)) : mdhd.data.readUInt32BE(16);
    return { id, scale, shift, end: duration / scale + shift };
  });
}

async function readMfra(metadata, reader, tracks, defaults) {
  if (reader.size < 16) return null;
  const footer = await reader.read(reader.size - 16, 16);
  if (footer.readUInt32BE(0) !== 16 || footer.toString("ascii", 4, 8) !== "mfro") return null;
  const size = footer.readUInt32BE(12);
  check(size >= 24 && size <= reader.size);
  const entry = await metadata.header(reader, reader.size - size);
  check(entry.type === "mfra" && entry.size === size);
  const references = new Map();
  for (const node of parseBoxes(await reader.read(entry.at + entry.head, size - entry.head))) {
    if (node.type !== "tfra") continue;
    const d = node.data;
    check(d.length >= 16 && d[0] <= 1);
    const id = d.readUInt32BE(4), flags = d.readUInt32BE(8), count = d.readUInt32BE(12);
    check(tracks.some(track => track.id === id) && !references.has(id) && count > 0 && count <= MAX_ENTRIES);
    const lengths = [((flags >> 4) & 3) + 1, ((flags >> 2) & 3) + 1, (flags & 3) + 1];
    const width = (d[0] ? 16 : 8) + lengths.reduce((a, b) => a + b, 0);
    check(16 + count * width === d.length);
    let previous;
    for (let i = 0; i < count; i++) {
      let at = 16 + i * width;
      const time = d[0] ? safe(d.readBigUInt64BE(at)) : d.readUInt32BE(at); at += d[0] ? 8 : 4;
      const offset = d[0] ? safe(d.readBigUInt64BE(at)) : d.readUInt32BE(at); at += d[0] ? 8 : 4;
      const numbers = lengths.map(length => { const value = d.readUIntBE(at, length); at += length; return value; });
      check(offset < entry.at && numbers.every(value => value > 0) && (!previous || time >= previous.time && offset >= previous.offset));
      previous = { time, offset, numbers };
    }
    references.set(id, previous);
  }
  check(references.size > 0);
  // Validate every track's final reference against the real fragment contents.
  for (const [id, reference] of references) {
    const fragment = await metadata.header(reader, reference.offset);
    check(fragment.type === "moof");
    const nodes = parseBoxes(await reader.read(fragment.at + fragment.head, fragment.size - fragment.head));
    // FFmpeg-produced files can write traf_number=1 for every track. FFmpeg
    // seeks by moof offset and track ID, so validate that same association.
    const traf = nodes.find(node => node.type === "traf" && child(node, "tfhd")?.data.readUInt32BE(4) === id);
    const tfhd = child(traf, "tfhd"), runs = traf?.children.filter(node => node.type === "trun");
    check(tfhd?.data.length >= 8 && tfhd.data.readUInt32BE(4) === id);
    const run = runs[reference.numbers[1] - 1];
    check(run?.data.length >= 8 && reference.numbers[2] <= run.data.readUInt32BE(4));
    const range = fragmentEnds(nodes, tracks.map(track => ({ ...track })), defaults).get(id);
    const time = reference.time / tracks.find(track => track.id === id).scale;
    // Audio priming and older muxers can offset the index slightly. A stale
    // timestamp outside the actual fragment must not become a seek index.
    check(range && time >= range.start - 1 && time <= range.end + 1);
  }
  return { references, start: Math.min(...[...references.values()].map(reference => reference.offset)) };
}

function fragmentEnds(nodes, tracks, defaults) {
  const ranges = new Map();
  for (const traf of nodes.filter(node => node.type === "traf")) {
    const tfhd = child(traf, "tfhd"), tfdt = child(traf, "tfdt");
    check(tfhd?.data.length >= 8 && tfdt?.data.length >= (tfdt.data[0] ? 12 : 8));
    const id = tfhd.data.readUInt32BE(4), track = tracks.find(item => item.id === id);
    check(track);
    let dts = tfdt.data[0] ? safe(tfdt.data.readBigUInt64BE(4)) : tfdt.data.readUInt32BE(4);
    const flags = tfhd.data.readUInt32BE(0) & 0xffffff;
    let cursor = 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
    check(cursor + (flags & 8 ? 4 : 0) <= tfhd.data.length);
    const defaultDuration = flags & 8 ? tfhd.data.readUInt32BE(cursor) : defaults.get(id);
    let start = Infinity, end = -Infinity;
    for (const run of traf.children.filter(node => node.type === "trun")) {
      const d = run.data;
      check(d.length >= 8);
      const flags = d.readUInt32BE(0) & 0xffffff, count = d.readUInt32BE(4);
      check(count <= MAX_ENTRIES);
      let at = 8 + (flags & 1 ? 4 : 0) + (flags & 4 ? 4 : 0);
      const next = signed => { check(at + 4 <= d.length); const n = signed ? d.readInt32BE(at) : d.readUInt32BE(at); at += 4; return n; };
      for (let i = 0; i < count; i++) {
        const duration = flags & 0x100 ? next() : defaultDuration;
        if (flags & 0x200) next();
        if (flags & 0x400) next();
        const composition = flags & 0x800 ? next(d[0] === 1) : 0;
        check(Number.isSafeInteger(duration) && duration >= 0 && Number.isSafeInteger(dts + duration));
        start = Math.min(start, (dts + composition) / track.scale);
        end = Math.max(end, (dts + duration + composition) / track.scale);
        track.end = Math.max(track.end, (dts + duration + composition) / track.scale + track.shift);
        dts += duration;
      }
      check(at <= d.length);
    }
    ranges.set(id, { start, end });
  }
  return ranges;
}

async function isoTimeline(metadata, reader) {
  if (!metadata.fragmented) return null;
  const tracks = tracksOf(metadata.moov), defaults = new Map();
  for (const node of child(metadata.moov, "mvex")?.children || []) {
    if (node.type === "trex") { check(node.data.length >= 24); defaults.set(node.data.readUInt32BE(4), node.data.readUInt32BE(12)); }
  }
  let indexed;
  try { indexed = await readMfra(metadata, reader, tracks, defaults); }
  catch { reader.signal.throwIfAborted(); indexed = null; }
  if (indexed) {
    // A random-access index need not reference the final fragment. Walk the
    // remaining box headers to EOF rather than assuming the last entry is EOF.
    for (let at = indexed.start, count = 0; at < reader.size; count++) {
      check(count < MAX_ENTRIES);
      const entry = await metadata.header(reader, at);
      if (entry.type === "moof") fragmentEnds(parseBoxes(await reader.read(at + entry.head, entry.size - entry.head)), tracks, defaults);
      at += entry.size;
    }
  } else {
    for (const fragment of await metadata.fragments(reader)) {
      fragmentEnds(parseBoxes(await reader.read(fragment.at + fragment.head, fragment.size - fragment.head)), tracks, defaults);
    }
  }
  const durationEnd = Math.max(...tracks.map(track => track.end));
  check(Number.isFinite(durationEnd) && durationEnd > 0);
  return { durationEnd, indexed: Boolean(indexed), inputArgs: indexed ? ["-use_mfra_for", "pts"] : [] };
}

module.exports = { inspectIso, isoTimeline };
