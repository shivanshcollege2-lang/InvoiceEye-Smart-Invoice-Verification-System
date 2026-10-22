import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { getDatabaseMode, getPool, initMySQL, seedDemoData } from '../server/db/mysql.js';
import { requireAuth, signToken } from '../server/middleware/auth.js';
import { initSQLite } from '../server/db/sqlite.js';
import { validateDocumentBuffer } from '../server/services/fileValidation.js';
import { parseInvoiceText } from '../server/services/parser.js';
import { verifyInvoice } from '../server/services/verifier.js';

const originalMode = process.env.DB_MODE;
delete process.env.DB_MODE;
assert.equal(getDatabaseMode(), 'sqlite');
process.env.DB_MODE = 'mysql';
assert.equal(getDatabaseMode(), 'mysql');
process.env.DB_MODE = 'invalid';
assert.throws(() => getDatabaseMode(), /DB_MODE must be either/);
if (originalMode === undefined) delete process.env.DB_MODE;
else process.env.DB_MODE = originalMode;

const clean = `Invoice Number: INV-TEST-001\nVendor: Apex Office Supplies\nPO Number: PO-1001\nInvoice Date: 2026-09-15\nQuantity: 100\nUnit Price: 500\nSubtotal: 50000\nTax: 9000\nTotal: 59000`;
const parsed = parseInvoiceText(clean);
assert.equal(parsed.invoiceNumber,'INV-TEST-001');
assert.equal(parsed.vendor,'Apex Office Supplies');
assert.equal(parsed.poNumber,'PO-1001');
assert.equal(parsed.quantity,100);
assert.equal(parsed.unitPrice,500);
assert.equal(parsed.subtotal,50000);
assert.equal(parsed.total,59000);

const po={po_id:'PO-1001',vendor_id:'V001',currency:'INR',items:[{quantity:100,unit_price:500}]};
parsed.vendorId='V001';
let result=verifyInvoice(parsed,po,false,{score:0});
assert.equal(result.status,'ACCEPTED');
assert.equal(result.duplicate,false);

const qty=verifyInvoice({...parsed,quantity:120,subtotal:60000,total:69000},po,false,{score:0});
assert.equal(qty.status,'NEEDS REVIEW');

const price=verifyInvoice({...parsed,unitPrice:750,subtotal:75000,total:84000},po,false,{score:0});
assert.equal(price.status,'REJECTED');

const dup=verifyInvoice(parsed,po,true,{score:0});
assert.equal(dup.status,'REJECTED');

const total=verifyInvoice({...parsed,total:58000},po,false,{score:0});
assert.equal(total.status,'NEEDS REVIEW');

const unknownVendor=verifyInvoice({...parsed,vendorId:null},po,false,{score:0});
assert.equal(unknownVendor.status,'NEEDS REVIEW');
assert.equal(unknownVendor.checks.find(x=>x.name==='vendor').passed,false);
assert.equal(unknownVendor.checks.find(x=>x.name==='vendor_po_match').passed,false);

const wrongVendor=verifyInvoice({...parsed,vendorId:'V002'},po,false,{score:0});
assert.equal(wrongVendor.status,'NEEDS REVIEW');
assert.equal(wrongVendor.checks.find(x=>x.name==='vendor_po_match').passed,false);

const wrongCurrency=verifyInvoice({...parsed,currency:'USD'},po,false,{score:0});
assert.equal(wrongCurrency.status,'NEEDS REVIEW');
assert.equal(wrongCurrency.checks.find(x=>x.name==='currency_match').passed,false);

const multiLine=verifyInvoice({
  ...parsed,
  quantity:30,
  unitPrice:null,
  subtotal:2000,
  tax:360,
  total:2360,
  lineItems:[
    {description:'Pens',quantity:10,unitPrice:100},
    {description:'Paper',quantity:20,unitPrice:50}
  ]
}, {
  vendor_id:'V001',
  currency:'INR',
  items:[
    {description:'Pens',quantity:10,unit_price:100},
    {description:'Paper',quantity:20,unit_price:50}
  ]
},false,{score:0});
assert.equal(multiLine.status,'ACCEPTED');
assert.equal(multiLine.checks.find(x=>x.name==='po_value_match').passed,true);

const decimalInvoice = {
  invoiceNumber: 'INV-DECIMAL-001',
  vendorId: 'V001',
  vendor: 'Apex Office Supplies',
  poNumber: 'PO-DECIMAL',
  quantity: 0.1,
  unitPrice: 0.1,
  subtotal: 0.01,
  tax: 0.01,
  total: 0.02,
  currency: 'INR'
};
const decimalResult = verifyInvoice(decimalInvoice, {
  vendor_id: 'V001',
  currency: 'INR',
  items: [{ quantity: 0.1, unit_price: 0.1 }]
}, false, { score: 0 });
assert.equal(decimalResult.checks.find(x=>x.name==='subtotal_consistency').passed,true);
assert.equal(decimalResult.checks.find(x=>x.name==='total_consistency').passed,true);
assert.equal(decimalResult.status,'ACCEPTED');

