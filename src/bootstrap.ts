import { pathToFileURL } from 'node:url';
import { makePool, transaction, audit, randomUUID, type DB } from './db.js';
import { passwordHash } from './auth.js';
export async function bootstrap(db: DB, login=process.env.OWNER_LOGIN, password=process.env.OWNER_PASSWORD) {
 await transaction(db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(73051002)');
  if((await tx.query('SELECT id FROM users LIMIT 1')).rowCount) return;
  if(!login || !/^[a-zA-Z0-9_.-]{2,80}$/.test(login) || !password || password.length<12 || password.startsWith('replace-')) throw new Error('Set OWNER_LOGIN and a unique OWNER_PASSWORD of at least 12 characters');
  const id=randomUUID();
  await tx.query('INSERT INTO users(id,login,name,password_hash,role) VALUES($1,$2,$3,$4,$5)',[id,login,'Владелец',await passwordHash(password),'owner']);
  await audit(tx,id,'user.bootstrap',id,null,{login,role:'owner'});
 });
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) { const db=makePool(); try { await bootstrap(db); } finally { await db.end(); } }
