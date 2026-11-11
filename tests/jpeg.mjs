// Monta um JPEG mínimo com EXIF (GPS e hora), como o drone grava, para os testes.
export function jpegComGPS({ lat, lon, alt = 80, data = '2026:11:11 10:00:00', bigEndian = false }) {
  const le = !bigEndian;
  const buf = new DataView(new ArrayBuffer(512));
  const u16 = (o, v) => buf.setUint16(o, v, le), u32 = (o, v) => buf.setUint32(o, v, le);
  // TIFF começa no 0 deste buffer
  buf.setUint16(0, le ? 0x4949 : 0x4d4d); u16(2, 42); u32(4, 8);
  // IFD0 em 8: 2 entradas (GPS 0x8825, Exif 0x8769)
  u16(8, 2);
  const ent = (o, tag, tipo, n, val) => { u16(o, tag); u16(o + 2, tipo); u32(o + 4, n); u32(o + 8, val); };
  ent(10, 0x8825, 4, 1, 60);
  ent(22, 0x8769, 4, 1, 200);
  u32(34, 0);
  // GPS IFD em 60: LatRef, Lat, LonRef, Lon, AltRef, Alt
  u16(60, 6);
  const txt = (o, c) => { buf.setUint8(o, c.charCodeAt(0)); buf.setUint8(o + 1, 0); };
  u16(62, 1); u16(64, 2); u32(66, 2); txt(70, lat < 0 ? 'S' : 'N');
  ent(74, 2, 5, 3, 300);
  u16(86, 3); u16(88, 2); u32(90, 2); txt(94, lon < 0 ? 'W' : 'E');
  ent(98, 4, 5, 3, 330);
  u16(110, 5); u16(112, 1); u32(114, 1); buf.setUint8(118, 0);
  ent(122, 6, 5, 1, 360);
  u32(134, 0);
  const dms = (o, v) => {
    v = Math.abs(v);
    const g = Math.floor(v), m = Math.floor((v - g) * 60), s = (v - g - m / 60) * 3600;
    u32(o, g); u32(o + 4, 1); u32(o + 8, m); u32(o + 12, 1); u32(o + 16, Math.round(s * 1e6)); u32(o + 20, 1e6);
  };
  dms(300, lat); dms(330, lon);
  u32(360, Math.round(alt * 100)); u32(364, 100);
  // Exif IFD em 200: DateTimeOriginal
  u16(200, 1); ent(202, 0x9003, 2, 20, 400); u32(214, 0);
  for (let i = 0; i < 19; i++) buf.setUint8(400 + i, data.charCodeAt(i));
  const tiff = new Uint8Array(buf.buffer, 0, 430);
  const app1 = new Uint8Array(4 + 6 + tiff.length);
  const a = new DataView(app1.buffer);
  a.setUint16(0, 0xffe1); a.setUint16(2, 2 + 6 + tiff.length);
  app1.set([0x45, 0x78, 0x69, 0x66, 0, 0], 4); app1.set(tiff, 10);
  const out = new Uint8Array(2 + app1.length + 4);
  out.set([0xff, 0xd8]); out.set(app1, 2); out.set([0xff, 0xda, 0, 2], 2 + app1.length);
  return out;
}
