import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { Problem, audit, transaction, type DB } from './db.js';

// One credential provider shared by every WB adapter. Secrets never enter audit/API responses.
export function wbConnection(app:FastifyInstance,db:DB,fallback:string) {
 const encryptionKey=()=>{
  const value=process.env.WB_TOKEN_ENCRYPTION_KEY??'';
  if(!/^[a-fA-F0-9]{64}$/.test(value))throw new Problem(503,'Хранилище ключей не настроено администратором сервера.');
  return Buffer.from(value,'hex');
 };
 const configured=async()=>!!(await db.query('SELECT id FROM wb_connection WHERE id=1')).rowCount||!!fallback;
 const getToken=async()=>{
  const row=(await db.query('SELECT encrypted_token FROM wb_connection WHERE id=1')).rows[0];
  if(!row)return fallback;
  try{const [iv,tag,data]=row.encrypted_token.split('.').map((s:string)=>Buffer.from(s,'base64'));const cipher=createDecipheriv('aes-256-gcm',encryptionKey(),iv);cipher.setAuthTag(tag);return Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8');}
  catch{throw new Problem(503,'Не удалось открыть подключение WB. Проверьте серверный ключ шифрования.');}
 };
 app.put('/api/v1/integrations/wb',async r=>{
  if(r.user.role!=='owner')throw new Problem(403,'Подключение доступно только владельцу');
  // Generic errors must not echo user-supplied secret values.
  const parsed=z.object({token:z.string().trim().min(20).max(10000).regex(/^[A-Za-z0-9._-]+$/)}).strict().safeParse(r.body);
  if(!parsed.success)throw new Problem(400,'Проверьте формат API-токена WB');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey(),iv);
  const data=Buffer.concat([cipher.update(parsed.data.token,'utf8'),cipher.final()]);
  const encrypted=[iv,cipher.getAuthTag(),data].map(b=>b.toString('base64')).join('.');
  await transaction(db,async tx=>{
   await tx.query('INSERT INTO wb_connection(id,encrypted_token,user_id) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET encrypted_token=EXCLUDED.encrypted_token,user_id=EXCLUDED.user_id,updated_at=now()',[encrypted,r.user.id]);
   await audit(tx,r.user.id,'wb.connection.saved',r.user.id,null,{configured:true});
  });
  return {configured:true,message:'Общий ключ сохранён. Доступ проверяется при обращении к WB.'};
 });
 return {getToken,configured,storageReady:()=>/^[a-fA-F0-9]{64}$/.test(process.env.WB_TOKEN_ENCRYPTION_KEY??'')};
}

