const { element, sizeVint, uintBytes } = require("../../server/media/containers/matroska");

// A movie-scale byte source without allocating or writing gigabytes of media.
// The real EBML headers, subtitle packets, fonts, cues and tags occupy < 1 MiB.
function createEpisode({ clusterCount = 720, indexed = true, statistics = true, partialCues = false,
  duplicateCue = false, wrongUid = false, invalidOffset = false, invalidSeek = false, videoFrame = Buffer.alloc(0), subtitle = "Episode caption",
  fontBytes = Buffer.from("test-font-bytes") } = {}) {
  const uid = 0xfedcba9876543210n, wrong = uid - 1n;
  const parts = [], clusterPositions = [], cueRecords = [], payloads = [];
  let size = 0;
  const add = (bytes, length = bytes.length) => { parts.push({ at: size, bytes, length }); size += length; };
  const head = (id, length) => Buffer.concat([Buffer.from(id, "hex"), sizeVint(length)]);
  const scalar = (id, value) => element(id, uintBytes(value));
  const ebml = element("1a45dfa3", Buffer.concat([scalar("4286", 1), scalar("42f7", 1), scalar("42f2", 4), scalar("42f3", 8),
    element("4282", Buffer.from("matroska")), scalar("4287", 4), scalar("4285", 2)]));
  const seconds = clusterCount * 2, duration = Buffer.alloc(8); duration.writeDoubleBE(seconds * 1000);
  const info = element("1549a966", Buffer.concat([scalar("2ad7b1", 1000000), element("4489", duration)]));
  const track = (number, type, codec, extra = Buffer.alloc(0)) => element("ae", Buffer.concat([
    scalar("d7", number), scalar("73c5", number === 3 ? uid : BigInt(number)), scalar("83", type), element("86", Buffer.from(codec)), extra
  ]));
  const tracks = element("1654ae6b", Buffer.concat([
    track(1, 1, "V_MJPEG", element("e0", Buffer.concat([scalar("b0", 160), scalar("ba", 90)]))),
    track(2, 2, "A_PCM/INT/LIT", element("e1", Buffer.concat([scalar("9f", 1), scalar("6264", 16)]))),
    track(3, 17, "S_TEXT/UTF8", Buffer.concat([element("536e", Buffer.from("English episode captions")), element("22b59c", Buffer.from("eng"))]))
  ]));
  const attachments = element("1941a469", element("61a7", Buffer.concat([
    element("466e", Buffer.from("episode.ttf")), element("4660", Buffer.from("application/x-truetype-font")), scalar("46ae", 1), element("465c", fontBytes)
  ])));
  // Fixed-width SeekPositions allow filling the references after layout.
  const seekIds = ["1549a966", "1654ae6b", "1941a469", "1c53bb6b", "1254c367"];
  const seekHead = positions => element("114d9b74", Buffer.concat(seekIds.map(id => {
    const value = Buffer.alloc(8); value.writeBigUInt64BE(BigInt(positions[id] || 0));
    return element("4dbb", Buffer.concat([element("53ab", Buffer.from(id, "hex")), element("53ac", value)]));
  })));
  add(ebml); add(Buffer.from("1853806701ffffffffffffff", "hex"));
  const segmentData = size, seekAt = size, emptySeek = seekHead({}); add(emptySeek);
  const positions = {};
  for (const [id, bytes] of [["1549a966", info], ["1654ae6b", tracks], ["1941a469", attachments]]) { positions[id] = size - segmentData; add(bytes); }
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const children = [], push = (bytes, length = bytes.length) => children.push({ bytes, length });
    const timestamp = scalar("e7", cluster * 2000); push(timestamp);
    for (let frame = 0; frame < 48; frame++) {
      for (const [number, length, frameBytes] of [[1, 35000, videoFrame], [2, 1800, Buffer.alloc(0)], [2, 1800, Buffer.alloc(0)]]) {
        const block = Buffer.alloc(4); block[0] = 0x80 | number; block.writeInt16BE(Math.round(frame * 2000 / 48), 1);
        const prefix = Buffer.concat([head("a3", length + 4), block, frameBytes]);
        push(prefix, prefix.length + length - frameBytes.length);
      }
    }
    let relative;
    if (cluster % 2 === 0) {
      relative = children.reduce((sum, item) => sum + item.length, 0);
      const cue = element("a0", Buffer.concat([element("a1", Buffer.concat([Buffer.from([0x83, 0, 0, 0]), Buffer.from(`${subtitle} ${cluster / 2}`)])), scalar("9b", 2500)]));
      push(cue); payloads.push(cue);
    }
    const bodyLength = children.reduce((sum, item) => sum + item.length, 0), at = size;
    add(head("1f43b675", bodyLength)); clusterPositions.push(at);
    if (relative != null) cueRecords.push({ time: cluster * 2000, cluster: at - segmentData, relative });
    for (const item of children) add(item.bytes, item.length);
  }
  positions["1c53bb6b"] = size - segmentData;
  let records = indexed ? cueRecords : [];
  if (partialCues) records = records.slice(0, -1);
  if (duplicateCue && records.length > 1) records = [records[0], records[0], ...records.slice(2)];
  const cues = element("1c53bb6b", Buffer.concat(records.map(record => element("bb", Buffer.concat([
    scalar("b3", record.time), element("b7", Buffer.concat([scalar("f7", 3), scalar("f1", record.cluster),
      scalar("f0", invalidOffset ? record.relative + 1 : record.relative), scalar("b2", 2500)]))
  ])))));
  add(cues);
  positions["1254c367"] = size - segmentData;
  const tags = element("1254c367", statistics ? element("7373", Buffer.concat([
    element("63c0", scalar("63c5", wrongUid ? wrong : uid)), element("67c8", Buffer.concat([
      element("45a3", Buffer.from("NUMBER_OF_FRAMES")), element("4487", Buffer.from(String(cueRecords.length)))
    ]))
  ])) : Buffer.alloc(0)); add(tags);
  if (invalidSeek) positions["1c53bb6b"] = positions["1654ae6b"] + 1;
  parts.find(part => part.at === seekAt).bytes = seekHead(positions);
  const reads = [];
  function read(offset, length) {
    if (offset < 0 || length < 0 || offset + length > size) throw new Error("Invalid virtual fixture range");
    reads.push({ offset, length });
    const output = Buffer.alloc(length);
    let lo = 0, hi = parts.length;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (parts[mid].at <= offset) lo = mid; else hi = mid; }
    for (let i = lo; i < parts.length && parts[i].at < offset + length; i++) {
      const part = parts[i], start = Math.max(offset, part.at), end = Math.min(offset + length, part.at + part.bytes.length);
      if (end > start) part.bytes.copy(output, start - offset, start - part.at, end - part.at);
    }
    return output;
  }
  return { size, read, reads, uid, cueCount: cueRecords.length, clusterPositions, payloads, fontBytes, parts };
}

module.exports = { createEpisode };
