import mysql from 'mysql2/promise';
import fs from 'fs/promises';
import bcrypt from 'bcryptjs';
import { parseInvoiceText } from '../services/parser.js';
import { verifyInvoice } from '../services/verifier.js';

const cfg = {
  host: process.env.MYSQL_HOST || '127.0.0.1',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'invoiceeye',
  password: process.env.MYSQL_PASSWORD || 'invoiceeye',
  database: process.env.MYSQL_DATABASE || 'invoiceeye'
};

let pool;

export function getDatabaseMode() {
  const mode = (process.env.DB_MODE || 'sqlite').trim().toLowerCase();
  if (mode !== 'sqlite' && mode !== 'mysql') {
    throw new Error('DB_MODE must be either "sqlite" or "mysql"');
  }
  return mode;
}

export async function initMySQL() {
  if (getDatabaseMode() === 'sqlite') {
    const { initSQLite } = await import('./sqlite.js');
    pool = await initSQLite();
    await seedUsersAndSamples();
    return pool;
  }

  pool = mysql.createPool({ ...cfg, waitForConnections: true, connectionLimit: 10, decimalNumbers: true, multipleStatements: true });

  const schema = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(schema);
  const [columns] = await pool.query(`SELECT COUNT(*) count FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='invoices' AND COLUMN_NAME='is_demo'`);
  if (!Number(columns[0].count)) {
    await pool.query('ALTER TABLE invoices ADD COLUMN is_demo BOOLEAN NOT NULL DEFAULT FALSE');
  }
  await pool.query(`UPDATE invoices SET is_demo=TRUE
    WHERE invoice_id IN ('INV-9001','INV-9002','INV-9003') AND raw_text='sample seed'`);
  await seedUsersAndSamples();
  return pool;
}

async function seedUsersAndSamples() {
  const email = (process.env.OWNER_EMAIL || 'shivanshcollege2@gmail.com').trim().toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (!password) return;
  const [ownerRows] = await pool.query('SELECT user_id FROM users WHERE LOWER(email)=LOWER(?) LIMIT 1', [email]);
  let ownerId = ownerRows[0]?.user_id;
  const passwordHash = await bcrypt.hash(password, 10);

  if (!ownerId) {
    const name = process.env.OWNER_NAME?.trim() || email;
    const [result] = await pool.query(
      "INSERT INTO users(name,email,password_hash,role,is_active) VALUES (?,?,?,'admin',1)",
      [name, email, passwordHash]
    );
    ownerId = result.insertId;
  } else {
    await pool.query(
      "UPDATE users SET password_hash=?,role='admin',is_active=1 WHERE user_id=?",
      [passwordHash, ownerId]
    );
  }

  await pool.query('UPDATE users SET is_active=0 WHERE LOWER(email)<>LOWER(?)', [email]);
  await pool.query("UPDATE users SET role='admin',is_active=1 WHERE user_id=?", [ownerId]);

}

