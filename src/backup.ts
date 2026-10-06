import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makePool, transaction, type DB } from './db.js';
import { migrate } from './migrate.js';
const tables=['users','products','variants','balances','documents','movements','audit_log','idempotency','production_plans','production_cuts','production_workers','production_events','wb_snapshots'] as const;
const jsonColumns:Record<string,string[]>={wb_snapshots:['payload'],audit_log:['old_value','new_value'],idempotency:['response']};
export async function backup(db:DB) {
 return transaction(db,async tx=>{
  await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const data:Record<string,any[]>={};for(const table of tables)data[table]=(await tx.query('SELECT * FROM '+table)).rows;
  const migrations=(await tx.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  return {format:'clara-backup-v1',createdAt:new Date().toISOString(),migrations,data};
 });
}
export async function restore(db:DB, input:unknown) {
 const dump=input as any;if(dump?.format!=='clara-backup-v1'||!dump.data||!Array.isArray(dump.migrations)||tables.some(t=>!Array.isArray(dump.data[t])))throw new Error('Invalid CLARA backup');
 await migrate(db);
 await transaction(db,async tx=>{
  await tx.query('LOCK TABLE '+tables.join(',')+',sessions IN ACCESS EXCLUSIVE MODE');
  for(const table of [...tables,'sessions'])if((await tx.query('SELECT 1 FROM '+table+' LIMIT 1')).rowCount)throw new Error('Restore requires an empty database');
  const migrations=(await tx.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  if(JSON.stringify(migrations)!==JSON.stringify(dump.migrations))throw new Error('Backup schema version mismatch');
  for(const table of tables){
   const cols=(await tx.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1 ORDER BY ordinal_position",[table])).rows.map(r=>r.column_name as string);
   // Reversals reference earlier documents, so restore document sequence order.
   const rows=['documents','production_events'].includes(table)?[...dump.data[table]].sort((a,b)=>Number(a.number)-Number(b.number)):dump.data[table];
   for(const row of rows){if(cols.some(c=>!(c in row)))throw new Error('Missing backup columns: '+table);
    const values=cols.map(c=>jsonColumns[table]?.includes(c)?JSON.stringify(row[c]):row[c]);
    await tx.query(`INSERT INTO ${table} (${cols.map(c=>'"'+c+'"').join(',')}) OVERRIDING SYSTEM VALUE VALUES(${cols.map((_,i)=>'$'+(i+1)).join(',')})`,values);
   }
  }
  for(const [table,col] of [['documents','number'],['movements','id'],['audit_log','id'],['production_plans','number'],['production_cuts','number'],['production_events','number']])await tx.query(`SELECT setval(pg_get_serial_sequence('${table}','${col}'),COALESCE((SELECT MAX(${col}) FROM ${table}),1),(SELECT COUNT(*)>0 FROM ${table}))`);
  // Sessions intentionally excluded. Everyone signs in again after recovery.
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [operation,path]=process.argv.slice(2);if(!path||!['save','restore'].includes(operation))throw new Error('Usage: node dist/backup.js save|restore <file.json>');
 const db=makePool();try{if(operation==='save'){await mkdir(dirname(path),{recursive:true});await writeFile(path,JSON.stringify(await backup(db)),{flag:'wx',mode:0o600});console.log('Backup saved');}else{await restore(db,JSON.parse(await readFile(path,'utf8')));console.log('Backup restored; sessions invalidated');}}finally{await db.end();}
}