validateDocumentBuffer('synthetic.pdf', Buffer.from('%PDF-1.7 synthetic fixture'));
validateDocumentBuffer('invoice.png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
validateDocumentBuffer('invoice.jpg', Buffer.from([0xff,0xd8,0xff,0x00]));
assert.throws(
  () => validateDocumentBuffer('spoofed.pdf', Buffer.from('not a PDF')),
  /contents do not match/
);
assert.throws(
  () => validateDocumentBuffer('empty.txt', Buffer.alloc(0)),
  /empty or contains binary/
);

const originalEnv = Object.fromEntries(
  ['DB_MODE', 'SQLITE_PATH', 'OWNER_EMAIL', 'OWNER_PASSWORD', 'OWNER_NAME']
    .map(key => [key, process.env[key]])
);
const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'invoiceeye-smoke-'));
let openPool;
try {
  process.env.DB_MODE = 'sqlite';
  process.env.SQLITE_PATH = path.join(testDirectory, 'invoiceeye.sqlite');
  process.env.OWNER_EMAIL = 'owner@example.test';
  process.env.OWNER_NAME = 'Smoke Test Owner';

  delete process.env.OWNER_PASSWORD;
  openPool = await initMySQL();
  const [uninitializedUsers] = await getPool().query('SELECT COUNT(*) count FROM users');
  assert.equal(uninitializedUsers[0].count, 0, 'Startup without an owner password should leave the account uninitialized');
  await openPool.end();
  openPool = null;

  process.env.OWNER_PASSWORD = 'test-password-only';
  openPool = await initSQLite();
  const [initialVendors] = await openPool.query('SELECT COUNT(*) count FROM vendors');
  const [initialInvoices] = await openPool.query('SELECT COUNT(*) count FROM invoices');
  assert.equal(initialVendors[0].count, 0, 'Startup should not insert synthetic vendors');
  assert.equal(initialInvoices[0].count, 0, 'Startup should not insert synthetic invoices');
  await openPool.query(
    'INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)',
    ['Old Demo User', 'reviewer@invoiceeye.local', 'inactive-test-hash', 'reviewer']
  );
  await openPool.end();
  openPool = null;

  openPool = await initMySQL();
  const [users] = await getPool().query('SELECT user_id,email,role,is_active,password_hash FROM users');
  const owner = users.find(user => user.email === 'owner@example.test');
  const disabledDemo = users.find(user => user.email === 'reviewer@invoiceeye.local');
  assert.ok(owner);
  assert.equal(owner.role, 'admin');
  assert.equal(owner.is_active, 1);
  assert.ok(await bcrypt.compare('test-password-only', owner.password_hash));
  assert.equal(disabledDemo.is_active, 0);
  assert.equal(users.filter(user => user.is_active).length, 1);

  const inactiveResponse = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalled = false;
  await requireAuth({
    headers: { authorization: `Bearer ${signToken({ user_id: disabledDemo.user_id, email: disabledDemo.email, role: disabledDemo.role, name: 'Old Demo User' })}` }
  }, inactiveResponse, () => { nextCalled = true; });
  assert.equal(inactiveResponse.statusCode, 401);
  assert.equal(inactiveResponse.body.message, 'Account is inactive');
  assert.equal(nextCalled, false);

  await seedDemoData();
  await seedDemoData();
  const [demoInvoices] = await getPool().query(
    'SELECT invoice_id,status,is_demo FROM invoices WHERE is_demo=1 ORDER BY invoice_id'
  );
  assert.equal(demoInvoices.length, 4);
  assert.deepEqual(demoInvoices.map(invoice => invoice.status), [
    'ACCEPTED',
    'NEEDS REVIEW',
    'REJECTED',
    'REJECTED'
  ]);
  const [demoVendors] = await getPool().query('SELECT COUNT(*) count FROM vendors');
  assert.equal(demoVendors[0].count, 3);
} finally {
  if (openPool) await openPool.end();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(testDirectory, { recursive: true, force: true });
}

console.log('InvoiceEye smoke tests: PASS');
console.log(JSON.stringify({clean:result.status,quantity:qty.status,price:price.status,duplicate:dup.status,totalMismatch:total.status,unknownVendor:unknownVendor.status,wrongVendor:wrongVendor.status,wrongCurrency:wrongCurrency.status,multiLine:multiLine.status},null,2));
console.log('SQLite account bootstrap and demo-account deactivation: PASS');
console.log('Explicit idempotent demo seed and real verification outcomes: PASS');
