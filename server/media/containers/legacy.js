const { check, safe, concat, MAX_ENTRIES, LIMIT, srtTime } = require("./bytes");

function le32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes; }
function riffChunk(id, bytes) {
  return concat([Buffer.from(id), le32(bytes.length), bytes, ...(bytes.length % 2 ? [Buffer.alloc(1)] : [])]);
}
function riffList(id, chunks) { return riffChunk("LIST", concat([Buffer.from(id), ...chunks])); }

async function aviCaptions(reader) {
  let count = 0, avih;
  const tracks = [], movies = [], indexes = [];
  async function chunk(at, end) {
    check(++count <= MAX_ENTRIES && at + 8 <= end);
    const bytes = await reader.read(at, 8);
    const size = bytes.readUInt32LE(4), next = at + 8 + size;
    check(next <= end);
    return { id: bytes.toString("ascii", 0, 4), at, data: at + 8, size, end: next, next: next + size % 2 };
  }
  const body = item => reader.read(item.data, item.size);
  async function walk(start, end, visit) {
    for (let at = start; at < end;) { const item = await chunk(at, end); await visit(item); at = item.next; }
  }
  for (let at = 0; at < reader.size;) {
    const root = await chunk(at, reader.size);
    check(root.id === "RIFF" && root.size >= 4);
    const kind = (await reader.read(root.data, 4)).toString();
    check(["AVI ", "AVIX"].includes(kind));
    await walk(root.data + 4, root.end, async item => {
      if (item.id === "idx1") { indexes.push({ item, movie: movies.at(-1) }); return; }
      if (item.id !== "LIST") return;
      check(item.size >= 4);
      const type = (await reader.read(item.data, 4)).toString();
      if (type === "movi") { movies.push({ start: item.data + 4, end: item.end, typeAt: item.data }); return; }
      if (type !== "hdrl") return;
      await walk(item.data + 4, item.end, async field => {
        if (field.id === "avih") avih = await body(field);
        if (field.id !== "LIST" || (await reader.read(field.data, 4)).toString() !== "strl") return;
        const track = { streamIndex: tracks.length, trackId: tracks.length, indexes: [], packets: [] };
        await walk(field.data + 4, field.end, async entry => {
          if (entry.id === "indx") { track.indexes.push(entry); return; }
          if (!["strh", "strn"].includes(entry.id)) return;
          const bytes = await body(entry);
          if (entry.id === "strh") { check(bytes.length >= 48); track.type = bytes.toString("ascii", 0, 4); track.clock = bytes; }
          if (entry.id === "strn") track.title = bytes.toString().replace(/\0+$/, "");
        });
        track.supported = track.type === "txts";
        track.codec = "text";
        tracks.push(track);
      });
    });
    at = root.next;
  }
  check(avih?.length >= 40 && movies.length);
  const supported = tracks.filter(track => track.supported);
  let indexJob;
  function index() {
    if (!indexJob) indexJob = (async () => {
      const known = new Set();
      async function add(track, at, expectedSize) {
        check(at >= 0 && at + 8 <= reader.size);
        const packet = await chunk(at, reader.size);
        check(Number(packet.id.slice(0, 2)) === track.streamIndex && /^(\d{2})(tx|sb|dc|wb)$/.test(packet.id));
        check(expectedSize == null || packet.size === expectedSize);
        if (!known.has(at)) { known.add(at); track.packets.push(packet); }
      }
      async function openDml(track, item, depth = 0) {
        check(depth < 8);
        const bytes = await body(item);
        check(bytes.length >= 24);
        const width = bytes.readUInt16LE(0), type = bytes[3], entries = bytes.readUInt32LE(4);
        check(entries <= MAX_ENTRIES);
        if (type === 0) {
          check(width === 4 && 24 + entries * 16 <= bytes.length);
          for (let i = 0; i < entries; i++) {
            const offset = safe(bytes.readBigUInt64LE(24 + i * 16));
            if (offset) await openDml(track, await chunk(offset, reader.size), depth + 1);
          }
        } else {
          check(type === 1 && width === 2 && bytes[2] === 0 && 24 + entries * 8 <= bytes.length);
          const base = safe(bytes.readBigUInt64LE(12));
          for (let i = 0; i < entries; i++) await add(track, base + bytes.readUInt32LE(24 + i * 8) - 8, bytes.readUInt32LE(28 + i * 8) & 0x7fffffff);
        }
      }
      for (const track of supported) for (const entry of track.indexes) await openDml(track, entry);
      for (const { item, movie } of indexes) {
        const bytes = await body(item);
        check(bytes.length % 16 === 0 && bytes.length / 16 <= MAX_ENTRIES);
        let base;
        for (let pos = 0; pos < bytes.length; pos += 16) {
          const id = bytes.toString("ascii", pos, pos + 4);
          const track = supported.find(entry => entry.streamIndex === Number(id.slice(0, 2)));
          if (!track) continue;
          const offset = bytes.readUInt32LE(pos + 8), size = bytes.readUInt32LE(pos + 12);
          if (base == null) {
            for (const candidate of [movie?.typeAt, 0, movie?.start].filter(value => value != null)) {
              if (candidate + offset + 8 > reader.size) continue;
              const head = await reader.read(candidate + offset, 8);
              if (head.toString("ascii", 0, 4) === id && head.readUInt32LE(4) === size) { base = candidate; break; }
            }
          }
          check(base != null, "AVI subtitle index offsets are invalid.");
          await add(track, base + offset, size);
        }
      }
      // Header walking is also safe for indexless AVI and OpenDML continuations.
      const missing = new Set(supported.filter(track => !track.packets.length));
      async function movieWalk(start, end, depth = 0) {
        check(depth < 12);
        await walk(start, end, async item => {
          if (item.id === "LIST") {
            check(item.size >= 4);
            if ((await reader.read(item.data, 4)).toString() === "rec ") await movieWalk(item.data + 4, item.end, depth + 1);
          } else {
            const track = supported.find(entry => missing.has(entry) && /^\d{2}/.test(item.id) && entry.streamIndex === Number(item.id.slice(0, 2)));
            if (track) await add(track, item.at);
          }
        });
      }
      if (missing.size) for (const movie of movies) await movieWalk(movie.start, movie.end);
      for (const track of supported) track.packets.sort((a, b) => a.at - b.at);
    })();
    return indexJob;
  }
  for (const track of supported) track.extract = async () => {
    await index();
    check(track.packets.length, "No readable AVI subtitle packets were found.");
    check(track.packets.reduce((sum, packet) => sum + packet.size, 0) <= LIMIT, "Embedded captions exceed the extraction size limit.");
    const first = await body(track.packets[0]);
    if (first.toString("ascii", 0, 5) === "GAB2\0") {
      check(first.length >= 17 && first.readUInt16LE(5) === 2);
      const start = 17 + first.readUInt32LE(7);
      check(start <= first.length);
      const declared = first.readUInt32LE(start - 4);
      check(!declared || declared <= first.length - start);
      const payload = first.subarray(start, declared ? start + declared : first.length);
      return { extension: /\[Script Info\]/i.test(payload.toString()) ? "ass" : "srt", bytes: payload };
    }
    const scale = track.clock.readUInt32LE(20), rate = track.clock.readUInt32LE(24), sampleSize = track.clock.readUInt32LE(44);
    check(scale > 0 && rate > 0);
    let units = track.clock.readUInt32LE(28);
    const cues = [];
    for (const packet of track.packets) {
      const text = (await body(packet)).toString().replace(/\0+$/, "");
      check(!text.includes("\0"), "This AVI subtitle payload is not supported text.");
      const duration = sampleSize ? packet.size / sampleSize : 1;
      cues.push(Buffer.from(`${cues.length + 1}\n${srtTime(units * scale / rate)} --> ${srtTime((units + duration) * scale / rate)}\n${text}\n\n`));
      units += duration;
    }
    return { extension: "srt", bytes: concat(cues) };
  };
  return { tracks: supported, fonts: [] };
}

