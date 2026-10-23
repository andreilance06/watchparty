const { check, safe, concat, u32, u64, MAX_ENTRIES, LIMIT } = require("./bytes");

const masters = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "moof", "traf"]);
function box(type, bytes) { return concat([u32(bytes.length + 8), Buffer.from(type), bytes]); }
function full(type, bytes, flags = 0) { return box(type, concat([u32(flags), bytes])); }
function parseBoxes(bytes, depth = 0) {
  check(depth < 12);
  const nodes = [];
  for (let at = 0; at < bytes.length;) {
    check(bytes.length - at >= 8 && nodes.length < MAX_ENTRIES);
    let size = bytes.readUInt32BE(at), head = 8;
    const type = bytes.toString("ascii", at + 4, at + 8);
    if (size === 1) { check(bytes.length - at >= 16); size = safe(bytes.readBigUInt64BE(at + 8)); head = 16; }
    if (!size) size = bytes.length - at;
    check(size >= head && at + size <= bytes.length);
    const data = bytes.subarray(at + head, at + size);
    nodes.push({ type, data, raw: bytes.subarray(at, at + size), children: masters.has(type) ? parseBoxes(data, depth + 1) : [] });
    at += size;
  }
  return nodes;
}
const child = (node, type) => node?.children.find(item => item.type === type);
const descend = (node, ...types) => types.reduce(child, node);
function table(node, width) {
  check(node && node.data.length >= 8);
  const count = node.data.readUInt32BE(4);
  check(count <= MAX_ENTRIES && 8 + count * width <= node.data.length);
  return Array.from({ length: count }, (_, index) => node.data.subarray(8 + index * width, 8 + (index + 1) * width));
}
function expand(node, signed = false) {
  const values = [];
  for (const row of table(node, 8)) {
    const count = row.readUInt32BE(0), value = signed ? row.readInt32BE(4) : row.readUInt32BE(4);
    check(values.length + count <= MAX_ENTRIES);
    for (let i = 0; i < count; i++) values.push(value);
  }
  return values;
}
function runs(values) {
  const rows = [];
  for (const value of values) {
    const last = rows.at(-1);
    if (last && last.value === value) last.count++;
    else rows.push({ value, count: 1 });
  }
  return concat([u32(rows.length), ...rows.map(row => concat([u32(row.count), u32(row.value >>> 0)]))]);
}

