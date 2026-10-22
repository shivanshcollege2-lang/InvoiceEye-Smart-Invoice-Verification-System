import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(projectRoot, 'test-invoices', 'pdfs');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'invoiceeye-integration-'));
const databasePath = path.join(temporaryRoot, 'test.sqlite');
const uploadPath = path.join(temporaryRoot, 'uploads');
const ownerEmail = 'integration-owner@example.test';
const ownerPassword = 'integration-test-password';
const appEnv = {
  ...process.env,
  DB_MODE: 'sqlite',
  OWNER_EMAIL: ownerEmail,
  OWNER_PASSWORD: ownerPassword,
  OWNER_NAME: 'Integration Owner',
  SQLITE_PATH: databasePath,
  UPLOAD_DIR: uploadPath
};

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error('InvoiceEye server exited before its health check passed.');
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('InvoiceEye server did not become healthy within 15 seconds.');
}

async function postFile(baseUrl, token, filePath, mimeType) {
  const content = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([content], { type: mimeType }), path.basename(filePath));
  return fetch(`${baseUrl}/api/invoices/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
}

const postInvoice = (baseUrl, token, fileName) => postFile(
  baseUrl, token, path.join(fixtureRoot, fileName), 'application/pdf'
);

let server;
try {
  const port = await availablePort();
  appEnv.PORT = String(port);
  await execFileAsync(process.execPath, ['scripts/seed-demo.js'], { cwd: projectRoot, env: appEnv });
  server = spawn(process.execPath, ['server/server.js'], { cwd: projectRoot, env: appEnv, stdio: 'ignore' });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(server, baseUrl);

  const appPageResponse = await fetch(baseUrl);
  const appPage = await appPageResponse.text();
  if (appPageResponse.ok) {
    const scriptPath = appPage.match(/<script[^>]+src="([^"]+)"/)?.[1];
    assert.ok(scriptPath, 'Production page should reference its bundled JavaScript');
    const scriptResponse = await fetch(new URL(scriptPath, baseUrl));
    assert.equal(scriptResponse.status, 200);
    console.log('Production page and bundled JavaScript: PASS');
  } else {
    assert.equal(appPageResponse.status, 503);
    assert.match(appPage, /npm run build/);
    console.log('Missing production build is reported explicitly: PASS');
  }

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword })
  });
  assert.equal(loginResponse.status, 200);
  const { token } = await loginResponse.json();
  assert.ok(token);

  const unauthenticated = await fetch(`${baseUrl}/api/invoices`);
  assert.equal(unauthenticated.status, 401);

  const cleanResponse = await postInvoice(baseUrl, token, '01_clean_accepted.pdf');
  assert.equal(cleanResponse.status, 201);
  const clean = await cleanResponse.json();
  assert.equal(clean.result.status, 'ACCEPTED');
  assert.equal(clean.extractionMethod, 'PDF_TEXT');
  assert.equal(clean.pagesProcessed, 1);
  console.log('Authenticated PDF upload, text extraction, verification and persistence: PASS');

  const detailResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.invoice.has_document, 1);
  assert.equal(Object.hasOwn(detail.invoice, 'source_file'), false);
  assert.equal(Object.hasOwn(detail.invoice, 'raw_text'), false);

  const documentResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}/document`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(documentResponse.status, 200);
  assert.match(Buffer.from(await documentResponse.arrayBuffer()).toString('ascii', 0, 5), /%PDF-/);

  const deniedDocument = await fetch(`${baseUrl}/api/invoices/${clean.id}/document`);
  assert.equal(deniedDocument.status, 401);
  console.log('Private source-document download and metadata redaction: PASS');

  const frozenInvoice = await fetch(`${baseUrl}/api/invoices/${clean.id}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'REQUEST_REVIEW' })
  });
  assert.equal(frozenInvoice.status, 409);

  const spoofed = new FormData();
  spoofed.append('file', new Blob(['not a PDF'], { type: 'application/pdf' }), 'spoof.pdf');
  const spoofedResponse = await fetch(`${baseUrl}/api/invoices/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: spoofed
  });
  assert.equal(spoofedResponse.status, 415);
  console.log('Mismatched upload content rejection: PASS');

  const scannedResponse = await postFile(
    baseUrl, token, path.join(projectRoot, 'test-invoices', 'render_check', 'page-1.png'), 'image/png'
  );
  if (scannedResponse.status === 422) {
    const scanFailure = await scannedResponse.json();
    assert.match(scanFailure.message, /Tesseract OCR engine/);
    console.log('Scanned-image OCR: PARTIAL (correctly reports the missing Tesseract engine)');
  } else {
    assert.equal(scannedResponse.status, 201);
    const scanResult = await scannedResponse.json();
    assert.equal(scanResult.extractionMethod, 'IMAGE_OCR');
    assert.ok(scanResult.parsed);
    console.log('Scanned-image OCR: PASS');
  }

  const pythonPath = path.join(projectRoot, '.venv', 'Scripts', 'python.exe');
  const oversizedPdf = path.join(temporaryRoot, 'over-page-limit.pdf');
  const makeOversizedPdf = `from pypdf import PdfWriter
writer=PdfWriter()
for _ in range(21):
    writer.add_blank_page(width=612,height=792)
writer.write(r"${oversizedPdf}")`;
  await execFileAsync(pythonPath, ['-c', makeOversizedPdf], { cwd: projectRoot, env: appEnv });
  const pageLimitResponse = await postFile(baseUrl, token, oversizedPdf, 'application/pdf');
  assert.equal(pageLimitResponse.status, 422);
  assert.match((await pageLimitResponse.json()).message, /maximum supported is 20/);
  console.log('PDF page-count limit: PASS');

  const quantityResponse = await postInvoice(baseUrl, token, '02_quantity_mismatch.pdf');
  assert.equal(quantityResponse.status, 201);
  const quantity = await quantityResponse.json();
  assert.equal(quantity.result.status, 'NEEDS REVIEW');
  const missingComment = await fetch(`${baseUrl}/api/invoices/${quantity.id}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'APPROVE' })
  });
  assert.equal(missingComment.status, 400);
  const reviewed = await fetch(`${baseUrl}/api/invoices/${quantity.id}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'APPROVE', comment: 'Integration test review rationale' })
  });
  assert.equal(reviewed.status, 200);
  assert.equal((await reviewed.json()).status, 'ACCEPTED');
  console.log('Discrepancy review, required rationale and state transition: PASS');

  const csvResponse = await fetch(`${baseUrl}/api/reports/invoices.csv`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.match(csv, /"Invoice","Vendor","Date","Purchase order"/);
  assert.match(csv, /INV-TEST-001/);
  console.log('Authenticated CSV report export: PASS');
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => server.once('close', resolve));
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
