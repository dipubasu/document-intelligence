// Makes two SYNTHETIC invoice pictures for testing OCR:
// a clean one and a poor one (small, tilted, blurred, low JPEG quality).
// They are generated images, not real scans.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const outDir = process.argv[2] || path.join(__dirname, '..', '..', '..', 'test-files');

const W = 1000;
const H = 1300;
const FONT = 'Arial, Helvetica, sans-serif';

function text(x, y, content, size = 28, weight = 'normal', anchor = 'start') {
  return (
    `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" ` +
    `font-weight="${weight}" text-anchor="${anchor}" fill="#000000">${content}</text>`
  );
}

const parts = [
  `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
  text(60, 90, 'Northwind Traders Ltd', 44, 'bold'),
  text(60, 130, '12 Harbour Road, Springfield', 26),
  text(940, 90, 'INVOICE', 40, 'bold', 'end'),
  text(60, 250, 'Invoice No: NW-2026-010'),
  text(60, 295, 'Date: 2026-03-05'),
  text(60, 340, 'Customer: Bright Future School'),
  text(60, 385, 'Currency: USD'),
  `<line x1="60" y1="450" x2="940" y2="450" stroke="#000000" stroke-width="2"/>`,
  text(60, 490, 'Description', 28, 'bold'),
  text(560, 490, 'Qty', 28, 'bold', 'end'),
  text(740, 490, 'Unit price', 28, 'bold', 'end'),
  text(940, 490, 'Amount', 28, 'bold', 'end'),
  `<line x1="60" y1="505" x2="940" y2="505" stroke="#000000" stroke-width="2"/>`,
  text(60, 550, 'Notebook'),
  text(560, 550, '20', 28, 'normal', 'end'),
  text(740, 550, '2.50', 28, 'normal', 'end'),
  text(940, 550, '50.00', 28, 'normal', 'end'),
  text(60, 600, 'Marker set'),
  text(560, 600, '10', 28, 'normal', 'end'),
  text(740, 600, '4.00', 28, 'normal', 'end'),
  text(940, 600, '40.00', 28, 'normal', 'end'),
  `<line x1="60" y1="630" x2="940" y2="630" stroke="#000000" stroke-width="2"/>`,
  text(740, 700, 'Subtotal:', 28, 'normal', 'end'),
  text(940, 700, '90.00', 28, 'normal', 'end'),
  text(740, 745, 'Tax:', 28, 'normal', 'end'),
  text(940, 745, '9.00', 28, 'normal', 'end'),
  text(740, 810, 'Total (USD):', 32, 'bold', 'end'),
  text(940, 810, '99.00', 32, 'bold', 'end'),
];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`;

async function main() {
  fs.mkdirSync(outDir, { recursive: true });

  const cleanPath = path.join(outDir, 'invoice-clean.png');
  const poorPath = path.join(outDir, 'invoice-poor.jpg');

  const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();
  await sharp(pngBuffer).toFile(cleanPath);

  await sharp(pngBuffer)
    .rotate(2, { background: '#ffffff' })
    .resize({ width: 650 })
    .blur(0.8)
    .jpeg({ quality: 35 })
    .toFile(poorPath);

  for (const file of [cleanPath, poorPath]) {
    console.log(`${file}  (${fs.statSync(file).size} bytes)`);
  }
}

main().catch((err) => {
  console.log('FAILED:', err.message);
  process.exitCode = 1;
});