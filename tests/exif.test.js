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

  // What this test is FOR is the sub-IFD walk -- that a real iPhone JPEG yields a focal
  // length at all. An earlier version asserted 14 mm on every file in photos/, which
  // silently made the test a property of one photo set: adding photos shot on the 1x lens
  // (24 mm) failed it, even though the parser was working perfectly. So assert the parse,
  // assert the lens formula, and report the focal lengths found rather than fixing them.
  test('reads the focal length out of the Exif sub-IFD, not IFD0', () => {
    assert(files.length > 0, 'no JPEGs found');
    const byFocal = new Map();
    let read = 0;
    for (const f of files) {
      const r = focalFromJpeg(readFileSync(new URL(f, photos)));
      if (!r) continue;
      read++;
      assert(r.f35 > 5 && r.f35 < 400, `${f}: f35 ${r.f35} mm is not a plausible 35 mm equivalent`);
      // 36 mm is the full-frame sensor width the "35 mm equivalent" is defined against.
      const expected = 2 * Math.atan(36 / (2 * r.f35)) * 180 / Math.PI;
      close(r.hfovDeg, expected, 0.05, `${f}: FOV derived from f35=${r.f35}`);
      byFocal.set(r.f35, (byFocal.get(r.f35) || 0) + 1);
    }
    assert(read === files.length, `only ${read} of ${files.length} photos yielded a focal length`);
    note([...byFocal.entries()].sort((a, b) => a[0] - b[0])
      .map(([f35, n]) => `${n}x ${f35} mm`).join(', ') + ` (${read} photos)`);
  });

  // The one focal length the write-up actually cites, anchored by filename so it cannot
  // drift, and skipped rather than failed when that photo is not in this clone.
  const anchor = 'IMG_5359.JPG';
  if (files.includes(anchor)) {
    test('the M0 reference photo still reads 14 mm / 104.25 deg', () => {
      const r = focalFromJpeg(readFileSync(new URL(anchor, photos)));
      assert(r, `${anchor}: no focal length`);
      close(r.f35, 14, 0.001, `${anchor} FocalLengthIn35mmFilm`);
      close(r.hfovDeg, 104.25, 0.05, `${anchor} horizontal FOV`);
      note('iPhone 0.5x ultra-wide -- the lens the M0 eleven were shot on');
    });
  } else {
    skip('the M0 reference photo still reads 14 mm / 104.25 deg', `${anchor} not in photos/`);
  }

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
