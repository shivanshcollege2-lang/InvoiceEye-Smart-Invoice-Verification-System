import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { getDatabaseMode, getPool, initMySQL } from './db/index.js';
import { requireAuth, requireRoles, signToken } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/error.js';
import { parseInvoiceText } from './services/parser.js';
import { verifyInvoice } from './services/verifier.js';
import { anomalySignal } from './services/anomaly.js';
import { extractDocument } from './services/documentExtractor.js';
import { validateDocumentBuffer } from './services/fileValidation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 5050);
const uploadDir = path.resolve(projectRoot, process.env.UPLOAD_DIR || 'server/uploads');
const allowedUploadExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.txt']);
const maxUploadBytes = 8 * 1024 * 1024;
const corsOrigins = new Set((process.env.CORS_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',').map(origin => origin.trim()).filter(Boolean));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1, fields: 1, parts: 2 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!allowedUploadExtensions.has(extension)) {
      return callback(Object.assign(new Error('Unsupported invoice file type'), { status: 415 }));
    }
    callback(null, true);
  }
});

const apiCors = cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.has(origin)) return callback(null, true);
    callback(Object.assign(new Error('Origin is not allowed by CORS'), { status: 403 }));
  }
});
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin === `${req.protocol}://${req.get('host')}`) return next();
  apiCors(req, res, next);
});
app.use(express.json({ limit: '2mb' }));

function pool() { return getPool(); }
function audit(req, invoiceId, action, status, details='') {
  return pool().query('INSERT INTO audit_logs(invoice_id,user_id,action,status,details,ip_address) VALUES (?,?,?,?,?,?)', [invoiceId || null, req.user?.id || null, action, status || null, details, req.ip]);
}
function invoiceId() { return `INV-${Date.now()}-${Math.floor(Math.random()*1000)}`; }
function sourceType(originalName, mime) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return 'PDF';
  if (mime?.startsWith('image/') || ['.png','.jpg','.jpeg','.webp','.tif','.tiff'].includes(ext)) return 'IMAGE';
  return 'TEXT';
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool().query('SELECT 1');
    const ownerEmail = (process.env.OWNER_EMAIL || 'shivanshcollege2@gmail.com').trim().toLowerCase();
    const [owners] = await pool().query(
      'SELECT user_id FROM users WHERE LOWER(email)=LOWER(?) AND is_active=1 LIMIT 1',
      [ownerEmail]
    );
    res.json({
      status:'ok',
      service:'InvoiceEye API',
      database:getDatabaseMode(),
      ownerConfigured: owners.length > 0
    });
  }
  catch (e) { console.error('InvoiceEye database health check failed', e); res.status(503).json({ status:'degraded', message:'Database unavailable' }); }
});

app.post('/api/auth/login', async (req,res,next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message:'Email and password are required' });
    const [rows] = await pool().query('SELECT * FROM users WHERE email=? AND is_active=1 LIMIT 1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ message:'Invalid credentials' });
    const token = signToken(user);
    res.json({ token, user:{ id:user.user_id, name:user.name, email:user.email, role:user.role } });
  } catch (e) { next(e); }
});

app.get('/api/me', requireAuth, async (req,res) => res.json({ user:req.user }));

app.get('/api/summary', requireAuth, async (_req,res,next) => {
  try {
    const db = pool();
    const [[counts]] = await db.query(`SELECT COUNT(*) total,
      COALESCE(SUM(status='ACCEPTED'),0) accepted,
      COALESCE(SUM(status='NEEDS REVIEW'),0) review,
      COALESCE(SUM(status='REJECTED'),0) rejected,
      COALESCE(ROUND(AVG(risk_score)),0) avgRisk
      FROM invoices`);
    const [valueByCurrency] = await db.query(`SELECT currency,COALESCE(SUM(total),0) value
      FROM invoices WHERE total IS NOT NULL GROUP BY currency ORDER BY currency`);
    const [trend] = await db.query(`SELECT DATE_FORMAT(invoice_date,'%Y-%m') month,currency,
      COALESCE(SUM(total),0) value,COUNT(*) count FROM invoices
      WHERE invoice_date IS NOT NULL GROUP BY month,currency ORDER BY month DESC LIMIT 80`);
    res.json({ ...counts, valueByCurrency, trend:trend.reverse() });
  } catch(e) { next(e); }
});

