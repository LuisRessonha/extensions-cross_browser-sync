import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ASSETS_DIR = path.resolve(process.cwd(), 'assets');
fs.mkdirSync(ASSETS_DIR, { recursive: true });

// 1. Write crisp vector SVG icon
const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2563eb" />
      <stop offset="100%" stop-color="#4f46e5" />
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#bg)" />
  <g fill="none" stroke="#ffffff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round">
    <path d="M96 42H40a12 12 0 0 0-12 12v8" />
    <polyline points="78 24 96 42 78 60" />
    <path d="M32 86h56a12 12 0 0 0 12-12v-8" />
    <polyline points="50 104 32 86 50 68" />
  </g>
</svg>
`;
fs.writeFileSync(path.join(ASSETS_DIR, 'icon.svg'), svgContent, 'utf8');

// 2. Pure-Node PNG encoder to generate 16x16, 32x32, 48x48, and 128x128 icons
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function renderIconPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const center = (size - 1) / 2;
  const radius = size * 0.32;
  const ringThickness = Math.max(1.6, size * 0.095);
  const cornerRadius = size * 0.22;

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0; // filter type 0

    for (let x = 0; x < size; x++) {
      const pxOffset = rowOffset + 1 + x * 4;

      // Rounded rect mask
      const dx = Math.max(0, Math.abs(x - center) - (size / 2 - cornerRadius));
      const dy = Math.max(0, Math.abs(y - center) - (size / 2 - cornerRadius));
      const distCorner = Math.hypot(dx, dy);

      if (distCorner > cornerRadius + 0.5) {
        raw[pxOffset] = 0;
        raw[pxOffset + 1] = 0;
        raw[pxOffset + 2] = 0;
        raw[pxOffset + 3] = 0;
        continue;
      }

      const edgeAlpha =
        distCorner > cornerRadius - 0.5
          ? Math.max(0, Math.min(1, cornerRadius + 0.5 - distCorner))
          : 1;

      // Gradient background (#2563eb -> #4f46e5)
      const t = (x + y) / (2 * size);
      let r = Math.round(37 + (79 - 37) * t);
      let g = Math.round(99 + (70 - 99) * t);
      let b = Math.round(235 + (229 - 235) * t);

      // Sync ring with two directional gaps
      const rx = x - center;
      const ry = y - center;
      const distCenter = Math.hypot(rx, ry);
      const angle = Math.atan2(ry, rx); // -PI to PI

      const inRing = Math.abs(distCenter - radius) <= ringThickness / 2;
      const inGap =
        (angle > -0.35 && angle < 0.25) ||
        (angle > Math.PI - 0.35 || angle < -Math.PI + 0.25);

      // Arrowheads at top-right and bottom-left of ring
      const arrow1Dist = Math.hypot(rx - radius * 0.78, ry + radius * 0.55);
      const arrow2Dist = Math.hypot(rx + radius * 0.78, ry - radius * 0.55);
      const inArrow = arrow1Dist <= ringThickness * 0.95 || arrow2Dist <= ringThickness * 0.95;

      if ((inRing && !inGap) || inArrow) {
        r = 255;
        g = 255;
        b = 255;
      }

      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = Math.round(edgeAlpha * 255);
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', idat),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const pngBuffer = renderIconPng(size);
  const filePath = path.join(ASSETS_DIR, `icon-${size}.png`);
  fs.writeFileSync(filePath, pngBuffer);
  console.log(`Generated ${filePath} (${pngBuffer.length} bytes)`);
}

