const path = require('path');

// ব্যবহারকারীর দেওয়া ফাইলের নাম নিরাপদ করে।
// "..\..\evil.pdf" বা "<script>.csv" এর মতো নাম থেকে বিপদ সরিয়ে দেয়।
function sanitizeFilename(name) {
  // Windows এর \ কে / বানিয়ে শুধু শেষের ফাইলের নাম রাখে (folder অংশ ফেলে দেয়)
  const base = path.basename(String(name || '').replace(/\\/g, '/'));

  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, '_') // অক্ষর, সংখ্যা, . _ - ও space ছাড়া সব _ হবে
    .replace(/\.{2,}/g, '.') // ".." কে "." বানায়
    .replace(/^\.+/, '') // শুরুর . মুছে দেয়
    .trim();

  const out = cleaned.slice(-150); // সর্বোচ্চ ১৫০ অক্ষর
  return out || 'file';
}

module.exports = { sanitizeFilename };