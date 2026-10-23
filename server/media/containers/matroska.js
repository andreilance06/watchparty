const { check, safe, concat, MAX_ENTRIES, LIMIT } = require("./bytes");

function vint(bytes, offset = 0, keepMarker = false) {
  const first = bytes[offset]; check(first > 0);
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  check(length <= 8 && offset + length <= bytes.length);
  let value = BigInt(keepMarker ? first : first & (0xff >> length));
  for (let i = 1; i < length; i++) value = value * 256n + BigInt(bytes[offset + i]);
  const unknown = !keepMarker && value === (1n << BigInt(7 * length)) - 1n;
  return { value: unknown ? null : safe(value), length };
}
function sizeVint(size) {
  let length = 1;
  while (BigInt(size) >= (1n << BigInt(length * 7)) - 1n) length++;
  check(length <= 8);
  let value = BigInt(size) | (1n << BigInt(length * 7));
  const bytes = Buffer.alloc(length);
  for (let i = length - 1; i >= 0; i--) { bytes[i] = Number(value & 255n); value >>= 8n; }
  return bytes;
}
function element(id, bytes) { return concat([Buffer.from(id, "hex"), sizeVint(bytes.length), bytes]); }
function bigUint(bytes) {
  check(bytes.length > 0 && bytes.length <= 8);
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  return value;
}
const uint = bytes => safe(bigUint(bytes));
function uintBytes(value) {
  let hex = BigInt(value).toString(16); if (hex.length % 2) hex = `0${hex}`;
  return Buffer.from(hex, "hex");
}
function decodeHeader(bytes, at, end) {
  const id = vint(bytes, 0, true), size = vint(bytes, id.length);
  check(id.length <= 4);
  const data = at + id.length + size.length, next = size.value == null ? end : data + size.value;
  check(data <= next && next <= end);
  return { id: id.value, at, data, end: next, unknown: size.value == null, prefix: bytes };
}
function fields(bytes, start = 0, end = bytes.length) {
  const entries = [];
  for (let at = start; at < end;) {
    check(entries.length < MAX_ENTRIES);
    const item = decodeHeader(bytes.subarray(at, Math.min(end, at + 16)), at, end); check(!item.unknown);
    item.bytes = bytes.subarray(item.data, item.end); item.raw = bytes.subarray(item.at, item.end);
    entries.push(item); at = item.end;
  }
  return entries;
}

