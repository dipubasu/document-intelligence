const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OCR_LANGUAGE = 'eng';
// Time allowed for reading one image (starting the engine is not counted).
const OCR_TIMEOUT_MS = 120000;
// Small images are enlarged, huge ones are shrunk, so OCR works well and memory stays low.
const MIN_WIDTH = 1200;
const UPSCALE_WIDTH = 1800;
const MAX_WIDTH = 4000;
// Language data is cached here (backend/data is not committed to git).
const CACHE_DIR = path.join(__dirname, '..', '..', '..', 'data', 'tessdata');

function makeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Clean the picture so OCR reads it better: fix rotation, grayscale, stretch contrast.
async function preprocess(filePath) {
  try {
    const meta = await sharp(filePath).metadata();
    let image = sharp(filePath).rotate().grayscale().normalize();
    const width = meta.width || 0;
    if (width > MAX_WIDTH) {
      image = image.resize({ width: MAX_WIDTH });
    } else if (width > 0 && width < MIN_WIDTH) {
      image = image.resize({ width: UPSCALE_WIDTH });
    }
    return await image.png().toBuffer();
  } catch (err) {
    throw makeError('Could not read image: file is corrupted or invalid', 'IMAGE_UNREADABLE');
  }
}

// One OCR worker is created on first use and reused for every image.
let workerPromise = null;

function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker } = require('tesseract.js');
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      return createWorker(OCR_LANGUAGE, undefined, { cachePath: CACHE_DIR });
    })();
    // a failed start must not be remembered, so the next image can try again
    workerPromise.catch(() => {
      workerPromise = null;
    });
  }
  return workerPromise;
}

async function shutdownOcr() {
  const pending = workerPromise;
  workerPromise = null;
  if (!pending) return;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch (err) {
    // nothing to clean up
  }
}

// Only one image is read at a time by the shared worker.
let chain = Promise.resolve();
function runExclusive(task) {
  const result = chain.then(task);
  chain = result.catch(() => {});
  return result;
}

async function recognize(buffer) {
  return runExclusive(async () => {
    let worker;
    try {
      worker = await getWorker();
    } catch (err) {
      throw makeError(
        'OCR engine could not start. The first OCR run downloads English language data and needs internet access',
        'OCR_START_FAILED'
      );
    }

    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(makeError('OCR took too long and was stopped', 'OCR_TIMEOUT')),
        OCR_TIMEOUT_MS
      );
    });

    try {
      const result = await Promise.race([worker.recognize(buffer), timeout]);
      const data = result && result.data;
      if (!data || typeof data.text !== 'string') {
        throw makeError('OCR returned an unexpected result', 'OCR_BAD_RESULT');
      }
      return {
        text: data.text,
        confidence: typeof data.confidence === 'number' ? data.confidence : null,
      };
    } catch (err) {
      if (err.code === 'OCR_TIMEOUT') await shutdownOcr();
      if (err.code) throw err;
      throw makeError('OCR failed while reading the image', 'OCR_FAILED');
    } finally {
      clearTimeout(timer);
    }
  });
}

// Same output shape as the other parsers. `options.recognize` lets tests replace OCR.
async function parseImage(filePath, options = {}) {
  const recognizeFn = options.recognize || recognize;
  const buffer = await preprocess(filePath);
  const { text, confidence } = await recognizeFn(buffer);

  const clean = String(text || '').trim();
  return {
    pages: [
      {
        page_number: 1,
        sheet_name: null,
        text: clean,
        ocr_used: true,
        ocr_confidence: confidence === null || confidence === undefined
          ? null
          : Math.round(confidence * 10) / 10,
      },
    ],
    pageCount: 1,
    lowTextPages: [],
  };
}

module.exports = { parseImage, shutdownOcr };