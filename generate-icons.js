import fs from 'fs';
import zlib from 'zlib';

function createSolidPng(width, height, r, g, b) {
  // A simple valid uncompressed/deflated PNG generator
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: 2 (truecolor RGB)
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace

  const ihdr = makeChunk('IHDR', ihdrData);

  // Scanlines with filter byte 0
  const rowSize = 1 + width * 3;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // filter type None
    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * 3;
      // Draw a pleasant indigo rounded-card style
      const cx = width / 2;
      const cy = height / 2;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      
      // Center icon symbol area (chemical flask / calendar mark in white/gold)
      if (dist < width * 0.28 && Math.abs(x - cx) < width * 0.18) {
        rawData[pixelOffset] = 255;
        rawData[pixelOffset + 1] = 255;
        rawData[pixelOffset + 2] = 255;
      } else if (dist < width * 0.44) {
        rawData[pixelOffset] = r;
        rawData[pixelOffset + 1] = g;
        rawData[pixelOffset + 2] = b;
      } else {
        rawData[pixelOffset] = Math.max(0, r - 30);
        rawData[pixelOffset + 1] = Math.max(0, g - 30);
        rawData[pixelOffset + 2] = Math.max(0, b - 30);
      }
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crcBuf]);
}

// Simple CRC32 implementation
function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }

  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ (-1)) >>> 0;
}

// Indigo theme: 79, 70, 229 (#4f46e5)
const png192 = createSolidPng(192, 192, 79, 70, 229);
const png512 = createSolidPng(512, 512, 79, 70, 229);

fs.writeFileSync('public/icon-192.png', png192);
fs.writeFileSync('public/icon-512.png', png512);
fs.writeFileSync('public/apple-touch-icon.png', png192);

if (fs.existsSync('Public')) {
  fs.writeFileSync('Public/icon-192.png', png192);
  fs.writeFileSync('Public/icon-512.png', png512);
  fs.writeFileSync('Public/apple-touch-icon.png', png192);
}

console.log('PNG icons created successfully!');