export async function seedDemoData() {
  const conn = await getPool().getConnection();
  try {
    const [ownerRows] = await conn.query(
      'SELECT user_id FROM users WHERE LOWER(email)=LOWER(?) AND is_active=1 LIMIT 1',
      [(process.env.OWNER_EMAIL || 'shivanshcollege2@gmail.com').trim()]
    );
    if (!ownerRows.length) throw new Error('An active owner account is required before seeding demo data.');

    await conn.beginTransaction();
    const vendors = [
      ['V001', 'Apex Office Supplies', 'billing@apex.example', 'Office Supplies', '27ABCDE1234F1Z5'],
      ['V002', 'Nova Components Ltd.', 'accounts@nova.example', 'Electronics', '27NOVA1234F1Z2'],
      ['V003', 'Prime Facility Services', 'finance@prime.example', 'Services', '27PRIME1234F1Z9']
    ];
    for (const vendor of vendors) {
      const [existing] = await conn.query('SELECT vendor_id FROM vendors WHERE vendor_id=?', [vendor[0]]);
      if (!existing.length) {
        await conn.query('INSERT INTO vendors(vendor_id,name,email,category,tax_id) VALUES (?,?,?,?,?)', vendor);
      }
    }

    const purchaseOrders = [
      ['PO-1001', 'V001', '2026-09-01', 'Office supplies procurement', 'PEN-01', 'Premium Ball Pens', 100, 500],
      ['PO-1002', 'V002', '2026-09-02', 'Cable procurement', 'CAB-07', 'USB-C Cables', 50, 850],
      ['PO-1003', 'V003', '2026-09-03', 'Monthly facility maintenance', 'SERV-09', 'Facility Maintenance', 10, 2000]
    ];
    for (const [poId, vendorId, date, notes, sku, description, quantity, unitPrice] of purchaseOrders) {
      const [existing] = await conn.query('SELECT po_id FROM purchase_orders WHERE po_id=?', [poId]);
      if (!existing.length) {
        await conn.query(`INSERT INTO purchase_orders(po_id,vendor_id,po_date,status,currency,notes)
          VALUES (?,?,?,'APPROVED','INR',?)`, [poId, vendorId, date, notes]);
        await conn.query(`INSERT INTO po_items(po_id,sku,description,quantity,unit_price)
          VALUES (?,?,?,?,?)`, [poId, sku, description, quantity, unitPrice]);
      }
    }

    const scenarios = [
      { id: 'DEMO-INV-001', number: 'INV-DEMO-001', vendor: 'Apex Office Supplies', po: 'PO-1001', quantity: 100, price: 500, subtotal: 50000, tax: 9000, total: 59000 },
      { id: 'DEMO-INV-002', number: 'INV-DEMO-002', vendor: 'Nova Components Ltd.', po: 'PO-1002', quantity: 65, price: 850, subtotal: 55250, tax: 9945, total: 65195 },
      { id: 'DEMO-INV-003', number: 'INV-DEMO-003', vendor: 'Prime Facility Services', po: 'PO-1003', quantity: 10, price: 2200, subtotal: 22000, tax: 3960, total: 25960 },
      { id: 'DEMO-INV-004', number: 'INV-DEMO-001', vendor: 'Apex Office Supplies', po: 'PO-1001', quantity: 100, price: 500, subtotal: 50000, tax: 9000, total: 59000 }
    ];

    for (const scenario of scenarios) {
      const [existing] = await conn.query('SELECT invoice_id FROM invoices WHERE invoice_id=?', [scenario.id]);
      if (existing.length) continue;
      const rawText = `Invoice Number: ${scenario.number}
Vendor: ${scenario.vendor}
PO Number: ${scenario.po}
Invoice Date: 2026-09-15
Quantity: ${scenario.quantity}
Unit Price: ${scenario.price}
Subtotal: ${scenario.subtotal}
Tax: ${scenario.tax}
Total: ${scenario.total}`;
      const parsed = parseInvoiceText(rawText);
      const [vendorRows] = await conn.query('SELECT vendor_id FROM vendors WHERE name=?', [parsed.vendor]);
      const [poRows] = await conn.query('SELECT * FROM purchase_orders WHERE po_id=?', [parsed.poNumber]);
      const [poItems] = await conn.query('SELECT * FROM po_items WHERE po_id=? ORDER BY po_item_id', [parsed.poNumber]);
      const po = poRows[0] ? { ...poRows[0], items: poItems } : null;
      parsed.vendorId = vendorRows[0]?.vendor_id || null;
      const [duplicates] = await conn.query(`SELECT invoice_id FROM invoices WHERE vendor_id=?
        AND LOWER(TRIM(invoice_number))=LOWER(TRIM(?)) AND status<>'REJECTED' LIMIT 1`,
      [parsed.vendorId, parsed.invoiceNumber]);
      const result = verifyInvoice(parsed, po, duplicates.length > 0, { score: 0 });

      await conn.query(`INSERT INTO invoices(invoice_id,invoice_number,vendor_id,po_id,invoice_date,currency,
        subtotal,tax,total,status,risk_score,duplicate_flag,is_demo,source_type,raw_text,extracted_json,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,TRUE,'TEXT',?,?,?)`, [
        scenario.id, parsed.invoiceNumber, parsed.vendorId, parsed.poNumber, parsed.invoiceDate,
        parsed.currency, parsed.subtotal, parsed.tax, parsed.total, result.status, result.riskScore,
        result.duplicate, rawText, JSON.stringify({ ...parsed, extractionMethod: 'TEXT', isDemo: true }), ownerRows[0].user_id
      ]);
      for (const item of (parsed.lineItems.length ? parsed.lineItems : [{
        description: 'Demo invoice line', quantity: parsed.quantity, unitPrice: parsed.unitPrice
      }])) {
        await conn.query(`INSERT INTO invoice_items(invoice_id,sku,description,quantity,unit_price)
          VALUES (?,?,?,?,?)`, [scenario.id, item.sku || null, item.description, item.quantity, item.unitPrice]);
      }
      await conn.query(`INSERT INTO verification_results(invoice_id,status,risk_score,decision_reason,checks_json)
        VALUES (?,?,?,?,?)`, [scenario.id, result.status, result.riskScore, result.reasons.join(' | '), JSON.stringify(result.checks)]);
      await conn.query(`INSERT INTO audit_logs(invoice_id,user_id,action,status,details)
        VALUES (?,?,?,?,?)`, [scenario.id, ownerRows[0].user_id, 'DEMO_INVOICE_SEEDED', result.status, result.reasons.join(' | ')]);
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export function getPool() {
  if (!pool) throw new Error('MySQL pool has not been initialized');
  return pool;
}
