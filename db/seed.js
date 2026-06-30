const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function seed() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const seedsDir = path.join(__dirname, 'seeds');
  const files = fs.readdirSync(seedsDir).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    console.log(`Running seed: ${file}`);
    const sql = fs.readFileSync(path.join(seedsDir, file), 'utf8');
    await pool.query(sql);
    console.log(`✓ ${file}`);
  }
  await pool.end();
  console.log('All seeds completed.');
}

seed().catch(err => { console.error(err); process.exit(1); });
