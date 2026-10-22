import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = new URL('./sqlite-schema.sql', import.meta.url);

export async function initSQLite() {
  const { DatabaseSync } = await import('node:sqlite');
  const databasePath = path.resolve(__dirname, '..', '..', process.env.SQLITE_PATH || 'server/db/invoiceeye.sqlite');
  await fs.mkdir(path.dirname(databasePath), { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  database.exec(await fs.readFile(schemaPath, 'utf8'));
  const invoiceColumns = database.prepare('PRAGMA table_info(invoices)').all();
  if (!invoiceColumns.some(column => column.name === 'is_demo')) {
    database.exec('ALTER TABLE invoices ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0');
  }
  database.exec(`UPDATE invoices SET is_demo=1
    WHERE invoice_id IN ('INV-9001','INV-9002','INV-9003') AND raw_text='sample seed'`);

  return createPoolAdapter(database);
}

function createPoolAdapter(database) {
  let transactionOwner = null;
  let transactionUnlocked;
  let transactionWait = Promise.resolve();

  async function waitForTransaction(owner) {
    while (transactionOwner && transactionOwner !== owner) {
      await transactionWait;
    }
  }

  async function query(sql, params = [], owner = null) {
    await waitForTransaction(owner);
    const statement = sql
      .replace(/\s+FOR UPDATE\s*$/i, '')
      .replace(/DATE_FORMAT\(\s*invoice_date\s*,\s*'%Y-%m'\s*\)/gi, "strftime('%Y-%m', invoice_date)");
    const bindings = params.map(value => typeof value === 'boolean' ? Number(value) : value);
    if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(statement)) {
      return [database.prepare(statement).all(...bindings), undefined];
    }
    const result = database.prepare(statement).run(...bindings);
    return [{ affectedRows: Number(result.changes), insertId: Number(result.lastInsertRowid) }, undefined];
  }

  return {
    query: (sql, params) => query(sql, params),
    async getConnection() {
      const owner = {};
      return {
        async beginTransaction() {
          await waitForTransaction(owner);
          transactionOwner = owner;
          transactionWait = new Promise(resolve => { transactionUnlocked = resolve; });
          database.exec('BEGIN');
        },
        query: (sql, params) => query(sql, params, owner),
        async commit() {
          database.exec('COMMIT');
          transactionOwner = null;
          transactionUnlocked();
        },
        async rollback() {
          if (transactionOwner !== owner) return;
          database.exec('ROLLBACK');
          transactionOwner = null;
          transactionUnlocked();
        },
        release() {}
      };
    },
    async end() {
      database.close();
    }
  };
}
