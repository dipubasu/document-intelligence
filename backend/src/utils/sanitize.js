const path = require('path');

// Makes a user-supplied file name safe.
// Removes danger from names like "..\..\evil.pdf" or "<script>.csv".
function sanitizeFilename(name) {
  // turn Windows \ into / and keep only the last part (drop the folder part)
  const base = path.basename(String(name || '').replace(/\\/g, '/'));

  const cleaned = base
    .replace(/[^A-Za-z0-9._ -]/g, '_') // everything except letters, digits, . _ - and space becomes _
    .replace(/\.{2,}/g, '.') // turn ".." into "."
    .replace(/^\.+/, '') // remove leading dots
    .trim();

  const out = cleaned.slice(-150); // at most 150 characters
  return out || 'file';
}

module.exports = { sanitizeFilename };