async function oggCaptions(reader) {
  const streams = new Map();
  let count = 0, dataStarted = false;
  for (let at = 0; at < reader.size;) {
    check(++count <= MAX_ENTRIES);
    const header = await reader.read(at, 27);
    check(header.toString("ascii", 0, 4) === "OggS" && header[4] === 0);
    const laces = await reader.read(at + 27, header[26]);
    const length = laces.reduce((sum, value) => sum + value, 0), end = at + 27 + laces.length + length;
    check(end <= reader.size);
    const serial = header.readUInt32LE(14), sequence = header.readUInt32LE(18);
    let stream = streams.get(serial);
    if (!stream) {
      check(header[5] & 2, "An Ogg stream is missing its beginning-of-stream header.");
      check(!dataStarted, "Chained Ogg subtitle timelines are unsupported.");
      const prefix = await reader.read(at + 27 + laces.length, Math.min(length, 64));
      stream = { trackId: serial, streamIndex: [...streams.values()].filter(item => !item.metadata).length,
        metadata: prefix.toString("ascii", 0, 8) === "fishead\0", supported: prefix.toString("ascii", 0, 5) === "\x01text", codec: "text", pages: [] };
      streams.set(serial, stream);
    } else check(!(header[5] & 2), "Chained Ogg streams with reused serial numbers are unsupported.");
    if (!(header[5] & 2)) dataStarted = true;
    if (stream.supported) {
      check(stream.sequence == null || sequence === stream.sequence + 1, "The Ogg subtitle stream has missing or reordered pages.");
      check(Boolean(header[5] & 1) === Boolean(stream.continued), "An Ogg subtitle packet continuation is invalid.");
      stream.sequence = sequence;
      stream.continued = laces.at(-1) === 255;
      stream.pages.push({ at, length: end - at });
    }
    at = end;
  }
  const tracks = [...streams.values()].filter(stream => stream.supported);
  for (const track of tracks) track.extract = async () => {
    check(!track.continued, "The final Ogg subtitle packet is truncated.");
    check(track.pages.reduce((sum, page) => sum + page.length, 0) <= LIMIT, "Embedded captions exceed the extraction size limit.");
    const pages = [];
    // Serial numbers, granules, CRCs, and continued packets stay intact when
    // pages from unrelated logical streams are removed.
    for (const page of track.pages) pages.push(await reader.read(page.at, page.length));
    return { extension: "ogg", bytes: concat(pages) };
  };
  return { tracks, fonts: [] };
}

module.exports = { aviCaptions, oggCaptions, riffChunk, riffList };
