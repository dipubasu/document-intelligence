const express = require('express');
const rateLimit = require('express-rate-limit');
const uploadModule = require('../middleware/upload');
const documentController = require('../controllers/documentController');

const uploadFiles = uploadModule.uploadFiles || uploadModule;

const router = express.Router();

// upload-এর জন্য আলাদা, কড়া limit: প্রতি IP থেকে মিনিটে ৩০টা
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/', uploadLimiter, uploadFiles, documentController.upload);
router.get('/:id', documentController.getStatus);

module.exports = router;