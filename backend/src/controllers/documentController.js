const fs = require('fs');
const crypto = require('crypto');
const documentModel = require('../models/documentModel');
const { inspectFile } = require('../services/fileType');
const sanitizeModule = require('../utils/sanitize');
const logger = require('../utils/logger');

const sanitizeFilename = sanitizeModule.sanitizeFilename || sanitizeModule;

// বড় ফাইল পুরোটা memory-তে না তুলে stream করে sha256 বের করা হয়
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function removeFile(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    logger.warn('could not remove file', { filePath, message: err.message });
  }
}

// POST /api/documents
async function upload(req, res) {
  const files = req.files || [];
  if (files.length === 0) {
    return res
      .status(400)
      .json({ error: 'No files uploaded. Send files in the form field "files".' });
  }

  const accepted = [];
  const rejected = [];

  for (const file of files) {
    const name = sanitizeFilename(file.originalname);
    try {
      // ফাইলের ভেতরের magic bytes দেখে আসল ধরন মেলানো হয়
      const check = await inspectFile(file.path, file.originalname);
      if (!check.ok) {
        await removeFile(file.path);
        rejected.push({ name, error: check.error });
        continue;
      }

      const sha256 = await sha256File(file.path);
      const { documentId, jobId } = documentModel.createWithJob({
        original_name: name,
        stored_name: file.filename,
        mime_type: check.mime || file.mimetype || null,
        detected_type: check.detectedType,
        size_bytes: file.size,
        sha256,
      });

      accepted.push({
        id: documentId,
        name,
        detected_type: check.detectedType,
        size_bytes: file.size,
        status: 'queued',
        job_id: jobId,
      });
    } catch (err) {
      logger.error('upload failed for file', { name, message: err.message, stack: err.stack });
      await removeFile(file.path);
      rejected.push({ name, error: 'Could not store this file' });
    }
  }

  // অন্তত একটা ফাইল নিলে 202 (Accepted), সব বাদ গেলে 400
  const status = accepted.length > 0 ? 202 : 400;
  return res.status(status).json({ accepted, rejected });
}

// GET /api/documents/:id
async function getStatus(req, res) {
  if (!/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Invalid document id' });
  }
  const id = Number(req.params.id);

  const doc = documentModel.getById(id);
  if (!doc) {
    return res.status(404).json({ error: 'Document not found' });
  }

  return res.json({
    document: documentModel.toPublic(doc),
    job: documentModel.getLatestJob(id) || null,
    history: documentModel.getHistory(id),
  });
}

module.exports = { upload, getStatus };