const LIMIT = 64 * 1024 * 1024;
const MAX_ENTRIES = 1000000;

function unsupported(message = "This container cannot supply embedded captions selectively.") {
  return new Error(`${message} Add an external SRT, VTT, ASS, or SSA subtitle file.`);
}
function check(condition, message = "Invalid or unsupported subtitle container.") {
  if (!condition) throw unsupported(message);
}
function safe(value) {
  const number = Number(value);
  check(Number.isSafeInteger(number) && number >= 0, "Invalid container offset or size.");
  return number;
}
function checkedReader(source, signal) {
  check(source && Number.isSafeInteger(source.size) && source.size >= 8 && typeof source.read === "function");
  function validate(offset, length) {
    check(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && length <= LIMIT && offset + length <= source.size);
  }
  const reader = {
    size: source.size,
    signal,
    metrics: () => source.metrics ? { ...source.metrics } : {},
    async read(offset, length) {
      signal.throwIfAborted();
      validate(offset, length);
      if (!length) return Buffer.alloc(0);
      const chunks = [];
      for (let at = offset; at < offset + length; at += 256 * 1024) {
        signal.throwIfAborted();
        const count = Math.min(256 * 1024, offset + length - at);
        const bytes = await source.read(at, count, signal);
        check(bytes.length === count, "The file provider returned incomplete subtitle data.");
        chunks.push(bytes);
      }
      signal.throwIfAborted();
      return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    },
    async readMany(ranges) {
      signal.throwIfAborted();
      check(ranges.length <= MAX_ENTRIES);
      const pieces = [], outputs = ranges.map(() => []);
      let total = 0;
      ranges.forEach(({ offset, length }, index) => {
        validate(offset, length); total += length;
        for (let at = offset; at < offset + length; at += 256 * 1024) {
          pieces.push({ offset: at, length: Math.min(256 * 1024, offset + length - at), index });
        }
      });
      check(total <= LIMIT);
      for (let at = 0; at < pieces.length;) {
        const batch = []; let bytes = 0;
        while (at < pieces.length && batch.length < 64 && bytes + pieces[at].length <= 256 * 1024) {
          bytes += pieces[at].length; batch.push(pieces[at++]);
        }
        signal.throwIfAborted();
        let buffers;
        if (source.readMany) buffers = await source.readMany(batch.map(({ offset, length }) => ({ offset, length })), signal);
        else {
          buffers = Array(batch.length); let next = 0;
          await Promise.all(Array.from({ length: Math.min(4, batch.length) }, async () => {
            while (next < batch.length) { const index = next++; buffers[index] = await reader.read(batch[index].offset, batch[index].length); }
          }));
        }
        check(buffers.length === batch.length);
        buffers.forEach((buffer, index) => { check(buffer.length === batch[index].length); outputs[batch[index].index].push(buffer); });
      }
      signal.throwIfAborted();
      return outputs.map(chunks => chunks.length === 1 ? chunks[0] : Buffer.concat(chunks));
    }
  };
  return reader;
}
function concat(chunks) {
  check(chunks.reduce((sum, chunk) => sum + chunk.length, 0) <= LIMIT, "Embedded captions exceed the extraction size limit.");
  return Buffer.concat(chunks);
}
function u32(value) { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; }
function u64(value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return bytes; }
function srtTime(seconds) {
  const ms = Math.round(seconds * 1000);
  check(Number.isSafeInteger(ms) && ms >= 0);
  return `${Math.floor(ms / 3600000).toString().padStart(2, "0")}:${(Math.floor(ms / 60000) % 60).toString().padStart(2, "0")}:${(Math.floor(ms / 1000) % 60).toString().padStart(2, "0")},${(ms % 1000).toString().padStart(3, "0")}`;
}
module.exports = { LIMIT, MAX_ENTRIES, unsupported, check, safe, checkedReader, concat, u32, u64, srtTime };