async function matroskaCaptions(reader) {
  let count = 0;
  function parsed(bytes, at, end) { check(++count <= MAX_ENTRIES); return decodeHeader(bytes, at, end); }
  async function header(at, end) { check(at < end); return parsed(await reader.read(at, Math.min(16, end - at)), at, end); }
  async function headers(locations) {
    const buffers = await reader.readMany(locations.map(({ at, end }) => ({ offset: at, length: Math.min(16, end - at) })));
    return buffers.map((bytes, index) => parsed(bytes, locations[index].at, locations[index].end));
  }
  const body = item => reader.read(item.data, item.end - item.data);
  const raw = item => reader.read(item.at, item.end - item.at);
  const smallBody = item => item.end - item.at <= item.prefix.length
    ? Promise.resolve(item.prefix.subarray(item.data - item.at, item.end - item.at)) : body(item);
  async function children(start, end, visit) {
    for (let at = start; at < end;) { const item = await header(at, end); check(!item.unknown); await visit(item); at = item.end; }
  }
  const ebml = await header(0, reader.size); check(ebml.id === 0x1a45dfa3 && !ebml.unknown);
  const ebmlBytes = await raw(ebml);
  let segment;
  for (let at = ebml.end; at < reader.size;) {
    const item = await header(at, reader.size);
    if (item.id === 0x18538067) { segment = item; break; }
    check(!item.unknown); at = item.end;
  }
  check(segment);
  const tracks = [], fonts = [], clusters = new Map(), cues = new Map(), frameCounts = new Map();
  const visited = new Set(), seekTried = new Set(), seeks = new Map();
  let info = element("1549a966", element("2ad7b1", uintBytes(1000000))), cuesInvalid = false, layoutJob, structuralJob;
  const topLevel = new Set([0x114d9b74, 0x1549a966, 0x1654ae6b, 0x1f43b675, 0x1c53bb6b, 0x1941a469, 0x1043a770, 0x1254c367]);
  async function clusterEnd(item) {
    if (!item.unknown) return item.end;
    let at = item.data;
    while (at < segment.end) {
      const child = await header(at, segment.end);
      if (topLevel.has(child.id)) return at;
      check(!child.unknown); at = child.end;
    }
    return at;
  }
  function parseTracks(bytes) {
    check(!tracks.length, "Multiple Matroska track tables are unsupported.");
    for (const entry of fields(bytes)) {
      if (entry.id !== 0xae) continue;
      const track = { streamIndex: tracks.length, entry: entry.raw, default: true, forced: false, structuralPackets: [] };
      for (const field of fields(entry.bytes)) {
        if (field.id === 0xd7) track.trackId = uint(field.bytes);
        if (field.id === 0x73c5) track.uid = bigUint(field.bytes).toString();
        if (field.id === 0x83) track.type = uint(field.bytes);
        if (field.id === 0x86) track.codecId = field.bytes.toString();
        if (field.id === 0x536e) track.title = field.bytes.toString();
        if (field.id === 0x22b59c && !track.lang) track.lang = field.bytes.toString();
        if (field.id === 0x22b59d) track.lang = field.bytes.toString();
        if (field.id === 0x88) track.default = Boolean(uint(field.bytes));
        if (field.id === 0x55aa) track.forced = Boolean(uint(field.bytes));
      }
      track.codec = ({ "S_TEXT/ASS": "ass", "S_TEXT/SSA": "ssa", "S_TEXT/UTF8": "subrip", "S_TEXT/WEBVTT": "webvtt", "D_WEBVTT/SUBTITLES": "webvtt", "D_WEBVTT/CAPTIONS": "webvtt" })[track.codecId];
      track.supported = track.type === 17 && Boolean(track.codec);
      check(track.trackId > 0 && !tracks.some(other => other.trackId === track.trackId)); tracks.push(track);
    }
  }
  function parseTags(bytes) {
    for (const tag of fields(bytes)) {
      if (tag.id !== 0x7373) continue;
      const tagFields = fields(tag.bytes), targets = tagFields.find(item => item.id === 0x63c0);
      if (!targets) continue;
      const uids = fields(targets.bytes).filter(item => item.id === 0x63c5).map(item => bigUint(item.bytes).toString());
      if (uids.length !== 1 || uids[0] === "0") continue;
      function simple(entries, depth = 0) {
        check(depth < 8);
        for (const item of entries) {
          if (item.id !== 0x67c8) continue;
          const values = fields(item.bytes), name = values.find(value => value.id === 0x45a3)?.bytes.toString();
          const text = values.find(value => value.id === 0x4487)?.bytes.toString();
          if (name === "NUMBER_OF_FRAMES") {
            const valid = /^\d+$/.test(text || "") && Number.isSafeInteger(Number(text)) && Number(text) <= MAX_ENTRIES;
            const value = valid ? Number(text) : null, previous = frameCounts.get(uids[0]);
            frameCounts.set(uids[0], previous !== undefined && previous !== value ? null : value);
          }
          if (values.some(value => value.id === 0x67c8)) simple(values, depth + 1);
        }
      }
      simple(tagFields);
    }
  }
  function parseCues(bytes) {
    try {
      for (const point of fields(bytes)) {
        if (point.id !== 0xbb) continue;
        const values = fields(point.bytes), time = values.find(item => item.id === 0xb3); check(time);
        for (const position of values.filter(item => item.id === 0xb7)) {
          const record = { time: uint(time.bytes), codecState: 0, blockNumber: 1 };
          for (const item of fields(position.bytes)) {
            const key = ({ [0xf7]: "track", [0xf1]: "cluster", [0xf0]: "relative", [0xb2]: "duration", [0xea]: "codecState", [0x5378]: "blockNumber" })[item.id];
            if (key) record[key] = uint(item.bytes);
          }
          check(record.track > 0 && Number.isSafeInteger(record.cluster));
          if (!cues.has(record.track)) cues.set(record.track, []);
          check(cues.get(record.track).length < MAX_ENTRIES); cues.get(record.track).push(record);
        }
      }
    } catch { cuesInvalid = true; }
  }
  async function metadata(item) {
    if (visited.has(item.at) || item.id === 0x1f43b675) return;
    visited.add(item.at); check(!item.unknown);
    if (item.id === 0x1549a966) info = await raw(item);
    if (item.id === 0x1654ae6b) parseTracks(await body(item));
    if (item.id === 0x1254c367) parseTags(await body(item));
    if (item.id === 0x1c53bb6b) {
      if (item.end - item.data <= LIMIT) parseCues(await body(item)); else cuesInvalid = true;
    }
    if (item.id === 0x114d9b74) {
      for (const seek of fields(await body(item))) {
        if (seek.id !== 0x4dbb) continue;
        const values = fields(seek.bytes), id = values.find(field => field.id === 0x53ab), position = values.find(field => field.id === 0x53ac);
        if (!id || !position) continue;
        const targetId = uint(id.bytes), at = segment.data + uint(position.bytes);
        if (topLevel.has(targetId) && targetId !== 0x1f43b675 && at >= segment.data && at < segment.end) seeks.set(at, targetId);
      }
    }
    if (item.id === 0x1941a469) {
      await children(item.data, item.end, async attachment => {
        if (attachment.id !== 0x61a7) return;
        let name = "", mime = "", data;
        await children(attachment.data, attachment.end, async field => {
          if (field.id === 0x466e) name = (await smallBody(field)).toString();
          if (field.id === 0x4660) mime = (await smallBody(field)).toString();
          if (field.id === 0x465c) data = field;
        });
        fonts.push({ name, mime, data });
      });
    }
  }
  async function seekMetadata() {
    for (let depth = 0; depth < 8; depth++) {
      const pending = [...seeks].filter(([at]) => !visited.has(at) && !seekTried.has(at)); if (!pending.length) return;
      const buffers = await reader.readMany(pending.map(([at]) => ({ offset: at, length: Math.min(16, segment.end - at) })));
      for (let i = 0; i < pending.length; i++) {
        const [at, id] = pending[i]; seekTried.add(at);
        let item;
        try { item = parsed(buffers[i], at, segment.end); } catch { continue; }
        if (item.id === id && !item.unknown) await metadata(item);
      }
    }
  }
  // SeekHead avoids walking episode clusters just to find captions and fonts.
  let initialAt = segment.data;
  for (; initialAt < segment.end;) {
    const item = await header(initialAt, segment.end);
    if (item.id === 0x1f43b675 && tracks.length && cues.size && frameCounts.size) break;
    if (item.id === 0x1f43b675) { item.end = await clusterEnd(item); clusters.set(item.at, item); }
    else { await metadata(item); await seekMetadata(); }
    check(item.end > initialAt); initialAt = item.end;
  }
  function layout() {
    if (!layoutJob) layoutJob = (async () => {
      for (let at = initialAt; at < segment.end;) {
        const item = await header(at, segment.end);
        if (item.id === 0x1f43b675) { item.end = await clusterEnd(item); clusters.set(item.at, item); }
        else await metadata(item);
        check(item.end > at); at = item.end;
      }
    })();
    return layoutJob;
  }
  function structural() {
    if (!structuralJob) structuralJob = (async () => {
      await layout();
      const byNumber = new Map(tracks.filter(track => track.supported).map(track => [track.trackId, track]));
      const walkers = [...clusters.values()].sort((a, b) => a.at - b.at).map(cluster => ({ cluster, at: cluster.data, pending: [], timestamp: null }));
      while (walkers.length) {
        const active = walkers.splice(0, 64), items = await headers(active.map(walk => ({ at: walk.at, end: walk.cluster.end })));
        for (let i = 0; i < active.length; i++) {
          const walk = active[i], item = items[i]; check(!item.unknown);
          if (item.id === 0xe7) walk.timestamp = element("e7", await smallBody(item));
          if (item.id === 0xa3) {
            const start = item.data - item.at;
            const prefix = item.prefix.length - start >= Math.min(12, item.end - item.data)
              ? item.prefix.subarray(start) : await reader.read(item.data, Math.min(12, item.end - item.data));
            const number = vint(prefix); check(number.value != null && number.length + 3 <= prefix.length);
            if (byNumber.has(number.value)) { check(!(prefix[number.length + 2] & 6)); walk.pending.push({ track: byNumber.get(number.value), item }); }
          } else if (item.id === 0xa0) {
            let block;
            await children(item.data, item.end, async field => { if (field.id === 0xa1) block = field; });
            if (block) {
              const bytes = await reader.read(block.data, Math.min(12, block.end - block.data)), number = vint(bytes);
              check(number.value != null && number.length + 3 <= bytes.length);
              if (byNumber.has(number.value)) { check(!(bytes[number.length + 2] & 6)); walk.pending.push({ track: byNumber.get(number.value), item }); }
            }
          }
          walk.at = item.end;
          if (walk.at < walk.cluster.end) walkers.push(walk);
          else {
            check(walk.timestamp || !walk.pending.length);
            for (const { track, item: packet } of walk.pending) track.structuralPackets.push({ timestamp: walk.timestamp, item: packet, cluster: walk.cluster.at });
          }
        }
      }
      for (const track of tracks) track.structuralPackets.sort((a, b) => a.item.at - b.item.at);
    })();
    return structuralJob;
  }
  async function indexed(track) {
    const records = cues.get(track.trackId), expected = frameCounts.get(track.uid);
    if (cuesInvalid || !records?.length || !expected || records.length !== expected) return null;
    try {
      const seen = new Set();
      for (const record of records) {
        check(!record.codecState && record.relative != null && record.blockNumber >= 1);
        const key = `${record.cluster}:${record.relative}`; check(!seen.has(key)); seen.add(key);
      }
      const positions = [...new Set(records.map(record => segment.data + record.cluster))];
      check(positions.every(at => Number.isSafeInteger(at) && at >= segment.data && at < segment.end));
      const clusterHeaders = await headers(positions.map(at => ({ at, end: segment.end })));
      const selected = new Map();
      for (const cluster of clusterHeaders) { check(cluster.id === 0x1f43b675 && !cluster.unknown); selected.set(cluster.at, cluster); }
      let pending = clusterHeaders.map(cluster => ({ cluster, at: cluster.data }));
      for (let step = 0; pending.length && step < 16; step++) {
        const list = pending, items = await headers(list.map(walk => ({ at: walk.at, end: walk.cluster.end }))); pending = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i], walk = list[i]; check(!item.unknown);
          if (item.id === 0xe7) { walk.cluster.time = uint(await smallBody(item)); walk.cluster.timestamp = element("e7", uintBytes(walk.cluster.time)); }
          else { check(![0xa0, 0xa3].includes(item.id)); walk.at = item.end; pending.push(walk); }
        }
      }
      check(!pending.length);
      const locations = records.map(record => {
        const cluster = selected.get(segment.data + record.cluster), at = cluster.data + record.relative;
        check(at >= cluster.data && at < cluster.end); return { at, end: cluster.end };
      });
      const packets = await headers(locations);
      check(packets.every(item => !item.unknown && [0xa0, 0xa3].includes(item.id)));
      check(packets.reduce((sum, item) => sum + item.end - item.at, 0) <= LIMIT);
      const buffers = await reader.readMany(packets.map(item => ({ offset: item.at, length: item.end - item.at })));
      const result = [];
      for (let i = 0; i < packets.length; i++) {
        const packet = packets[i], bytes = buffers[i], record = records[i], cluster = selected.get(segment.data + record.cluster);
        const values = packet.id === 0xa0 ? fields(bytes, packet.data - packet.at) : [];
        const block = packet.id === 0xa3 ? bytes.subarray(packet.data - packet.at) : values.find(item => item.id === 0xa1)?.bytes; check(block);
        const number = vint(block); check(number.value === track.trackId && number.length + 3 <= block.length && !(block[number.length + 2] & 6));
        check(cluster.time + block.readInt16BE(number.length) === record.time);
        const duration = values.find(item => item.id === 0x9b);
        if (record.duration != null && duration) check(uint(duration.bytes) === record.duration);
        result.push({ timestamp: cluster.timestamp, item: packet, bytes, cluster: cluster.at });
      }
      return result.sort((a, b) => a.item.at - b.item.at);
    } catch {
      reader.signal.throwIfAborted();
      return null; // Partial/stale cues must never silently omit dialogue.
    }
  }
  for (const track of tracks) track.extract = async () => {
    const started = performance.now();
    if (!track.packetJob) track.packetJob = (async () => {
      const packets = await indexed(track);
      if (packets) { track.indexMode = "cues"; return packets; }
      await structural(); track.indexMode = "structural"; return track.structuralPackets;
    })();
    const packets = await track.packetJob; track.indexMs = performance.now() - started;
    check(packets.reduce((sum, packet) => sum + packet.item.end - packet.item.at, 0) <= LIMIT);
    const missing = packets.filter(packet => !packet.bytes);
    const buffers = await reader.readMany(missing.map(packet => ({ offset: packet.item.at, length: packet.item.end - packet.item.at })));
    missing.forEach((packet, index) => { packet.bytes = buffers[index]; });
    const chunks = [ebmlBytes, Buffer.from("1853806701ffffffffffffff", "hex"), info, element("1654ae6b", track.entry)];
    let previousCluster, timestamp, blocks = [];
    const flush = () => { if (blocks.length) chunks.push(element("1f43b675", concat([timestamp, ...blocks]))); blocks = []; };
    for (const packet of packets) {
      if (packet.cluster !== previousCluster) { flush(); timestamp = packet.timestamp; previousCluster = packet.cluster; }
      blocks.push(packet.bytes);
    }
    flush();
    return { bytes: concat(chunks), extension: "mks", indexMode: track.indexMode, indexMs: track.indexMs };
  };
  return { tracks: tracks.filter(track => track.supported), fonts: fonts.map((font, index) => ({
    streamIndex: tracks.length + index, extension: /otf|opentype/i.test(font.name + font.mime) ? "otf" : "ttf",
    load: async () => { check(font.data); return body(font.data); }
  })) };
}

module.exports = { matroskaCaptions, vint, sizeVint, element, uintBytes };
