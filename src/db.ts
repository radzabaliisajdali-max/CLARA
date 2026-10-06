import pg from 'pg';
// Calendar dates must not become local-midnight timestamps during JSON backup or API serialization.
pg.types.setTypeParser(1082, value => value);
import { randomUUID, createHash } from 'node:crypto';
export const makePool = (url = process.env.DATABASE_URL) => new pg.Pool({ connectionString: url, max: 12, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000, statement_timeout: 30000 });
export type DB = pg.Pool;
export type Tx = pg.PoolClient;
export class Problem extends Error { constructor(public statusCode: number, message: string) { super(message); } }
export async function transaction<T>(db: DB, run: (tx: Tx) => Promise<T>): Promise<T> {
 const tx = await db.connect();
 try { await tx.query('BEGIN'); const value = await run(tx); await tx.query('COMMIT'); return value; }
 catch(e) { await tx.query('ROLLBACK'); throw e; } finally { tx.release(); }
}
export async function audit(tx: Tx, user: string | null, action: string, id: string, oldValue: unknown, newValue: unknown, reason = '') {
 await tx.query('INSERT INTO audit_log(user_id,action,entity_id,old_value,new_value,reason) VALUES($1,$2,$3,$4,$5,$6)', [user,action,id,JSON.stringify(oldValue),JSON.stringify(newValue),reason]);
}
function canonical(value: any): string {
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if(value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 return JSON.stringify(value);
}
export async function command(db: DB, user: string, key: unknown, route: string, body: unknown, run: (tx: Tx) => Promise<unknown>) {
 if(typeof key !== 'string' || !/^[\w-]{16,100}$/.test(key)) throw new Problem(400,'Нужен Idempotency-Key (16–100 символов)');
 const hash = createHash('sha256').update(route+'\n'+canonical(body)).digest('hex');
 return transaction(db,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user+':'+key]);
  const old = (await tx.query('SELECT * FROM idempotency WHERE user_id=$1 AND key=$2',[user,key])).rows[0];
  if(old) { if(old.request_hash !== hash) throw new Problem(409,'Этот ключ уже использован для другой операции'); return old.response; }
  const result = await run(tx);
  await tx.query('INSERT INTO idempotency(user_id,key,request_hash,response) VALUES($1,$2,$3,$4)',[user,key,hash,JSON.stringify(result)]);
  return result;
 });
}
export { randomUUID };
