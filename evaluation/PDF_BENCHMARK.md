# PDF parsing benchmark

Run: 2026-11-07T06:32:14.804Z. Node v24.22.0. 8 CPU threads, 20220.6 MB RAM, win32.

This measures **parsing only** (text extraction with `parsePdf`), one run per size. No LLM was called.
Settings: maxPages 1500, chunk size 50 pages.

| Pages | File size (MB) | Parse time (ms) | Pages per second | Pages with correct text | Peak RSS (MB) |
|---|---|---|---|---|---|
| 100 | 0.1 | 172 | 580.6 | 100/100 | 87.8 |
| 500 | 0.6 | 483 | 1034.2 | 500/500 | 118 |
| 1000 | 1.2 | 900 | 1111.2 | 1000/1000 | 170.8 |

Over-limit check: a 1501-page PDF was rejected (code PAGE_LIMIT, 32 ms).

## How to read this

- The test PDFs are simple: made by code, 15 short text lines per page, one font, no images. Real PDFs with images, many fonts or complex layout can be slower and use more memory.
- Peak RSS is the memory of the whole Node process, sampled every 20 ms, and it includes earlier runs in the same process, so it is not the cost of one run alone.
- One run per size on one machine. These are not averages.
- Only parsing was measured. Sending a 1000-page document through extraction is not built (see docs/ASSUMPTIONS_AND_LIMITATIONS.md).
