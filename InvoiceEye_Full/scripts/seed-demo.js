import 'dotenv/config';
import { getPool, initMySQL, seedDemoData } from '../server/db/mysql.js';

await initMySQL();
try {
  await seedDemoData();
  console.log('Synthetic InvoiceEye demo data seeded (existing records were preserved).');
} finally {
  await getPool().end();
}
