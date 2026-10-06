import { readFile, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { makePool, transaction, type DB } from './db.js';
export async function migrate(db: DB) {
 await transaction(db,async tx=>{
  await tx.query("SELECT pg_advisory_xact_lock(73051001)");
  await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir('migrations')).filter(n=>n.endsWith('.sql')).sort()) {
   const sql = await readFile('migrations/'+name,'utf8'); const hash=createHash('sha256').update(sql).digest('hex');
   const previous=(await tx.query('SELECT checksum FROM schema_migrations WHERE name=$1',[name])).rows[0];
   if(previous) { if(previous.checksum!==hash) throw new Error('Migration checksum mismatch: '+name); continue; }
   await tx.query(sql); await tx.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)',[name,hash]);
  }
 });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) { const db=makePool(); try { await migrate(db); } finally { await db.end(); } }
