/**
 * The one EXIF tag this project cares about: FocalLengthIn35mmFilm (41989 / 0xA405).
 *
 * This exists because of a bug the M0 round found and fixed. PIL's getexif() returns
 * IFD0, and an iPhone does not put 41989 there -- it lives in the Exif sub-IFD at 0x8769.
 * Every M0 row would silently have read the harness's 65 deg guess instead of the lens's
 * real 104.3 deg, and the recovered table aspect ratio would have been 1.06 instead of
 * 1.58 (m0/README.md, section 6). So this parser walks into the sub-IFD deliberately.
 *
 * A live getUserMedia stream has NO EXIF at all. That is the whole reason the app has to
 * assume a field of view and say on screen that it is assuming one.
 */

/** @returns {{f35:number, hfovDeg:number}|null} */
export function focalFromJpeg(buf) {
  const d = new DataView(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
  if (d.byteLength < 4 || d.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 4 <= d.byteLength) {
    if (d.getUint8(off) !== 0xff) { off++; continue; }
    const marker = d.getUint8(off + 1);
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
    if (marker === 0xda || marker === 0xd9) break;
    const len = d.getUint16(off + 2);
    if (marker === 0xe1 && off + 4 + 6 <= d.byteLength) {
      let s = '';
      for (let i = 0; i < 6; i++) s += String.fromCharCode(d.getUint8(off + 4 + i));
      if (s === 'Exif\0\0') {
        const r = parseTiff(d, off + 10);
        if (r) return r;
      }
    }
    off += 2 + len;
  }
  return null;
}

function parseTiff(d, base) {
  if (base + 8 > d.byteLength) return null;
  const b0 = d.getUint8(base), b1 = d.getUint8(base + 1);
  let le;
  if (b0 === 0x49 && b1 === 0x49) le = true;
  else if (b0 === 0x4d && b1 === 0x4d) le = false;
  else return null;
  if (d.getUint16(base + 2, le) !== 42) return null;
  const ifd0 = base + d.getUint32(base + 4, le);

  const readIFD = (start) => {
    if (start + 2 > d.byteLength) return {};
    const n = d.getUint16(start, le);
    const tags = {};
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > d.byteLength) break;
      const tag = d.getUint16(e, le);
      const type = d.getUint16(e + 2, le);
      const count = d.getUint32(e + 4, le);
      let value = null;
      const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
      const size = (sizes[type] || 1) * count;
      const at = size <= 4 ? e + 8 : base + d.getUint32(e + 8, le);
      if (at + Math.min(size, 8) <= d.byteLength) {
        if (type === 3) value = d.getUint16(at, le);
        else if (type === 4) value = d.getUint32(at, le);
        else if (type === 5) value = d.getUint32(at, le) / (d.getUint32(at + 4, le) || 1);
      }
      tags[tag] = value;
    }
    return tags;
  };

  const t0 = readIFD(ifd0);
  let f35 = t0[41989];
  if (!f35 && t0[0x8769]) {
    // The sub-IFD. This branch is the M0 bug fix.
    f35 = readIFD(base + t0[0x8769])[41989];
  }
  if (!f35 || !(f35 > 0)) return null;
  // A 35 mm frame is 36 mm wide; the tag is normalised to that.
  const hfov = (2 * Math.atan(36 / (2 * f35)) * 180) / Math.PI;
  return { f35, hfovDeg: hfov, source: 'exif' };
}
