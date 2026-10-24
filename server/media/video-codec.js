const { parseBoxes, child, descend } = require("./containers/iso-boxes");

// Reuse the already-read MP4 sample entry. Do not start another probe or read
// media payloads merely to construct a browser capability query.
function isoVideoCodec(metadata) {
  if (!metadata?.moov) return "";
  try {
    for (const track of metadata.moov.children.filter(node => node.type === "trak")) {
      const handler = descend(track, "mdia", "hdlr");
      if (handler?.data.toString("ascii", 8, 12) !== "vide") continue;
      const stsd = descend(track, "mdia", "minf", "stbl", "stsd");
      if (!stsd || stsd.data.length < 8 || stsd.data.readUInt32BE(4) !== 1) return "";
      const entry = parseBoxes(stsd.data.subarray(8))[0];
      if (!entry || entry.data.length < 78) return "";
      const config = { children: parseBoxes(entry.data.subarray(78)) };
      if (["hvc1", "hev1"].includes(entry.type)) {
        const data = child(config, "hvcC")?.data;
        if (!data || data.length < 23 || data[0] !== 1) return "";
        const profile = data[1], space = ["", "A", "B", "C"][profile >> 6];
        let compatibility = data.readUInt32BE(2), reversed = 0;
        for (let bit = 0; bit < 32; bit++) { reversed = (reversed * 2 + (compatibility & 1)) >>> 0; compatibility >>>= 1; }
        const constraints = [...data.subarray(6, 12)];
        while (constraints.at(-1) === 0) constraints.pop();
        return `${entry.type}.${space}${profile & 31}.${reversed.toString(16).toUpperCase()}.${profile & 32 ? "H" : "L"}${data[12]}` +
          constraints.map(value => `.${value.toString(16).toUpperCase().padStart(2, "0")}`).join("");
      }
      if (["avc1", "avc3"].includes(entry.type)) {
        const data = child(config, "avcC")?.data;
        return data?.length >= 4 ? `${entry.type}.${data.subarray(1, 4).toString("hex")}` : "";
      }
      if (entry.type === "av01") {
        const data = child(config, "av1C")?.data;
        if (!data || data.length < 4) return "";
        const depth = data[2] & 64 ? (data[2] & 32 ? 12 : 10) : 8;
        return `av01.${data[1] >> 5}.${String(data[1] & 31).padStart(2, "0")}${data[2] & 128 ? "H" : "M"}.${String(depth).padStart(2, "0")}`;
      }
    }
  } catch { /* Unknown or complex sample descriptions use SDR compatibility. */ }
  return "";
}

module.exports = { isoVideoCodec };