app.get('/api/invoices', requireAuth, async (req,res,next) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const requestedLimit = Number(req.query.limit || 100);
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 100;
    const requestedPage = Number(req.query.page || 1);
    const page = Number.isInteger(requestedPage) ? Math.min(10000, Math.max(1, requestedPage)) : 1;
    const offset = (page - 1) * limit;
    const where = [];
    const params = [];
    if (status) { where.push('i.status=?'); params.push(status); }
    if (q) { where.push('(i.invoice_number LIKE ? OR v.name LIKE ? OR i.po_id LIKE ?)'); const x=`%${q}%`; params.push(x,x,x); }
    const sql = `SELECT i.invoice_id id, i.invoice_number invoiceNumber, i.invoice_date invoiceDate,
      i.po_id poId, i.vendor_id vendorId, v.name vendorName, i.total, i.subtotal, i.tax,
      i.currency, i.status, i.risk_score riskScore, i.duplicate_flag duplicate, i.is_demo isDemo, i.source_type sourceType,
      i.created_at createdAt
      FROM invoices i LEFT JOIN vendors v ON v.vendor_id=i.vendor_id
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      ORDER BY i.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const [rows] = await pool().query(sql, params);
    res.json(rows);
  } catch(e) { next(e); }
});

app.get('/api/invoices/:id', requireAuth, async (req,res,next) => {
  try {
    const db = pool();
    const [invRows] = await db.query(`SELECT i.invoice_id,i.invoice_number,i.vendor_id,i.po_id,i.invoice_date,
      i.currency,i.subtotal,i.tax,i.total,i.status,i.risk_score,i.duplicate_flag,i.is_demo,i.source_type,
      (i.source_file IS NOT NULL) has_document,i.extracted_json,i.created_by,i.created_at,i.updated_at,
      v.name vendorName,v.email vendorEmail,v.tax_id vendorTaxId,
      p.po_date poDate,p.status poStatus,p.currency poCurrency
      FROM invoices i LEFT JOIN vendors v ON v.vendor_id=i.vendor_id LEFT JOIN purchase_orders p ON p.po_id=i.po_id
      WHERE i.invoice_id=?`, [req.params.id]);
    if (!invRows.length) return res.status(404).json({ message:'Invoice not found' });
    const invoice = invRows[0];
    const [items] = await db.query('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY invoice_item_id', [req.params.id]);
    const [verifications] = await db.query('SELECT * FROM verification_results WHERE invoice_id=? ORDER BY created_at DESC LIMIT 1', [req.params.id]);
    const [reviews] = await db.query(`SELECT r.*, u.name reviewerName FROM review_actions r JOIN users u ON u.user_id=r.reviewer_id WHERE r.invoice_id=? ORDER BY r.created_at DESC`, [req.params.id]);
    res.json({ invoice, items, verification:verifications[0] || null, reviews });
  } catch(e) { next(e); }
});

app.get('/api/invoices/:id/document', requireAuth, async (req,res,next) => {
  try {
    const [rows] = await pool().query('SELECT source_file,source_type FROM invoices WHERE invoice_id=?', [req.params.id]);
    if (!rows.length || !rows[0].source_file) return res.status(404).json({ message:'Invoice document not found' });
    const storedName = path.basename(rows[0].source_file);
    if (!storedName) return res.status(404).json({ message:'Invoice document not found' });
    const filePath = path.resolve(uploadDir, storedName);
    if (!filePath.startsWith(`${uploadDir}${path.sep}`)) return res.status(404).json({ message:'Invoice document not found' });
    await fs.access(filePath);
    return res.download(filePath, `${req.params.id}${path.extname(storedName)}`, error => {
      if (error && !res.headersSent) next(error);
    });
  } catch(e) {
    if (e.code === 'ENOENT') return res.status(404).json({ message:'Invoice document not found' });
    next(e);
  }
});

app.post('/api/invoices/verify', requireAuth, upload.single('file'), async (req,res,next) => {
  const db = pool();
  let savedFile = null;
  try {
    let rawText = String(req.body?.text || '');
    let pagesProcessed = 1;
    let originalName = 'pasted-invoice.txt';
    let mime = 'text/plain';
    let extractionMethod = 'TEXT';
    if (req.file) {
      originalName = req.file.originalname;
      mime = req.file.mimetype;
      validateDocumentBuffer(originalName, req.file.buffer);
      extractionMethod = sourceType(originalName, mime);
      await fs.mkdir(uploadDir, { recursive:true });
      const safeName = `${randomUUID()}${path.extname(originalName).toLowerCase()}`;
      savedFile = path.join(uploadDir, safeName);
      await fs.writeFile(savedFile, req.file.buffer);
      const extracted = await extractDocument(req.file.buffer, originalName, mime);
      rawText = extracted.text || '';
      extractionMethod = extracted.method;
      pagesProcessed = extracted.pages || 1;
    }
    if (!rawText.trim()) {
      if (savedFile) {
        try { await fs.unlink(savedFile); }
        catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') console.error('Failed to remove unreadable invoice upload', cleanupError);
        }
      }
      return res.status(400).json({ message:'Could not extract readable invoice text. Try a clearer PDF/image or paste the text.' });
    }

    const parsed = parseInvoiceText(rawText);
    const [vendorRows] = await db.query('SELECT * FROM vendors WHERE vendor_id=? OR LOWER(name)=LOWER(?) LIMIT 1', [parsed.vendor, parsed.vendor]);
    const vendor = vendorRows[0] || null;
    parsed.vendorId = vendor?.vendor_id || null;
    const [poRows] = await db.query(`SELECT p.*, v.name vendorName FROM purchase_orders p JOIN vendors v ON v.vendor_id=p.vendor_id
      WHERE p.po_id=? LIMIT 1`, [parsed.poNumber]);
    const poRow = poRows[0] || null;
    let po = null;
    if (poRow) {
      const [items] = await db.query('SELECT * FROM po_items WHERE po_id=? ORDER BY po_item_id', [poRow.po_id]);
      po = { ...poRow, items };
    }

    const [duplicateRows] = await db.query(`SELECT invoice_id FROM invoices
      WHERE vendor_id=? AND LOWER(TRIM(invoice_number))=LOWER(TRIM(?)) AND status <> 'REJECTED' LIMIT 1`, [parsed.vendorId, parsed.invoiceNumber]);
    const [history] = await db.query('SELECT vendor_id,total FROM invoices WHERE vendor_id IS NOT NULL ORDER BY created_at DESC LIMIT 200');
    const riskInvoice = { ...parsed, vendorId:vendor?.vendor_id || null };
    const anomaly = anomalySignal(riskInvoice, history);
    const result = verifyInvoice(parsed, po, duplicateRows.length > 0, anomaly);
    const id = invoiceId();

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`INSERT INTO invoices(invoice_id,invoice_number,vendor_id,po_id,invoice_date,currency,subtotal,tax,total,status,risk_score,duplicate_flag,is_demo,source_type,source_file,raw_text,extracted_json,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,FALSE,?,?,?,?,?)`, [
        id, parsed.invoiceNumber, vendor?.vendor_id || null, po?.po_id || null, parsed.invoiceDate || null, parsed.currency || 'INR',
        parsed.subtotal ?? null, parsed.tax ?? 0, parsed.total ?? null, result.status, result.riskScore, result.duplicate,
        sourceType(originalName,mime), savedFile ? path.basename(savedFile) : null, rawText,
        JSON.stringify({ ...parsed, extractionMethod, pagesProcessed }), req.user.id
      ]);
      for (const item of (parsed.lineItems?.length ? parsed.lineItems : [{ description:'Invoice line', quantity:parsed.quantity || 0, unitPrice:parsed.unitPrice || 0 }])) {
        await conn.query('INSERT INTO invoice_items(invoice_id,sku,description,quantity,unit_price) VALUES (?,?,?,?,?)', [id, item.sku || null, item.description, item.quantity, item.unitPrice]);
      }
      await conn.query('INSERT INTO verification_results(invoice_id,status,risk_score,decision_reason,checks_json) VALUES (?,?,?,?,?)', [id,result.status,result.riskScore,result.reasons.join(' | '),JSON.stringify(result.checks)]);
      await conn.query('INSERT INTO audit_logs(invoice_id,user_id,action,status,details,ip_address) VALUES (?,?,?,?,?,?)', [id,req.user.id,'INVOICE_VERIFIED',result.status,`Source=${extractionMethod}; ${result.reasons.join(' | ')}`,req.ip]);
      await conn.commit();
      savedFile = null;
    } catch(e) { await conn.rollback(); throw e; }
    finally { conn.release(); }

    res.status(201).json({ id, parsed, extractionMethod, pagesProcessed, vendor, po, result });
  } catch(e) {
    if (savedFile) {
      try { await fs.unlink(savedFile); }
      catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.error('Failed to remove invoice upload after processing error', cleanupError);
      }
    }
    next(e);
  }
});

app.get('/api/vendors', requireAuth, async (_req,res,next)=>{
  try { const [rows]=await pool().query('SELECT * FROM vendors ORDER BY name'); res.json(rows); } catch(e){next(e);}
});

app.post('/api/vendors', requireAuth, requireRoles('admin'), async (req,res,next)=>{
  try {
    const {vendorId,name,email,category,taxId} = req.body || {};
    if (!vendorId || !name) return res.status(400).json({message:'vendorId and name are required'});
    await pool().query('INSERT INTO vendors(vendor_id,name,email,category,tax_id) VALUES (?,?,?,?,?)',[vendorId,name,email||null,category||null,taxId||null]);
    await audit(req,null,'VENDOR_CREATED','SUCCESS',vendorId);
    res.status(201).json({message:'Vendor created'});
  } catch(e){next(e);}
});

app.get('/api/purchase-orders', requireAuth, async (_req,res,next)=>{
  try {
    const [rows]=await pool().query(`SELECT p.po_id id,p.vendor_id vendorId,v.name vendorName,p.po_date poDate,p.status,p.currency,p.notes
      FROM purchase_orders p JOIN vendors v ON v.vendor_id=p.vendor_id ORDER BY p.po_date DESC,p.po_id`);
    for (const row of rows) { const [items]=await pool().query('SELECT sku,description,quantity,unit_price unitPrice FROM po_items WHERE po_id=?',[row.id]); row.items=items; }
    res.json(rows);
  } catch(e){next(e);}
});

app.post('/api/purchase-orders', requireAuth, requireRoles('admin','finance'), async (req,res,next)=>{
  const conn = await pool().getConnection();
  try {
    const {poId,vendorId,poDate,status='APPROVED',currency='INR',notes='',items=[]}=req.body||{};
    if(!poId || !vendorId || !Array.isArray(items) || !items.length) return res.status(400).json({message:'poId, vendorId and at least one item are required'});
    await conn.beginTransaction();
    await conn.query('INSERT INTO purchase_orders(po_id,vendor_id,po_date,status,currency,notes) VALUES(?,?,?,?,?,?)',[poId,vendorId,poDate||null,status,currency,notes]);
    for(const item of items){ await conn.query('INSERT INTO po_items(po_id,sku,description,quantity,unit_price) VALUES(?,?,?,?,?)',[poId,item.sku||null,item.description,item.quantity,item.unitPrice]); }
    await conn.commit();
    await audit(req,null,'PURCHASE_ORDER_CREATED','SUCCESS',poId);
    res.status(201).json({message:'Purchase order created',poId});
  } catch(e){await conn.rollback();next(e);} finally{conn.release();}
});

app.get('/api/audit-logs', requireAuth, async (_req,res,next)=>{
  try {
    const [rows]=await pool().query(`SELECT a.audit_id id,a.invoice_id invoiceId,a.action,a.status,a.details,a.created_at createdAt,
      u.name userName FROM audit_logs a LEFT JOIN users u ON u.user_id=a.user_id ORDER BY a.created_at DESC LIMIT 300`);
    res.json(rows);
  } catch(e){next(e);}
});

app.get('/api/reports/invoices.csv', requireAuth, async (req,res,next)=>{
  try {
    const params = [];
    const filters = [];
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (status) { filters.push('i.status=?'); params.push(status); }
    if (q) {
      filters.push('(i.invoice_number LIKE ? OR v.name LIKE ? OR i.po_id LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await pool().query(`SELECT i.invoice_number invoiceNumber,v.name vendorName,
      i.invoice_date invoiceDate,i.po_id poId,i.total,i.currency,i.status,i.risk_score riskScore,i.created_at createdAt
      FROM invoices i LEFT JOIN vendors v ON v.vendor_id=i.vendor_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY i.created_at DESC LIMIT 5000`, params);
    const escapeCell = value => {
      let text = String(value ?? '');
      if (/^[\t\r =+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const columns = ['Invoice', 'Vendor', 'Date', 'Purchase order', 'Amount', 'Currency', 'Status', 'Risk score', 'Submitted'];
    const lines = [columns, ...rows.map(row => [
      row.invoiceNumber, row.vendorName, row.invoiceDate, row.poId, row.total,
      row.currency, row.status, row.riskScore, row.createdAt
    ])].map(row => row.map(escapeCell).join(','));
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="invoiceeye-invoices.csv"',
      'Cache-Control': 'no-store'
    });
    res.send(`\uFEFF${lines.join('\r\n')}`);
  } catch(e) { next(e); }
});

app.post('/api/invoices/:id/review', requireAuth, requireRoles('reviewer','admin'), async (req,res,next)=>{
  const conn = await pool().getConnection();
  try {
    const {action,comment=''}=req.body||{};
    if(!['APPROVE','REJECT','REQUEST_REVIEW'].includes(action)) return res.status(400).json({message:'Invalid review action'});
    if (typeof comment !== 'string' || comment.length > 1000) return res.status(400).json({message:'Review comment must be 1000 characters or fewer'});
    if (action !== 'REQUEST_REVIEW' && !comment.trim()) return res.status(400).json({message:'Add a reason before approving or rejecting an invoice'});
    const map={APPROVE:'ACCEPTED',REJECT:'REJECTED',REQUEST_REVIEW:'NEEDS REVIEW'};
    await conn.beginTransaction();
    const [invRows]=await conn.query('SELECT invoice_id,status FROM invoices WHERE invoice_id=? FOR UPDATE',[req.params.id]);
    if(!invRows.length){await conn.rollback(); return res.status(404).json({message:'Invoice not found'});}
    if (invRows[0].status !== 'NEEDS REVIEW') {
      await conn.rollback();
      return res.status(409).json({message:'Only invoices in NEEDS REVIEW can receive a reviewer decision.'});
    }
    await conn.query('UPDATE invoices SET status=? WHERE invoice_id=?',[map[action],req.params.id]);
    await conn.query('INSERT INTO review_actions(invoice_id,reviewer_id,action,comment) VALUES(?,?,?,?)',[req.params.id,req.user.id,action,comment]);
    await conn.query('INSERT INTO audit_logs(invoice_id,user_id,action,status,details,ip_address) VALUES(?,?,?,?,?,?)',[req.params.id,req.user.id,'REVIEW_DECISION',map[action],comment,req.ip]);
    await conn.commit();
    res.json({message:'Review decision recorded',status:map[action]});
  } catch(e){await conn.rollback();next(e);} finally{conn.release();}
});

app.get('/api/users', requireAuth, requireRoles('admin'), async (_req,res,next)=>{
  try { const [rows]=await pool().query('SELECT user_id id,name,email,role,is_active active,created_at createdAt FROM users ORDER BY created_at DESC'); res.json(rows); }
  catch(e){next(e);}
});

app.use(express.static(path.join(projectRoot, 'dist')));
app.get('/{*splat}', async (req,res,next)=>{
  if(req.path === '/api' || req.path.startsWith('/api/')) return next();
  const distIndex = path.join(projectRoot, 'dist/index.html');
  try {
    await fs.access(distIndex);
    return res.sendFile(distIndex);
  } catch (error) {
    if (error.code !== 'ENOENT') return next(error);
    return res.status(503).type('text/plain').send(
      'InvoiceEye frontend is not built. Run `npm run build` from the InvoiceEye_Full folder, then restart the server.'
    );
  }
});
app.use(notFound);
app.use(errorHandler);

await fs.mkdir(uploadDir,{recursive:true});
await initMySQL();
app.listen(PORT,()=>console.log(`InvoiceEye running: http://127.0.0.1:${PORT}`));
