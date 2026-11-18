// Minimal ZIP writer (no compression: the contents are WebP images and a small CSV).
// Loaded as a content script before content.js; also importable in Node for tests.
//
//   const zip = new ZipWriter();
//   await zip.add('photo/abc.webp', blob);   // Blob, ArrayBuffer, Uint8Array or string
//   const blob = zip.finish();               // application/zip Blob
//
// Limits: classic ZIP (no ZIP64), so under 65,535 files and 4 GB in total.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

class ZipWriter {
  constructor(date = new Date()) {
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    this.date = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  }

  async add(name, data) {
    let bytes;
    if (typeof data === 'string') bytes = new TextEncoder().encode(data);
    else if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = new Uint8Array(await data.arrayBuffer());
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(bytes);
    const size = bytes.length;
    if (this.offset + size > 0xfffffffe || this.central.length >= 0xfffe) {
      throw new Error('Export too large for a ZIP file (4 GB / 65,535 files)');
    }

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header signature
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // flags: UTF-8 names
    local.setUint16(8, 0, true);           // method: stored
    local.setUint16(10, this.time, true);
    local.setUint16(12, this.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);       // compressed size
    local.setUint32(22, size, true);       // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);          // extra length
    this.parts.push(local.buffer, nameBytes, bytes);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);    // central directory signature
    cen.setUint16(4, 20, true);            // version made by
    cen.setUint16(6, 20, true);            // version needed
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, this.time, true);
    cen.setUint16(14, this.date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, size, true);
    cen.setUint32(24, size, true);
    cen.setUint16(28, nameBytes.length, true);
    // 30 extra len, 32 comment len, 34 disk, 36 internal attrs, 38 external attrs: all 0
    cen.setUint32(42, this.offset, true);  // local header offset
    this.central.push(cen.buffer, nameBytes);

    this.offset += 30 + nameBytes.length + size;
  }

  finish() {
    const count = this.central.length / 2;
    const cdSize = this.central.reduce((n, p) => n + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);    // end of central directory signature
    end.setUint16(8, count, true);         // entries on this disk
    end.setUint16(10, count, true);        // entries total
    end.setUint32(12, cdSize, true);
    end.setUint32(16, this.offset, true);  // central directory offset
    return new Blob([...this.parts, ...this.central, end.buffer], { type: 'application/zip' });
  }
}

if (typeof module !== 'undefined') module.exports = { ZipWriter, crc32 };
