# InvoiceEye — Smart Invoice Verification System

InvoiceEye is a full-stack financial-control application for first-level vendor invoice verification. It accepts invoice text or uploaded PDF/image/text documents, extracts normalized fields, matches them against trusted vendor and purchase-order records, runs deterministic financial checks, identifies duplicate invoices, adds a conservative historical anomaly signal, produces an explainable decision, and stores the complete verification and review history.

The project is intentionally designed as an **assistive verification layer**. It does not autonomously authorize payment. Human reviewers remain responsible for final financial decisions.

## Current capabilities

- JWT authentication and role-aware APIs; local bootstrap keeps only the configured owner account active
- Invoice upload: PDF, PNG/JPG/WEBP/TIFF/TXT (up to 8 MB), or pasted invoice text
- Python document extraction using `pypdf` and Tesseract OCR where required
- Structured invoice-field parsing and normalization
- Vendor master and purchase-order master management
- Purchase-order quantity and unit-price reconciliation
- Subtotal and total arithmetic reconciliation
- Duplicate invoice-number detection
- Conservative vendor-history anomaly signal
- Explainable risk score on a 0–99 scale
- `ACCEPTED`, `NEEDS REVIEW`, `REJECTED` decisions
- Reviewer approve/reject/request-review workflow
- Audit trail for verification and review actions
- Dashboard KPIs, trend chart and outcome distribution
- SQLite persistence by default, with optional MySQL support
- Opt-in synthetic demo vendors, purchase orders and example invoices (`npm run seed:demo`); no demo users
- Controlled test invoice pack for positive and negative cases

## Architecture

```text
                     ┌─────────────────────────┐
                     │       React Client       │
                     │ Dashboard / Review UI    │
                     └────────────┬────────────┘
                                  │ REST/JSON
                                  ▼
                     ┌─────────────────────────┐
                     │     Node.js / Express    │
                     │ Auth / RBAC / APIs       │
                     └────────────┬────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
      ┌──────────────┐   ┌─────────────────┐   ┌────────────────┐
      │ SQLite /     │   │ Verification    │   │ Python         │
      │ MySQL + audit│   │ Engine          │   │ PDF / OCR      │
      │ + audit      │   │ Rules + Risk    │   │ PDF / images   │
      └──────────────┘   └─────────────────┘   └────────────────┘
```

## Main workflow

```text
Upload invoice
      ↓
Extract document text
      ↓
Normalize fields
      ↓
Identify vendor + purchase order
      ↓
Run quantity / price / subtotal / total checks
      ↓
Duplicate detection
      ↓
Supporting anomaly signal
      ↓
Explainable risk score
      ↓
ACCEPTED / NEEDS REVIEW / REJECTED
      ↓
Human review when required
      ↓
Audit history stored
```

## Database model

Core entities:

- `users` — identity, credentials and RBAC role
- `vendors` — supplier master data
- `purchase_orders` — trusted expected transaction header
- `po_items` — expected quantities and prices
- `invoices` — uploaded/processed invoice header and extracted data
- `invoice_items` — normalized invoice line items
- `verification_results` — decision, risk score and checks
- `review_actions` — reviewer decisions and comments
- `audit_logs` — traceability for processing and decisions

The schema uses primary keys, foreign keys, status constraints and indexes for high-frequency lookup fields such as invoice number, PO number, vendor and status.

## Prerequisites

- Node.js 22.12+ (required by Vite 8 and the default SQLite database)
- npm 10+
- Python 3.10+ and the packages in `python/requirements.txt` for document uploads
- Tesseract OCR for scanned images and scanned PDFs (optional; required only for documents without an extractable text layer)
- Git
- Docker Desktop with Docker Compose v2 (optional, for MySQL)

All commands below are run from the `InvoiceEye_Full` directory (the directory containing this README and `package.json`).

## Setup

### 1. Install JavaScript dependencies

```bash
npm ci
```

### 2. (Optional) Install document-processing dependencies

Pasted invoice text works without Python. To upload PDF, image, or text files, install Python and the required packages.

On Windows PowerShell:

```bash
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r python\requirements.txt
```

