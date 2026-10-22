CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'finance' CHECK(role IN ('finance','reviewer','admin')),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendors (
  vendor_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  category TEXT,
  tax_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id TEXT PRIMARY KEY,
  vendor_id TEXT NOT NULL REFERENCES vendors(vendor_id),
  po_date TEXT,
  status TEXT NOT NULL DEFAULT 'APPROVED' CHECK(status IN ('DRAFT','APPROVED','CLOSED','CANCELLED')),
  currency TEXT NOT NULL DEFAULT 'INR',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_po_vendor ON purchase_orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_po_date ON purchase_orders(po_date);

CREATE TABLE IF NOT EXISTS po_items (
  po_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id TEXT NOT NULL REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
  sku TEXT,
  description TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poi_po ON po_items(po_id);

CREATE TABLE IF NOT EXISTS invoices (
  invoice_id TEXT PRIMARY KEY,
  invoice_number TEXT NOT NULL,
  vendor_id TEXT REFERENCES vendors(vendor_id),
  po_id TEXT REFERENCES purchase_orders(po_id),
  invoice_date TEXT,
  currency TEXT NOT NULL DEFAULT 'INR',
  subtotal NUMERIC,
  tax NUMERIC DEFAULT 0,
  total NUMERIC,
  status TEXT NOT NULL DEFAULT 'PROCESSING' CHECK(status IN ('PROCESSING','ACCEPTED','NEEDS REVIEW','REJECTED')),
  risk_score INTEGER NOT NULL DEFAULT 0,
  duplicate_flag INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL DEFAULT 'TEXT' CHECK(source_type IN ('TEXT','PDF','IMAGE')),
  source_file TEXT,
  raw_text TEXT,
  extracted_json TEXT,
  created_by INTEGER REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invoice_number ON invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoice_vendor ON invoices(vendor_id);
CREATE INDEX IF NOT EXISTS idx_invoice_po ON invoices(po_id);
CREATE INDEX IF NOT EXISTS idx_invoice_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoice_date ON invoices(invoice_date);

CREATE TABLE IF NOT EXISTS invoice_items (
  invoice_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  sku TEXT,
  description TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invi_invoice ON invoice_items(invoice_id);

CREATE TABLE IF NOT EXISTS verification_results (
  result_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  risk_score INTEGER NOT NULL DEFAULT 0,
  decision_reason TEXT,
  checks_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_verification_invoice ON verification_results(invoice_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT REFERENCES invoices(invoice_id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  status TEXT,
  details TEXT,
  ip_address TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_invoice ON audit_logs(invoice_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS review_actions (
  review_id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id TEXT NOT NULL REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  reviewer_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('APPROVE','REJECT','REQUEST_REVIEW')),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_review_invoice ON review_actions(invoice_id);
CREATE INDEX IF NOT EXISTS idx_review_reviewer ON review_actions(reviewer_id);
