import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ---- 输出位置（相对 frontend/）----
const publicDir = join(root, 'public');
const buildDir = join(root, '..', 'build');

const svgPath = join(publicDir, 'favicon.svg');
const svg = readFileSync(svgPath);

const PNG_SIZES = [16, 32, 192, 512];
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];
const APPLE_TOUCH = 180;

function render(size, to) {
  return sharp(svg, { density: 72 }).resize(size, size).png().toFile(to);
}

// ---- PNG 直出 ----
mkdirSync(publicDir, { recursive: true });
mkdirSync(buildDir, { recursive: true });

for (const size of PNG_SIZES) {
  await render(size, join(publicDir, `favicon-${size}.png`));
}
await render(APPLE_TOUCH, join(publicDir, 'apple-touch-icon.png'));
await render(512, join(buildDir, 'appicon.png'));

// ---- PNG 压缩 ICO 打包（手写二进制，Vista+ 格式）----
async function buildIco(sizes, target) {
  const pngs = [];
  for (const size of sizes) {
    pngs.push({ size, data: await sharp(svg, { density: 72 }).resize(size, size).png().toBuffer() });
  }
  const headerSize = 6 + pngs.length * 16;
  const total = Buffer.alloc(headerSize);
  total.writeUInt16LE(0, 0);      // reserved
  total.writeUInt16LE(1, 2);      // type: icon
  total.writeUInt16LE(pngs.length, 4);

  let offset = headerSize;
  pngs.forEach((p, i) => {
    const e = i * 16 + 6;
    total.writeUInt8(p.size >= 256 ? 0 : p.size, e);      // width (0 => 256)
    total.writeUInt8(p.size >= 256 ? 0 : p.size, e + 1);  // height
    total.writeUInt8(0, e + 2);                            // color count
    total.writeUInt8(0, e + 3);                            // reserved
    total.writeUInt16LE(1, e + 4);                         // planes
    total.writeUInt16LE(32, e + 6);                        // bit count
    total.writeUInt32LE(p.data.length, e + 8);             // bytes in res
    total.writeUInt32LE(offset, e + 12);                   // image offset
    offset += p.data.length;
  });
  const body = Buffer.concat(pngs.map(p => p.data));
  const ico = Buffer.concat([total, body]);
  writeFileSync(target, ico);
}

await buildIco(ICO_SIZES, join(buildDir, 'windows', 'icon.ico'));
await buildIco([48, 32, 16], join(publicDir, 'favicon.ico'));

console.log('icons generated:');
console.log('  public/favicon.svg (design source)');
for (const size of PNG_SIZES) console.log(`  public/favicon-${size}.png`);
console.log(`  public/apple-touch-icon.png (${APPLE_TOUCH})`);
console.log('  public/favicon.ico (48/32/16)');
console.log('  ../build/appicon.png (512)');
console.log('  ../build/windows/icon.ico (256/128/64/48/32/24/16)');