import { deflateRawSync } from "node:zlib";

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function safeArchivePath(name) {
  if (
    typeof name !== "string" ||
    !name ||
    !/^[A-Za-z0-9_./-]+$/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  return name;
}

// Small deterministic ZIP32 writer for the source-composed extension bundles.
// Fixed DOS epoch, UTF-8 names and file modes keep bytes independent of the host.
export function createZip(entries) {
  if (entries.length > 65535) throw new Error("ZIP32 entry limit exceeded.");
  const local = [];
  const central = [];
  const seen = new Set();
  let offset = 0;
  const sorted = [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const { name, bytes } of sorted) {
    safeArchivePath(name);
    if (seen.has(name)) throw new Error(`Duplicate archive path: ${name}`);
    seen.add(name);
    if (!Buffer.isBuffer(bytes)) {
      throw new TypeError("ZIP entries require Buffer data.");
    }
    const filename = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(bytes, { level: 9 });
    if (
      filename.length > 65535 ||
      bytes.length > 0xffffffff ||
      compressed.length > 0xffffffff ||
      offset > 0xffffffff
    ) {
      throw new Error("ZIP32 size limit exceeded.");
    }
    const crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x314, 4);
    header.copy(directory, 6, 4, 30);
    directory.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directoryBytes = Buffer.concat(central);
  if (offset + directoryBytes.length > 0xffffffff) {
    throw new Error("ZIP32 size limit exceeded.");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}
