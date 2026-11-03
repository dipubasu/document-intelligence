const express = require('express');
const rateLimit = require('express-rate-limit');
const uploadModule = require('../middleware/upload');
const documentController = require('../controllers/documentController');

const uploadFiles = uploadModule.uploadFiles || uploadModule;

const router = express.Router();

// separate, stricter limit for uploads: 30 per minute per IP
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/', uploadLimiter, uploadFiles, documentController.upload);
router.get('/:id', documentController.getStatus);

module.exports = router;