-- ১) আপলোড করা প্রতিটা ফাইলের metadata
CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  original_name TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  mime_type     TEXT,
  detected_type TEXT,
  size_bytes    INTEGER,
  sha256        TEXT,
  page_count    INTEGER,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','processing','completed','failed')),
  needs_review  INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
CREATE INDEX IF NOT EXISTS idx_documents_sha256 ON documents(sha256);
CREATE INDEX IF NOT EXISTS idx_documents_review ON documents(needs_review);

-- ২) বের করা text: PDF এর প্রতি পৃষ্ঠা বা Excel এর প্রতি sheet এক সারি
CREATE TABLE IF NOT EXISTS document_pages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number    INTEGER,
  sheet_name     TEXT,
  text           TEXT,
  ocr_used       INTEGER NOT NULL DEFAULT 0,
  ocr_confidence REAL
);
CREATE INDEX IF NOT EXISTS idx_pages_document ON document_pages(document_id);

-- ৩) background job queue (n8n এর execution queue এর মতো)
CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'process',
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','processing','done','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error   TEXT,
  locked_at    TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- ৪) AI এর বের করা invoice (এখন ১ document = ১ invoice, পরে অনেকটাও হতে পারে)
CREATE TABLE IF NOT EXISTS invoices (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id           INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  segment_index         INTEGER NOT NULL DEFAULT 0,
  page_start            INTEGER,
  page_end              INTEGER,
  invoice_number        TEXT,
  invoice_date          TEXT,
  supplier_name         TEXT,
  customer_name         TEXT,
  subtotal              REAL,
  tax                   REAL,
  total                 REAL,
  currency              TEXT,
  confidence_json       TEXT,
  uncertain_fields_json TEXT,
  raw_llm_json          TEXT,
  model                 TEXT,
  prompt_version        TEXT,
  is_corrected          INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (document_id, segment_index)
);
CREATE INDEX IF NOT EXISTS idx_invoices_document ON invoices(document_id);
CREATE INDEX IF NOT EXISTS idx_invoices_dup ON invoices(supplier_name, invoice_number);

CREATE TABLE IF NOT EXISTS invoice_line_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT,
  quantity    REAL,
  unit_price  REAL,
  amount      REAL
);
CREATE INDEX IF NOT EXISTS idx_items_invoice ON invoice_line_items(invoice_id);

-- ৫) validation এ যা যা ধরা পড়ল
CREATE TABLE IF NOT EXISTS validation_issues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  rule       TEXT NOT NULL,
  severity   TEXT NOT NULL CHECK (severity IN ('error','warning')),
  field      TEXT,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_issues_invoice ON validation_issues(invoice_id);

-- ৬) processing এর ইতিহাস ও সময়
CREATE TABLE IF NOT EXISTS processing_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT,
  duration_ms INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_document ON processing_history(document_id);

-- ৭) manual সংশোধনের audit log
CREATE TABLE IF NOT EXISTS corrections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_corrections_invoice ON corrections(invoice_id);

-- ৮) semantic search এর vector (Float32 binary)
CREATE TABLE IF NOT EXISTS embeddings (
  invoice_id INTEGER PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  vector     BLOB NOT NULL,
  text_hash  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);