async function isoCaptions(reader) {
  let moov;
  const fragments = [];
  for (let at = 0, count = 0; at < reader.size;) {
    check(++count <= MAX_ENTRIES);
    const header = await reader.read(at, Math.min(16, reader.size - at));
    check(header.length >= 8);
    let size = header.readUInt32BE(0), head = 8;
    const type = header.toString("ascii", 4, 8);
    if (size === 1) { check(header.length === 16); size = safe(header.readBigUInt64BE(8)); head = 16; }
    if (!size) size = reader.size - at;
    check(size >= head && at + size <= reader.size);
    if (type === "moov") moov = { type, children: parseBoxes(await reader.read(at + head, size - head)) };
    if (type === "moof") fragments.push({ at, head, size });
    at += size;
  }
  check(moov, "MP4/QuickTime track metadata is missing.");
  const mvhd = child(moov, "mvhd");
  check(mvhd);
  const tracks = [];
  for (const trak of moov.children.filter(node => node.type === "trak")) {
    const tkhd = child(trak, "tkhd"), mdhd = descend(trak, "mdia", "mdhd");
    const stbl = descend(trak, "mdia", "minf", "stbl"), stsd = child(stbl, "stsd");
    check(tkhd?.data.length >= 24);
    const trackId = tkhd.data.readUInt32BE(tkhd.data[0] === 1 ? 20 : 12);
    const entries = stsd ? parseBoxes(stsd.data.subarray(8)) : [];
    const supported = entries.length === 1 && ["tx3g", "text", "wvtt"].includes(entries[0].type);
    const hdlr = descend(trak, "mdia", "hdlr");
    const title = hdlr?.data.subarray(24).toString().replace(/^[\x00-\x1f]+|\x00+$/g, "");
    let lang = "und";
    if (mdhd) {
      const offset = mdhd.data[0] === 1 ? 32 : 20;
      check(mdhd.data.length >= offset + 2);
      const packed = mdhd.data.readUInt16BE(offset);
      if (packed && packed < 0x8000) lang = String.fromCharCode(0x60 + (packed >> 10 & 31), 0x60 + (packed >> 5 & 31), 0x60 + (packed & 31));
    }
    tracks.push({ trak, trackId, streamIndex: tracks.length, stbl, stsd, mdhd, supported, samples: [], title, lang,
      codec: entries[0]?.type === "wvtt" ? "webvtt" : entries[0]?.type === "text" ? "text" : "mov_text" });
  }
  for (const track of tracks.filter(item => item.supported)) {
    const { stbl } = track;
    let sizes;
    const stsz = child(stbl, "stsz"), stz2 = child(stbl, "stz2");
    if (stsz) {
      check(stsz.data.length >= 12);
      const fixed = stsz.data.readUInt32BE(4), count = stsz.data.readUInt32BE(8);
      check(count <= MAX_ENTRIES && (fixed || 12 + 4 * count <= stsz.data.length));
      sizes = Array.from({ length: count }, (_, index) => fixed || stsz.data.readUInt32BE(12 + index * 4));
    } else if (stz2) {
      check(stz2.data.length >= 12);
      const bits = stz2.data[7], count = stz2.data.readUInt32BE(8);
      check([4, 8, 16].includes(bits) && count <= MAX_ENTRIES && 12 + Math.ceil(bits * count / 8) <= stz2.data.length);
      sizes = Array.from({ length: count }, (_, index) => bits === 4
        ? (stz2.data[12 + (index >> 1)] >> (index % 2 ? 0 : 4)) & 15
        : bits === 8 ? stz2.data[12 + index] : stz2.data.readUInt16BE(12 + index * 2));
    } else { check(fragments.length); sizes = []; }
    if (!sizes.length) continue;
    const durations = expand(child(stbl, "stts"));
    const ctts = child(stbl, "ctts");
    const offsets = ctts ? expand(ctts, ctts.data[0] === 1) : sizes.map(() => 0);
    check(durations.length === sizes.length && offsets.length === sizes.length);
    const co64 = child(stbl, "co64"), stco = child(stbl, "stco");
    const chunks = table(co64 || stco, co64 ? 8 : 4).map(bytes => co64 ? safe(bytes.readBigUInt64BE()) : bytes.readUInt32BE());
    const mapping = table(child(stbl, "stsc"), 12).map(row => ({ first: row.readUInt32BE(0), count: row.readUInt32BE(4), description: row.readUInt32BE(8) }));
    check(mapping.length && mapping[0].first === 1);
    let sample = 0, entry = 0;
    for (let chunk = 0; chunk < chunks.length; chunk++) {
      while (entry + 1 < mapping.length && mapping[entry + 1].first <= chunk + 1) entry++;
      const map = mapping[entry];
      check(map.count > 0 && map.description === 1 && sample + map.count <= sizes.length);
      let at = chunks[chunk];
      for (let i = 0; i < map.count; i++, sample++) {
        check(at + sizes[sample] <= reader.size);
        track.samples.push({ offset: at, size: sizes[sample], duration: durations[sample], composition: offsets[sample] });
        at += sizes[sample];
      }
    }
    check(sample === sizes.length);
  }
  const defaults = new Map();
  for (const trex of child(moov, "mvex")?.children || []) {
    if (trex.type !== "trex") continue;
    check(trex.data.length >= 24);
    defaults.set(trex.data.readUInt32BE(4), { description: trex.data.readUInt32BE(8), duration: trex.data.readUInt32BE(12), size: trex.data.readUInt32BE(16) });
  }
  let fragmentJob;
  function indexFragments() {
    if (!fragmentJob) fragmentJob = (async () => {
      for (const fragment of fragments) {
        const nodes = parseBoxes(await reader.read(fragment.at + fragment.head, fragment.size - fragment.head));
        let previousEnd = fragment.at;
        for (const traf of nodes.filter(node => node.type === "traf")) {
          const tfhd = child(traf, "tfhd");
          check(tfhd?.data.length >= 8);
          const flags = tfhd.data.readUInt32BE(0) & 0xffffff, id = tfhd.data.readUInt32BE(4);
          const selected = tracks.find(track => track.trackId === id && track.supported);
          const settings = { ...defaults.get(id) };
          let cursor = 8;
          const next32 = () => { check(cursor + 4 <= tfhd.data.length); const value = tfhd.data.readUInt32BE(cursor); cursor += 4; return value; };
          let base = flags & 0x20000 ? fragment.at : previousEnd;
          if (flags & 1) { check(cursor + 8 <= tfhd.data.length); base = safe(tfhd.data.readBigUInt64BE(cursor)); cursor += 8; }
          if (flags & 2) settings.description = next32();
          if (flags & 8) settings.duration = next32();
          if (flags & 16) settings.size = next32();
          if (flags & 32) next32();
          check(!selected || settings.description === 1);
          const tfdt = child(traf, "tfdt");
          if (selected && tfdt) {
            check(tfdt.data.length >= (tfdt.data[0] ? 12 : 8));
            const dts = tfdt.data[0] ? safe(tfdt.data.readBigUInt64BE(4)) : tfdt.data.readUInt32BE(4);
            const expected = selected.samples.reduce((sum, sample) => sum + sample.duration, 0);
            check(dts >= expected, "Overlapping MP4 decode timelines are unsupported.");
            if (dts > expected) selected.samples.push({ offset: 0, size: 0, duration: dts - expected, composition: 0 });
          }
          let dataEnd = base;
          for (const trun of traf.children.filter(node => node.type === "trun")) {
            check(trun.data.length >= 8);
            const runFlags = trun.data.readUInt32BE(0) & 0xffffff, count = trun.data.readUInt32BE(4);
            check(count <= MAX_ENTRIES && (!selected || selected.samples.length + count <= MAX_ENTRIES));
            let pos = 8;
            const take = signed => { check(pos + 4 <= trun.data.length); const value = signed ? trun.data.readInt32BE(pos) : trun.data.readUInt32BE(pos); pos += 4; return value; };
            let at = runFlags & 1 ? base + take(true) : dataEnd;
            if (runFlags & 4) take();
            for (let i = 0; i < count; i++) {
              const duration = runFlags & 0x100 ? take() : settings.duration;
              const size = runFlags & 0x200 ? take() : settings.size;
              if (runFlags & 0x400) take();
              const composition = runFlags & 0x800 ? take(trun.data[0] === 1) : 0;
              check(Number.isInteger(size) && size >= 0 && at >= 0 && at + size <= reader.size);
              if (selected) { check(Number.isInteger(duration) && duration >= 0); selected.samples.push({ offset: at, size, duration, composition }); }
              at += size;
            }
            dataEnd = at;
          }
          previousEnd = dataEnd;
        }
      }
    })();
    return fragmentJob;
  }
  for (const track of tracks) track.extract = async () => {
    await indexFragments();
    const samples = track.samples;
    check(samples.length, "The subtitle track contains no samples.");
    check(samples.reduce((sum, sample) => sum + sample.size, 0) <= LIMIT, "Embedded captions exceed the extraction size limit.");
    const payloads = [];
    for (const sample of samples) payloads.push(await reader.read(sample.offset, sample.size));
    const media = concat(payloads);
    const ftyp = box("ftyp", Buffer.from("qt  \0\0\0\0qt  "));
    function movie(dataStart) {
      let position = dataStart;
      const locations = samples.map(sample => { const at = position; position += sample.size; return u64(at); });
      const tableBytes = box("stbl", concat([
        track.stsd.raw,
        full("stts", runs(samples.map(sample => sample.duration))),
        ...(samples.some(sample => sample.composition !== 0) ? [full("ctts", runs(samples.map(sample => sample.composition)), 0x01000000)] : []),
        full("stsc", concat([u32(1), u32(1), u32(1), u32(1)])),
        full("stsz", concat([u32(0), u32(samples.length), ...samples.map(sample => u32(sample.size))])),
        full("co64", concat([u32(samples.length), ...locations]))
      ]));
      function rebuild(node) {
        if (node.type === "stbl") return tableBytes;
        if (node.children.length) return box(node.type, concat(node.children.map(rebuild)));
        if (node.type === "mdhd") {
          const data = Buffer.from(node.data), duration = samples.reduce((sum, sample) => sum + sample.duration, 0);
          if (data[0] === 1) data.writeBigUInt64BE(BigInt(duration), 24);
          else { check(duration <= 0xffffffff); data.writeUInt32BE(duration, 16); }
          return box("mdhd", data);
        }
        // External data references must never resolve paths/URLs from a movie.
        if (node.type === "dinf") return box("dinf", full("dref", concat([u32(1), full("url ", Buffer.alloc(0), 1)])));
        return node.raw;
      }
      return box("moov", concat([mvhd.raw, rebuild(track.trak)]));
    }
    const provisional = movie(0), metadata = movie(ftyp.length + provisional.length + 8);
    return { bytes: concat([ftyp, metadata, box("mdat", media)]), extension: "mov" };
  };
  return { tracks: tracks.filter(track => track.supported), fonts: [] };
}

module.exports = { isoCaptions, box, full, parseBoxes };
