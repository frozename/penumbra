import { Database } from 'bun:sqlite';
const db = new Database(':memory:');
db.exec('CREATE TABLE t1(id TEXT)');
try {
  const r = db.query(`SELECT COUNT(*) as count FROM pragma_table_info(?) WHERE name=?`).get('t1', 'id');
  console.log('Success:', r);
} catch(e) {
  console.log('Error:', e);
}
