const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { ALLOWED_EXTENSIONS } = require('../services/fileType');

fs.mkdirSync(config.uploadDir, { recursive: true });

// disk এ ফাইল রাখে random নামে। ব্যবহারকারীর দেওয়া নাম disk এর নামে আসে না
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

// ফাইল disk এ লেখার আগেই extension দেখে অসমর্থিত ধরন ফেরত দেয়
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const err = new Error(`Unsupported file type: ${ext.slice(0, 10) || '(none)'}`);
    err.status = 400;
    return cb(err);
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.upload.maxFileSizeBytes,
    files: config.upload.maxFilesPerUpload,
  },
});

const handler = upload.array('files', config.upload.maxFilesPerUpload);

// multer এর error কে ঠিক HTTP status দেয় (বেশি বড় ফাইল = 413, বাকি = 400)
function uploadFiles(req, res, next) {
  handler(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      err.status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    }
    next(err);
  });
}

module.exports = { uploadFiles };