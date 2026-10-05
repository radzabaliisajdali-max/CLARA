import { registerProduction, productionQuery } from './production.js';
import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { audit, command, Problem, randomUUID, transaction, type DB } from './db.js';
import { digest, passwordHash, token, verifyPassword } from './auth.js';
import { documentInput, postDocument, reversalInput, reverseDocument, uuid } from './stock.js';

type User={id:string,login:string,name:string,role:'owner'|'operator'};
declare module 'fastify' { interface FastifyRequest { user:User; csrf:string; } }
const text=z.string().trim().min(1).max(150);
const productInput=z.object({article:text,name:text,material:z.string().trim().max(500).default('')}).strict();
const variantInput=z.object({color:text,size:text,gtin:z.string().regex(/^(?:\d{8}|\d{12,14})$/),cost:z.string().regex(/^\d{1,12}(\.\d{1,2})?$/).nullable().default(null)}).strict();
const userInput=z.object({login:z.string().regex(/^[a-zA-Z0-9_.-]{2,80}$/),name:text,role:z.enum(['owner','operator']),password:z.string().min(12).max(200)}).strict();
const owner=(r:FastifyRequest)=>{if(r.user.role!=='owner')throw new Problem(403,'Доступно только владельцу');};
const idParam=(r:FastifyRequest)=>uuid.parse((r.params as any).id);
const inventory=`SELECT v.id,v.product_id,p.article,p.name,v.color,v.size,v.gtin,v.cost,b.physical,b.reserved,(b.physical-b.reserved) AS available,b.transit,b.wb,b.defect FROM variants v JOIN products p ON p.id=v.product_id JOIN balances b ON b.variant_id=v.id`;
const movementQuery=`SELECT d.id AS document_id,d.number,d.kind,d.reason,d.reference,d.created_at,u.name AS author,p.article,v.color,v.size,v.gtin,m.physical,m.reserved,m.transit,m.wb,m.defect,d.reverses_id,(SELECT id FROM documents WHERE reverses_id=d.id) AS reversed_by FROM movements m JOIN documents d ON d.id=m.document_id JOIN users u ON u.id=d.user_id JOIN variants v ON v.id=m.variant_id JOIN products p ON p.id=v.product_id`;
export async function buildApp(db:DB,options:{origin?:string,secure?:boolean,logger?:boolean}={}) {
 const app=Fastify({logger:options.logger??false,bodyLimit:1048576,ajv:{customOptions:{coerceTypes:false}}});
 const origin=options.origin??process.env.APP_ORIGIN??'http://localhost:3000';
 const secure=options.secure??process.env.COOKIE_SECURE==='true';
 await app.register(cookie);
 await app.register(rateLimit,{global:false});
 app.decorateRequest('user'); app.decorateRequest('csrf','');
 const dummyHash=await passwordHash(token());
 app.addHook('onSend',async(req,reply,payload)=>{
  reply.header('X-Content-Type-Options','nosniff').header('X-Frame-Options','DENY').header('Referrer-Policy','same-origin');
  reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(req.url.startsWith('/api/')) reply.header('Cache-Control','no-store');
  return payload;
 });
 app.addHook('preHandler',async req=>{
  if(!req.url.startsWith('/api/')) return;
  const writes=!['GET','HEAD','OPTIONS'].includes(req.method);
  if(writes && req.headers.origin!==origin) throw new Problem(403,'Недопустимый источник запроса');
  if(req.url.split('?')[0]==='/api/v1/auth/login') return;
  const session=req.cookies.clara_session;
  if(!session) throw new Problem(401,'Войдите в CLARA');
  const found=(await db.query('SELECT u.id,u.login,u.name,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',[digest(session)])).rows[0];
  if(!found) throw new Problem(401,'Сессия истекла. Войдите снова');
  req.user={id:found.id,login:found.login,name:found.name,role:found.role}; req.csrf=found.csrf;
  if(writes && req.headers['x-csrf-token']!==found.csrf) throw new Problem(403,'Обновите страницу: токен сессии изменился');
 });
 app.setErrorHandler((error,req,reply)=>{
  if(error instanceof z.ZodError) return reply.code(400).send({message:'Проверьте поля: '+error.issues.map(i=>i.path.join('.')+' — '+i.message).join('; ')});
  const e=error as any;
  if(e.code==='23505') return reply.code(409).send({message:'Такой артикул, GTIN, вариант или логин уже существует'});
  if(e.code==='23503') return reply.code(404).send({message:'Связанная запись не найдена'});
  if(e.statusCode && e.statusCode<500) return reply.code(e.statusCode).send({message:e.message});
  req.log.error({code:e.code,message:e.message},'Request failed');
  return reply.code(500).send({message:'Операция не подтверждена. Повторите запрос; при повторной ошибке обратитесь к владельцу.'});
 });
 app.get('/health',async()=>{await db.query('SELECT 1');return {status:'ok'};});
 app.post('/api/v1/auth/login',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
  const input=z.object({login:z.string().max(80),password:z.string().max(200)}).strict().parse(req.body);
  const user=(await db.query('SELECT * FROM users WHERE login=$1 AND active=true',[input.login])).rows[0];
  const valid=await verifyPassword(input.password,user?.password_hash??dummyHash);
  if(!user||!valid) throw new Problem(401,'Неверный логин или пароль');
  const session=token(),csrf=token();
  await transaction(db,async tx=>{
   await tx.query('DELETE FROM sessions WHERE expires_at<=now()');
   await tx.query("INSERT INTO sessions(token_hash,user_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '12 hours')",[digest(session),user.id,csrf]);
   await audit(tx,user.id,'auth.login',user.id,null,{login:user.login});
  });
  reply.setCookie('clara_session',session,{httpOnly:true,sameSite:'strict',secure,path:'/',maxAge:43200});
  return {user:{id:user.id,login:user.login,name:user.name,role:user.role},csrf};
 });
 app.get('/api/v1/auth/me',async req=>({user:req.user,csrf:req.csrf}));
 app.post('/api/v1/auth/logout',async(req,reply)=>{
  await db.query('DELETE FROM sessions WHERE token_hash=$1',[digest(req.cookies.clara_session!)]);
  reply.clearCookie('clara_session',{path:'/',httpOnly:true,sameSite:'strict',secure}); return {ok:true};
 });
 const mutate=(r:FastifyRequest,body:unknown,run:Parameters<typeof command>[5])=>command(db,r.user.id,r.headers['idempotency-key'],r.method+' '+r.url,body,run);
 app.get('/api/v1/users',async req=>{owner(req);return (await db.query('SELECT id,login,name,role,active FROM users ORDER BY login')).rows;});
 app.post('/api/v1/users',async req=>{
  owner(req); const body=userInput.parse(req.body);
  return mutate(req,body,async tx=>{const id=randomUUID();await tx.query('INSERT INTO users(id,login,name,role,password_hash) VALUES($1,$2,$3,$4,$5)',[id,body.login,body.name,body.role,await passwordHash(body.password)]);const {password,...safe}=body;await audit(tx,req.user.id,'user.create',id,null,safe);return {id,...safe};});
 });
 app.patch('/api/v1/users/:id',async req=>{
  owner(req);const id=idParam(req); const body=z.object({active:z.boolean().optional(),role:z.enum(['owner','operator']).optional(),password:z.string().min(12).max(200).optional()}).strict().parse(req.body);
  if(id===req.user.id && (body.active===false||body.role==='operator')) throw new Problem(409,'Нельзя отключить собственную учётную запись владельца');
  return mutate(req,body,async tx=>{await tx.query('SELECT pg_advisory_xact_lock(73051003)');const before=(await tx.query('SELECT id,login,role,active FROM users WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw new Problem(404,'Пользователь не найден');
   if(before.role==='owner'&&before.active&&(body.active===false||body.role==='operator')&&Number((await tx.query("SELECT COUNT(*) FROM users WHERE role='owner' AND active=true")).rows[0].count)<=1)throw new Problem(409,'Нельзя отключить последнего владельца');
   await tx.query('UPDATE users SET active=COALESCE($2,active),role=COALESCE($3,role),password_hash=COALESCE($4,password_hash) WHERE id=$1',[id,body.active,body.role,body.password?await passwordHash(body.password):null]);
   await tx.query('DELETE FROM sessions WHERE user_id=$1',[id]);
   await audit(tx,req.user.id,'user.update',id,before,{active:body.active??before.active,role:body.role??before.role,passwordChanged:!!body.password});return {id};});
 });
 app.get('/api/v1/products',async()=> (await db.query('SELECT p.*,COUNT(v.id)::int AS variants FROM products p LEFT JOIN variants v ON v.product_id=p.id GROUP BY p.id ORDER BY p.article')).rows);
 app.post('/api/v1/products',async req=>{const body=productInput.parse(req.body);return mutate(req,body,async tx=>{const id=randomUUID();await tx.query('INSERT INTO products(id,article,name,material) VALUES($1,$2,$3,$4)',[id,body.article,body.name,body.material]);await audit(tx,req.user.id,'product.create',id,null,body);return {id,...body};});});
 app.patch('/api/v1/products/:id',async req=>{const id=idParam(req),body=productInput.parse(req.body);return mutate(req,body,async tx=>{const before=(await tx.query('SELECT * FROM products WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw new Problem(404,'Товар не найден');await tx.query('UPDATE products SET article=$2,name=$3,material=$4 WHERE id=$1',[id,body.article,body.name,body.material]);await audit(tx,req.user.id,'product.update',id,before,body);return {id,...body};});});
 app.get('/api/v1/variants',async()=> (await db.query(inventory+' ORDER BY p.article,v.color,v.size')).rows);
 app.post('/api/v1/products/:id/variants',async req=>{const product=idParam(req),body=variantInput.parse(req.body);return mutate(req,body,async tx=>{const id=randomUUID();await tx.query('INSERT INTO variants(id,product_id,color,size,gtin,cost) VALUES($1,$2,$3,$4,$5,$6)',[id,product,body.color,body.size,body.gtin,body.cost]);await tx.query('INSERT INTO balances(variant_id) VALUES($1)',[id]);await audit(tx,req.user.id,'variant.create',id,null,{productId:product,...body});return {id,...body};});});
 app.patch('/api/v1/variants/:id',async req=>{const id=idParam(req),body=variantInput.parse(req.body);return mutate(req,body,async tx=>{await tx.query('SELECT variant_id FROM balances WHERE variant_id=$1 FOR UPDATE',[id]);const before=(await tx.query('SELECT * FROM variants WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw new Problem(404,'Вариант не найден');
  // Historical variant identity must remain stable; only cost can change after movements exist.
  if((before.gtin!==body.gtin||before.color!==body.color||before.size!==body.size)&&(await tx.query('SELECT variant_id FROM movements WHERE variant_id=$1 UNION ALL SELECT variant_id FROM production_plans WHERE variant_id=$1 LIMIT 1',[id])).rowCount)throw new Problem(409,'После движений или планирования цвет, размер и GTIN неизменяемы. Создайте новый вариант.');
  await tx.query('UPDATE variants SET color=$2,size=$3,gtin=$4,cost=$5 WHERE id=$1',[id,body.color,body.size,body.gtin,body.cost]);await audit(tx,req.user.id,'variant.update',id,before,body);return {id,...body};});});
 app.get('/api/v1/gtin/:gtin',async req=>{const gtin=z.string().regex(/^(?:\d{8}|\d{12,14})$/).parse((req.params as any).gtin);const found=(await db.query(inventory+' WHERE v.gtin=$1',[gtin])).rows[0];if(!found)throw new Problem(404,'Неизвестный GTIN. Добавьте вариант в разделе «Товары».');return found;});
 app.get('/api/v1/stock',async()=> (await db.query(inventory+' ORDER BY p.article,v.color,v.size')).rows);
 for(const [path,kind] of [['receipts','receipt'],['adjustments','adjustment'],['reservations','reserve'],['releases','release']] as const) {
  app.post('/api/v1/'+path,async req=>{if(kind==='adjustment')owner(req);const body=documentInput.parse(req.body);return mutate(req,body,tx=>postDocument(tx,req.user.id,kind,body));});
 }
 app.post('/api/v1/documents/:id/reverse',async req=>{owner(req);const id=idParam(req),body=reversalInput.parse(req.body);return mutate(req,body,tx=>reverseDocument(tx,req.user.id,id,body.reason));});
 app.get('/api/v1/movements',async()=> (await db.query(movementQuery+' ORDER BY d.number DESC,m.id')).rows);
 app.get('/api/v1/audit',async req=>{owner(req);return (await db.query('SELECT a.*,u.name AS author FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 1000')).rows;});
 app.get('/api/v1/stock/reconciliation',async req=>{owner(req);return (await db.query(`WITH expected AS (SELECT variant_id,SUM(physical) AS physical,SUM(reserved) AS reserved,SUM(transit) AS transit,SUM(wb) AS wb,SUM(defect) AS defect FROM movements GROUP BY variant_id) SELECT b.* FROM balances b LEFT JOIN expected e USING(variant_id) WHERE b.physical<>COALESCE(e.physical,0) OR b.reserved<>COALESCE(e.reserved,0) OR b.transit<>COALESCE(e.transit,0) OR b.wb<>COALESCE(e.wb,0) OR b.defect<>COALESCE(e.defect,0)`)).rows;});
 app.post('/api/v1/stock/rebuild',async req=>{owner(req);const body=reversalInput.parse(req.body);return mutate(req,body,async tx=>{
  await tx.query('LOCK TABLE balances IN EXCLUSIVE MODE');
  const before=(await tx.query('SELECT * FROM balances ORDER BY variant_id')).rows;
  await tx.query(`UPDATE balances b SET physical=COALESCE((SELECT SUM(physical) FROM movements WHERE variant_id=b.variant_id),0),reserved=COALESCE((SELECT SUM(reserved) FROM movements WHERE variant_id=b.variant_id),0),transit=COALESCE((SELECT SUM(transit) FROM movements WHERE variant_id=b.variant_id),0),wb=COALESCE((SELECT SUM(wb) FROM movements WHERE variant_id=b.variant_id),0),defect=COALESCE((SELECT SUM(defect) FROM movements WHERE variant_id=b.variant_id),0)`);
  const after=(await tx.query('SELECT * FROM balances ORDER BY variant_id')).rows;await audit(tx,req.user.id,'stock.rebuild','all',before,after,body.reason);return {rebuilt:after.length};});});
 async function preview() {
  const raw=await readFile('data.js','utf8');const source=JSON.parse(raw.slice(raw.indexOf('=')+1).trim().replace(/;$/,''));
  const existing=new Set((await db.query('SELECT article FROM products')).rows.map(r=>r.article));const seen=new Set<string>();
  return source.map((p:any,index:number)=>{const parsed=productInput.safeParse({article:p.article,name:p.name,material:p.composition??''});const duplicate=seen.has(p.article);seen.add(p.article);return {index,article:p.article,name:p.name,material:p.composition??'',status:!parsed.success?'invalid':existing.has(p.article)?'exists':duplicate?'duplicate':'ready',note:'Цвет, размер и GTIN требуют ручной привязки; остатки и цены не импортируются'};});
 }
 app.get('/api/v1/import/legacy/preview',async req=>{owner(req);return preview();});
 app.post('/api/v1/import/legacy',async req=>{owner(req);const body=z.object({indices:z.array(z.number().int().min(0)).min(1).max(1000)}).strict().parse(req.body);return mutate(req,body,async tx=>{
  const candidates=await preview();const selected=candidates.filter((p:any)=>body.indices.includes(p.index));
  if(selected.length!==new Set(body.indices).size || selected.some((p:any)=>p.status!=='ready'))throw new Problem(409,'Список изменился. Повторите предварительную проверку.');
  for(const p of selected){const id=randomUUID();await tx.query('INSERT INTO products(id,article,name,material) VALUES($1,$2,$3,$4)',[id,p.article,p.name,p.material]);await audit(tx,req.user.id,'product.import',id,null,{article:p.article,name:p.name,source:'V4.1'});}
  return {imported:selected.length};});});
 app.get('/api/v1/exports/:kind',async(req,reply)=>{
  const kind=z.enum(['products','stock','movements','production']).parse((req.params as any).kind);
  const query=kind==='production'?productionQuery+' ORDER BY c.number':kind==='movements'?movementQuery+' ORDER BY d.number,m.id':kind==='stock'?inventory+' ORDER BY p.article,v.color,v.size':`SELECT p.article,p.name,p.material,v.color,v.size,v.gtin,v.cost FROM products p LEFT JOIN variants v ON v.product_id=p.id ORDER BY p.article,v.color,v.size`;
  const rows=(await db.query(query)).rows;
  const keys=kind==='production'?['number','plan_number','article','color','size','gtin','quantity','cut_date','fabric_kg','fabric_per_unit','responsible','cut_remaining','sewing','qc','packing','ready','defect']:kind==='movements'?['number','kind','created_at','author','article','color','size','gtin','physical','reserved','transit','wb','defect','reason','reference']:kind==='stock'?['article','name','color','size','gtin','physical','reserved','available','transit','wb','defect']:['article','name','material','color','size','gtin','cost'];
  const labels:Record<string,string>={plan_number:'План',quantity:'Выкроено',cut_date:'Дата кроя',fabric_kg:'Ткань кг',fabric_per_unit:'Кг на изделие',responsible:'Ответственный',cut_remaining:'Крой не выдан',sewing:'У швей',qc:'Контроль',packing:'Упаковка',ready:'Принято на склад',number:'Документ',kind:'Операция',created_at:'Дата UTC',author:'Автор',article:'Артикул',name:'Товар',material:'Материал',color:'Цвет',size:'Размер',gtin:'GTIN',cost:'Себестоимость ₽',physical:'Наш склад',reserved:'Резерв FBS',available:'Доступно',transit:'В пути',wb:'WB',defect:'Брак',reason:'Причина',reference:'Основание'};
  const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('CLARA');sheet.columns=keys.map(k=>({header:labels[k],key:k,width:22}));
  for(const row of rows) sheet.addRow(Object.fromEntries(keys.map(k=>[k,row[k] instanceof Date?row[k].toISOString():row[k]??''])));
  sheet.getRow(1).font={bold:true};sheet.views=[{state:'frozen',ySplit:1}];sheet.autoFilter={from:{row:1,column:1},to:{row:1,column:keys.length}};
  const buffer=await book.xlsx.writeBuffer();
  reply.header('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition',`attachment; filename="CLARA-${kind}.xlsx"`);return Buffer.from(buffer);
 });
 registerProduction(app,db);
 await app.register(staticFiles,{root:resolve('public'),prefix:'/'});
 return app;
}
