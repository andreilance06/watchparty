const { check, safe, MAX_ENTRIES } = require("./bytes");

const masters = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "mvex", "moof", "traf"]);
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

async function boxHeader(reader, at) {
  const header = await reader.read(at, Math.min(16, reader.size - at));
  check(header.length >= 8);
  let size = header.readUInt32BE(0), head = 8;
  const type = header.toString("ascii", 4, 8);
  if (size === 1) { check(header.length === 16); size = safe(header.readBigUInt64BE(8)); head = 16; }
  if (!size) size = reader.size - at;
  check(size >= head && Number.isSafeInteger(at + size) && at + size <= reader.size);
  return { at, size, head, type };
}

module.exports = { parseBoxes, child, descend, boxHeader };
