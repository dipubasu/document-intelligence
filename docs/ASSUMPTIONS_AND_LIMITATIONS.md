# Assumptions and limitations

This page lists what was assumed, what is not built, and what is known to behave badly. Nothing here is hidden on purpose. Measured numbers are only in `evaluation/REPORT.md`, `evaluation/SEMANTIC_REPORT.md` and `evaluation/SECURITY_REPORT.md`.

## Assumptions

The task text had no sample files and no further detail, so these assumptions were made:

- **Cross verification** means: the same invoice (same supplier and invoice number) appears in two documents (PDF, Excel, CSV or image), and the system checks whether the values match. A mismatch gives a `cross_document_mismatch` issue. Purchase-order matching is not done.
- **"1000 pages"** is assumed to mean one large PDF. The PDF parser reads it page by page in chunks of 50 pages, with a limit of 1500 pages (`MAX_PDF_PAGES`). See the Performance section of the README for what was measured.
- **One document = one invoice.** A file that contains many invoices is not split.
- **All test data is synthetic**, made by `evaluation/generateDataset.js`. No real business documents were used.

## Not built

- Scanned PDFs (OCR on PDF pages) and TIFF images. A TIFF gives `OCR_NOT_AVAILABLE` with the message "This image format is not supported yet. Please convert it to PNG or JPG".
- Old `.xls` files (`XLS_NOT_SUPPORTED`). Use `.xlsx`.
- Splitting one large PDF into many invoices for extraction.
- BullMQ + Redis queue (the queue is a SQLite table; the upgrade path is described in the README).
- PostgreSQL and pgvector (SQLite is used).
- Login and user accounts. Anyone who can reach the API can use it.
- Line-item editing in the web UI (possible through the API only).
- A "reviewed, everything is OK" button.
- Antivirus scanning of uploads. A zip-bomb test was **not** run, so that risk is untested.

## Input handling

- `.xlsx` is detected only by the ZIP signature.
- UTF-16 CSV files are rejected.
- Characters that are not plain ASCII in a file name become `_` in the stored display name.
- A batch with one file of a wrong extension is rejected completely (400), including the good files. An empty `.csv` gives 400.
- OCR: JPG and PNG only, English only. The first run downloads `eng.traineddata` (about 5.2 MB) from a CDN; offline servers must place it in `backend/data/tessdata` beforehand. One image is processed at a time, with a 120 s timeout. The OCR test images are synthetic, not real scans.

## AI extraction

- Only the first 12,000 characters of a document go to the model. A longer document gets a `text_truncated` warning. A possible later improvement is to send the start and the end.
- The model `confidence` values are not reliable. The model output is not identical between two runs.
- The Groq plan used has a limit of 8000 tokens per minute. Large documents are therefore cut, and many files at once can give "AI service is busy". The Retry button works.
- Reprocess works only for failed documents. It deletes the old extraction and its corrections.
- If the invoice date is ambiguous, the result only shows "invoice_date is missing".

## Validation and duplicates

- The same file uploaded twice at exactly the same moment may call the model twice. The second one is still caught as `duplicate_invoice`.
- Every new duplicate upload adds one `duplicate_invoice` issue per earlier copy, so the list can get noisy.
- A result reused for an identical file does not repeat the `text_truncated` warning.
- Changing the invoice number of document B re-validates B, but the earlier `duplicate_invoice` issue on document A is not re-checked.

## Evaluation: how to read the numbers

- **Success rate 100%** means the job reached `completed`. It does not mean the data is correct. Correctness is the field accuracy (184/192 = 95.8%).
- **Processing time** comes from one run with 22 files uploaded together and Groq limited to 8000 tokens per minute. Differences between file types must not be read as "this type is slower". The cause was not tested.
- `duration_ms` values of single runs are not averages of many runs.
- Three labels in `labels.json` have an empty `issues` list. The runner uses a fixed list of required rules for them (`MORE_REQUIRED_RULES`).
- `REPORT.md` says "Unexpected outcomes: None", while the validation section shows one false alarm (`img-very-poor.jpg`). The runner does not list needs-review mismatches in that section.
- The very poor image (rotated 4°, blur, low JPEG quality) gave no readable text. The system left all fields empty and flagged the document for review. The label said it should not need review, so it counts as a false alarm.

## Semantic search

- Measured on 21 synthetic invoices and 19 queries written by the developer (not blind). Names and numbers are found better by keyword search; semantic search is for ideas. There is no similarity cutoff, because correct and wrong files had overlapping scores.
- Only invoices are indexed. The text sent to Gemini per invoice is the file name, invoice fields, line item names and the start of the document text, cut to 5000 characters. **Do not send real business data** to the free tier without reading Google's terms.
- Vectors are created on demand during a search: at most 20 new or changed invoices per search, the rest on the next search. The response reports `not_indexed`.
- Search compares the question with all vectors in memory, so it grows linearly with the number of invoices.
- `GEMINI_EMBEDDING_MODEL` must be the bare name (for example `gemini-embedding-001`).
- The free-tier limits were not checked.

## API and security notes

- Timestamps are UTC (Bangladesh is UTC+6).
- Rate-limit answers (429) are `text/html` with a `Retry-After` header, not JSON.
- `to=2026-13-45` in the list filter is accepted (200), while `from=not-a-date` gives 400. This is not a security issue.
- `npm audit` shows 2 moderate warnings from `exceljs` 4.4.0 (the `uuid` package inside it). The package only reads files. `npm audit fix --force` must not be used, because it would install `exceljs` 3.4.0.
- The rate limiter is in memory (one process). HTTPS is expected to come from a reverse proxy.
- The security check is one run on localhost and uses text-pattern checks on the code. It did not scan the git history. See `evaluation/SECURITY_REPORT.md` for the full list of gaps.

Items here are known and not hidden; the evaluation reports contain the measured numbers.