On macOS/Linux:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r python/requirements.txt
```

The backend automatically prefers `.venv\Scripts\python.exe` on Windows or `.venv/bin/python` on macOS/Linux. Set `PYTHON_BIN` in `.env` only if you want to choose a different interpreter. Text-based PDFs are extracted with `pypdf`; scanned PDFs are rendered with `pypdfium2`, so Poppler is not required. JPG and scanned-PDF OCR require the Tesseract executable. If Tesseract is not on `PATH`, set `TESSERACT_CMD` to its full path in `.env` (for example, `C:\Program Files\Tesseract-OCR\tesseract.exe`). Without that executable, scanned documents fail explicitly instead of being reported as successfully extracted.

### 3. Configure environment

On Windows PowerShell, create `.env` only if it does not already exist:

```powershell
if (!(Test-Path .env)) { Copy-Item .env.example .env }
```

On macOS/Linux:

```bash
test -f .env || cp .env.example .env
```

Set a private `OWNER_PASSWORD` in `.env` before signing in for the first time. The app stores only its bcrypt hash. Do not share or commit `.env`. If the password is blank, the server still starts and serves the app, but the login screen explains that the owner account is not initialized. Setting the password and restarting creates the owner account. If an owner account already exists, leaving the password blank preserves its stored password. `OWNER_EMAIL` defaults to `shivanshcollege2@gmail.com`; `PORT` is the API port and the Vite proxy reads the same value.

#### Local development (SQLite)

SQLite is the default and requires no separate database server. The database, schema and owner account are initialized automatically on first run. No sample vendors, purchase orders, invoices or demo users are added unless you explicitly run the seed command. Invoice data is stored at `server/db/invoiceeye.sqlite`.

To add the synthetic reference data and example invoices for a demo, run this once (it is safe to repeat and preserves existing records):

```bash
npm run seed:demo
```

The seed creates four invoices and derives their verification outcomes through the same parser and verifier used by uploads. It does not create any sign-in accounts.

#### Optional MySQL setup

Set `DB_MODE=mysql` in `.env`, then start MySQL:

```bash
docker compose up -d --wait mysql
```

The database and schema are initialized automatically for a fresh MySQL volume. Run `npm run seed:demo` separately if you want synthetic reference data and example invoices. To use a different database password, configure `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD` in `.env` before creating the volume. Existing volumes retain their initialized credentials.

The application connects using `MYSQL_USER` and `MYSQL_PASSWORD`; it does not need database-administrator credentials. If using an already-installed MySQL server instead of Compose, create the database and grant the application user access before starting the API:

```sql
CREATE DATABASE invoiceeye CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'invoiceeye'@'127.0.0.1' IDENTIFIED BY '<choose-a-local-password>';
GRANT ALL PRIVILEGES ON invoiceeye.* TO 'invoiceeye'@'127.0.0.1';
```

Set the same database name, username and password in `.env`. Do not run `CREATE USER` again if that account already exists; configure `.env` to match its existing credentials instead.

### 4. Start the application

Development:

```bash
npm run dev
```

This starts:

- API: `http://127.0.0.1:5050`
- Vite client: `http://127.0.0.1:5173`

If `PORT` is changed in `.env`, the API URL changes to that port and the Vite `/api` proxy follows it automatically.

Production-style local build:

```bash
npm run build
npm start
```

Then open `http://127.0.0.1:5050`.

## Sign-in

The app creates one admin account: `shivanshcollege2@gmail.com`. Set its password in your private `.env` as `OWNER_PASSWORD` before the first startup. Existing accounts other than `OWNER_EMAIL` are disabled at startup; invoice and audit history is preserved.

## REST API

### Authentication

- `POST /api/auth/login`
- `GET /api/me`

### Dashboard

- `GET /api/health`
- `GET /api/summary`

### Invoices

- `GET /api/invoices` — server-side search and pagination
- `GET /api/invoices/:id`
- `GET /api/invoices/:id/document` — authenticated source-document download
- `POST /api/invoices/verify`
- `POST /api/invoices/:id/review`
- `GET /api/reports/invoices.csv` — authenticated CSV export

### Master data

- `GET /api/vendors`
- `POST /api/vendors` — admin
- `GET /api/purchase-orders`
- `POST /api/purchase-orders` — finance/admin

### Audit / administration

- `GET /api/audit-logs`
- `GET /api/users` — admin

