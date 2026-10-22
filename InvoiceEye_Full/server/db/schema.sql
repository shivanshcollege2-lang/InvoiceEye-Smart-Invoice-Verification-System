CREATE DATABASE IF NOT EXISTS invoiceeye CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE invoiceeye;

CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('finance','reviewer','admin') NOT NULL DEFAULT 'finance',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vendors (
  vendor_id VARCHAR(30) PRIMARY KEY,
  name VARCHAR(180) NOT NULL,
  email VARCHAR(180),
  category VARCHAR(100),
  tax_id VARCHAR(80),
  status ENUM('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  po_id VARCHAR(40) PRIMARY KEY,
  vendor_id VARCHAR(30) NOT NULL,
  po_date DATE,
  status ENUM('DRAFT','APPROVED','CLOSED','CANCELLED') NOT NULL DEFAULT 'APPROVED',
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  notes VARCHAR(500),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id),
  INDEX idx_po_vendor (vendor_id),
  INDEX idx_po_date (po_date)
);

CREATE TABLE IF NOT EXISTS po_items (
  po_item_id INT AUTO_INCREMENT PRIMARY KEY,
  po_id VARCHAR(40) NOT NULL,
  sku VARCHAR(80),
  description VARCHAR(255) NOT NULL,
  quantity DECIMAL(14,2) NOT NULL,
  unit_price DECIMAL(14,2) NOT NULL,
  FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id) ON DELETE CASCADE,
  INDEX idx_poi_po (po_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  invoice_id VARCHAR(40) PRIMARY KEY,
  invoice_number VARCHAR(120) NOT NULL,
  vendor_id VARCHAR(30),
  po_id VARCHAR(40),
  invoice_date DATE,
  currency VARCHAR(10) NOT NULL DEFAULT 'INR',
  subtotal DECIMAL(14,2),
  tax DECIMAL(14,2) DEFAULT 0,
  total DECIMAL(14,2),
  status ENUM('PROCESSING','ACCEPTED','NEEDS REVIEW','REJECTED') NOT NULL DEFAULT 'PROCESSING',
  risk_score INT NOT NULL DEFAULT 0,
  duplicate_flag BOOLEAN NOT NULL DEFAULT FALSE,
  is_demo BOOLEAN NOT NULL DEFAULT FALSE,
  source_type ENUM('TEXT','PDF','IMAGE') NOT NULL DEFAULT 'TEXT',
  source_file VARCHAR(255),
  raw_text LONGTEXT,
  extracted_json JSON,
  created_by INT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (vendor_id) REFERENCES vendors(vendor_id),
  FOREIGN KEY (po_id) REFERENCES purchase_orders(po_id),
  FOREIGN KEY (created_by) REFERENCES users(user_id),
  INDEX idx_invoice_number (invoice_number),
  INDEX idx_invoice_vendor (vendor_id),
  INDEX idx_invoice_po (po_id),
  INDEX idx_invoice_status (status),
  INDEX idx_invoice_date (invoice_date)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  invoice_item_id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40) NOT NULL,
  sku VARCHAR(80),
  description VARCHAR(255) NOT NULL,
  quantity DECIMAL(14,2) NOT NULL,
  unit_price DECIMAL(14,2) NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  INDEX idx_invi_invoice (invoice_id)
);

CREATE TABLE IF NOT EXISTS verification_results (
  result_id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40) NOT NULL,
  status VARCHAR(30) NOT NULL,
  risk_score INT NOT NULL DEFAULT 0,
  decision_reason TEXT,
  checks_json JSON,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  INDEX idx_verification_invoice (invoice_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40),
  user_id INT,
  action VARCHAR(120) NOT NULL,
  status VARCHAR(40),
  details TEXT,
  ip_address VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  INDEX idx_audit_invoice (invoice_id),
  INDEX idx_audit_created (created_at)
);

CREATE TABLE IF NOT EXISTS review_actions (
  review_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  invoice_id VARCHAR(40) NOT NULL,
  reviewer_id INT NOT NULL,
  action ENUM('APPROVE','REJECT','REQUEST_REVIEW') NOT NULL,
  comment VARCHAR(1000),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES invoices(invoice_id) ON DELETE CASCADE,
  FOREIGN KEY (reviewer_id) REFERENCES users(user_id) ON DELETE RESTRICT,
  INDEX idx_review_invoice (invoice_id),
  INDEX idx_review_reviewer (reviewer_id)
);
