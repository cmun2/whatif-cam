/**
 * The EXIF path, and the bug M0 found in it.
 *
 * iPhones write FocalLengthIn35mmFilm into the Exif sub-IFD (0x8769), not IFD0. A reader
 * that only walks IFD0 silently returns nothing, the caller silently falls back to a
 * guessed field of view, and every number downstream is quietly wrong -- which is exactly
 * what happened to the M0 harness before m0/README.md section 6.
 */
import { test, assert, close, skip, note } from './harness.js';
import { focalFromJpeg } from '../app/src/exif.js';
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const photos = new URL('../photos/', import.meta.url);

if (!existsSync(photos)) {
  skip('reads the focal length out of the Exif sub-IFD, not IFD0', 'no photos/ in this clone');
} else {
  const files = readdirSync(photos).filter((f) => /\.jpe?g$/i.test(f)).sort();
  test('reads the focal length out of the Exif sub-IFD, not IFD0', () => {
    assert(files.length > 0, 'no JPEGs found');
    let read = 0;
    for (const f of files) {
      const r = focalFromJpeg(readFileSync(new URL(f, photos)));
      if (!r) continue;
      read++;
      close(r.f35, 14, 0.001, `${f} FocalLengthIn35mmFilm`);
      close(r.hfovDeg, 104.25, 0.05, `${f} horizontal FOV`);
    }
    assert(read === files.length, `only ${read} of ${files.length} photos yielded a focal length`);
    note(`${read} photos, all 14 mm equivalent = 104.25 deg horizontal (iPhone 0.5x ultra-wide)`);
  });

  test('the same files through IFD0 alone would have given nothing', () => {
    // Sanity: the tag really is absent from IFD0, so the sub-IFD walk is load-bearing and
    // not belt-and-braces. Parse IFD0 by hand and confirm 41989 is not there.
    const buf = readFileSync(new URL(files[0], photos));
    const d = new DataView(buf.buffer, buf.byteOffset, buf.length);
    let off = 2, base = -1;
    while (off + 4 <= d.byteLength) {
      if (d.getUint8(off) !== 0xff) { off++; continue; }
      const marker = d.getUint8(off + 1);
      if (marker === 0xda) break;
      const len = d.getUint16(off + 2);
      if (marker === 0xe1) { base = off + 10; break; }
      off += 2 + len;
    }
    assert(base > 0, 'no APP1 segment');
    const le = d.getUint8(base) === 0x49;
    const ifd0 = base + d.getUint32(base + 4, le);
    const n = d.getUint16(ifd0, le);
    let found = false;
    for (let i = 0; i < n; i++) if (d.getUint16(ifd0 + 2 + i * 12, le) === 41989) found = true;
    assert(!found, 'tag 41989 turned out to BE in IFD0 -- the comment in exif.js needs updating');
  });
}

test('a file that is not a JPEG returns null rather than a wrong number', () => {
  assert(focalFromJpeg(new Uint8Array([1, 2, 3, 4])) === null);
  assert(focalFromJpeg(new Uint8Array(64)) === null);
});