## Verification rules

The verification engine is intentionally deterministic and explainable.

### Quantity

Compares invoice quantity against the PO quantity.

### Unit price

Compares the invoice unit price with the expected PO price for single-line POs.

### Subtotal

Checks:

```text
quantity × unit price ≈ subtotal
```

### Total

Checks:

```text
subtotal / quantity × unit price + tax ≈ total
```

Verification uses a one-currency-unit tolerance for monetary comparisons. Multi-line invoices reconcile subtotal and PO value against the sum of their line-item quantity × unit-price amounts. When a PO has multiple priced lines, line descriptions (or SKUs when both records provide them) and unit prices must match; missing line-item data is routed to review rather than treated as a successful price match. Vendor-master, PO-vendor, and invoice/PO currency mismatches also require review.

### Duplicate
Flags a previously processed invoice number for the same identified vendor, ignoring case and surrounding whitespace, unless the previous record was rejected. The same invoice number belonging to a different vendor is not treated as a duplicate.

### Anomaly signal

A conservative supporting signal compares the current invoice total with historical invoices for the same vendor. This signal contributes reviewer context; it does not autonomously approve or reject financial payment.

## Test pack

The repository includes `test-invoices/` with both text and PDF cases:

- `01_clean_accepted`
- `02_quantity_mismatch`
- `03_price_mismatch`
- `04_duplicate_invoice`
- `05_unknown_purchase_order`
- `06_total_mismatch`

### Automated business-rule smoke test

```bash
npm test
```

Expected result:

```text
InvoiceEye smoke tests: PASS
```

### API integration test

```bash
npm run test:integration
```

This starts an isolated API against a temporary SQLite database and checks upload/extraction, source-document access, invalid file rejection, page limits, review transitions and CSV export. The scanned-image OCR check reports `PARTIAL` when Tesseract is unavailable; install/configure Tesseract to verify that path.

## Suggested demo sequence

1. Run `npm run seed:demo` if you want synthetic demo data.
2. Sign in as `shivanshcollege2@gmail.com` using the password set in `.env`.
3. Open the Invoice Register and inspect the demo-labelled invoices.
4. Upload `01_clean_accepted.pdf` and show `ACCEPTED`.
5. Upload `02_quantity_mismatch.pdf` and show the quantity exception.
6. Open the resulting invoice and inspect evidence.
7. Approve, request review, or reject from the reviewer panel.
8. Open Audit Trail and show that the processing and review actions are recorded.
9. Demonstrate vendor / purchase-order master data with the owner account.

## Verification and deployment status

| Area | Status | Notes |
| --- | --- | --- |
| Local SQLite application | PASS | API and web client run locally; synthetic data is opt-in. |
| Business-rule smoke tests | PASS | `npm test` covers account lifecycle, seed behavior, file signatures and verification outcomes. |
| API integration tests | PASS with OCR limitation | `npm run test:integration` covers the isolated SQLite upload/review/report flow. Scanned OCR reports `PARTIAL` without Tesseract. |
| Text-based PDF extraction | PASS | Requires the Python dependencies installed above. |
| Scanned image/PDF OCR | PARTIAL / environment-dependent | Requires a working Tesseract executable; not verified on systems where it is absent. |
| MySQL runtime | NOT VERIFIED | Optional MySQL configuration is provided, but the local integration checks use SQLite. |
| Hosted deployment | NOT DEPLOYED | No public demo URL or production hosting configuration is included. |
| PDF report export | NOT IMPLEMENTED | Invoice report export currently produces CSV. |

## Security notes

This is an academic/project environment. For production deployment, add:

- secure secret management
- HTTPS
- rotating refresh tokens
- stronger password policy
- upload malware scanning
- object storage instead of local filesystem uploads
- rate limiting
- structured logging and monitoring
- stronger transaction/concurrency controls
- PII/financial-data retention policies

Uploads are currently limited to 8 MB and validated against file signatures, but signature validation is not a substitute for malware scanning.

## Project scope boundary

InvoiceEye is intended to support the first level of invoice verification before payment approval. It does not replace ERP/accounting systems, tax filing, payment gateways or human authorization.

## Author

Shivansh Mittal — B.Tech Computer Science & Engineering
