import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { buildApp } from '../src/app.js';
import { database } from './helpers.js';
import { backup, restore } from '../src/backup.js';
import { makePool } from '../src/db.js';

test('CLARA: PostgreSQL, права, документы, конкурентность, история, экспорт',async t=>{
 const env=await database();const app=await buildApp(env.db);await app.ready();
 t.after(async()=>{await app.close();await env.stop();});
 const login=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:'http://localhost:3000'},payload:{login:'owner',password:'test-password-12345'}});
 assert.equal(login.statusCode,200,login.body);assert.match(String(login.headers['set-cookie']),/HttpOnly/);
 const headers={origin:'http://localhost:3000',cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrf};
 const call=(path:string,body?:any,key:string=randomUUID(),auth:any=headers,method?:any)=>app.inject({method:method??(body?'POST':'GET'),url:'/api/v1'+path,headers:{...auth,'idempotency-key':key},...(body?{payload:body}:{})});
 const ok=async(path:string,body?:any,key?:string)=>{const r=await call(path,body,key);assert.equal(r.statusCode,200,r.body);return r.json();};
 let product:any,v:any,v2:any;
 await t.test('пустая база, авторизация и CSRF',async()=>{
  assert.deepEqual(await ok('/stock'),[]);assert.deepEqual(await ok('/products'),[]);
  assert.equal((await call('/stock',undefined,undefined,{})).statusCode,401);
  assert.equal((await call('/products',{article:'x',name:'x'},undefined,{...headers,'x-csrf-token':'bad'})).statusCode,403);
  assert.equal((await call('/products',{article:'x',name:'x'},undefined,{...headers,origin:'https://evil.example'})).statusCode,403);
 });
 await t.test('товары: вариант, GTIN строкой, произвольные размеры, дубли',async()=>{
  product=await ok('/products',{article:'S01',name:'Сорочка'});
  v=await ok('/products/'+product.id+'/variants',{color:'Красный',size:'48–50',gtin:'0123456789012',cost:'225.00'});
  v2=await ok('/products/'+product.id+'/variants',{color:'Синий',size:'XXL',gtin:'0123456789013'});
  assert.equal((await ok('/gtin/0123456789012')).cost,'225.00');
  assert.equal((await call('/products/'+product.id+'/variants',{color:'Белый',size:'52',gtin:v.gtin})).statusCode,409);
  assert.equal((await call('/gtin/99999999')).statusCode,404);
  assert.equal((await call('/products/'+product.id+'/variants',{color:'x',size:'x',gtin:12345678})).statusCode,400);
 });
 const lines=(n:number,id=()=>v.id)=>({lines:[{variantId:id(),quantity:n}]});
 await t.test('валидация количества и атомарность многострочного документа',async()=>{
  for(const n of [0,-1,1.2])assert.equal((await call('/receipts',lines(n))).statusCode,400);
  assert.equal((await call('/receipts',{lines:[{variantId:v.id,quantity:2},{variantId:randomUUID(),quantity:1}]})).statusCode,404);
  assert.equal((await ok('/gtin/'+v.gtin)).physical,0);
 });
 let receipt:any;
 await t.test('повторное нажатие и изменение тела с тем же ключом',async()=>{
  const key=randomUUID();const results=await Promise.all([call('/receipts',lines(20),key),call('/receipts',lines(20),key)]);
  results.forEach(r=>assert.equal(r.statusCode,200,r.body));receipt=results[0].json();assert.equal(receipt.id,results[1].json().id);
  assert.equal((await ok('/gtin/'+v.gtin)).physical,20);
  assert.equal((await call('/receipts',lines(21),key)).statusCode,409);
 });
 await t.test('конкурентный резерв не превышает остаток',async()=>{
  const results=await Promise.all([call('/reservations',lines(15)),call('/reservations',lines(15))]);
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
  const stock=await ok('/gtin/'+v.gtin);assert.equal(stock.physical,20);assert.equal(stock.reserved,15);assert.equal(stock.available,5);
  assert.equal((await call('/adjustments',{...lines(6),reason:'Списание',direction:'out'})).statusCode,409);
 });
 await t.test('снятие резерва, компенсация, отдельные места и размеры',async()=>{
  await ok('/releases',lines(15));
  await ok('/documents/'+receipt.id+'/reverse',{reason:'Ошибочная приёмка'});
  assert.equal((await call('/documents/'+receipt.id+'/reverse',{reason:'Ещё раз'})).statusCode,409);
  await ok('/receipts',lines(30));await ok('/receipts',lines(4,()=>v2.id));
  await ok('/adjustments',{...lines(2),reason:'Инвентаризация брака',bucket:'defect'});
  await ok('/adjustments',{...lines(3),reason:'Сверка отправленного',bucket:'transit'});
  await ok('/adjustments',{...lines(7),reason:'Сверка остатков WB',bucket:'wb'});
  const stock=await ok('/gtin/'+v.gtin);assert.equal(stock.physical,30);assert.equal(stock.defect,2);assert.equal(stock.transit,3);assert.equal(stock.wb,7);
  assert.equal((await ok('/gtin/'+v2.gtin)).physical,4);
  assert.equal((await call('/adjustments',lines(1))).statusCode,400);
  assert.equal((await call('/variants/'+v.id,{color:'Другой',size:'48–50',gtin:v.gtin,cost:'225'},undefined,headers,'PATCH')).statusCode,409);
 });
 await t.test('оператор принимает товар, но не исправляет и не создаёт пользователей',async()=>{
  const operator=await ok('/users',{login:'operator',name:'Швея',role:'operator',password:'operator-pass-123'});
  const response=await app.inject({method:'POST',url:'/api/v1/auth/login',headers:{origin:headers.origin},payload:{login:'operator',password:'operator-pass-123'}});
  const auth={...headers,cookie:String(response.headers['set-cookie']).split(';')[0],'x-csrf-token':response.json().csrf};
  assert.equal((await call('/receipts',lines(1),undefined,auth)).statusCode,200);
  for(const [path,body] of [['/adjustments',{...lines(1),reason:'тест'}],['/users',{login:'bad'}],['/stock/rebuild',{reason:'проверка'}]] as const)assert.equal((await call(path,body,undefined,auth)).statusCode,403);
  assert.equal((await call('/audit',undefined,undefined,auth)).statusCode,403);
  assert.equal((await call('/users/'+operator.id,{active:false},undefined,headers,'PATCH')).statusCode,200);
  assert.equal((await call('/stock',undefined,undefined,auth)).statusCode,401);
 });
 await t.test('история неизменяема, остатки восстанавливаются, миграции повторяемы',async()=>{
  await assert.rejects(env.db.query('UPDATE movements SET physical=0'),/immutable/);
  await assert.rejects(env.db.query('DELETE FROM documents'),/immutable/);
  const before=await ok('/stock');await env.db.query('UPDATE balances SET physical=100');assert.ok((await ok('/stock/reconciliation')).length>0);
  await ok('/stock/rebuild',{reason:'Проверка восстановления'});assert.deepEqual(await ok('/stock'),before);assert.deepEqual(await ok('/stock/reconciliation'),[]);
  const second=await buildApp(env.db);const result=await second.inject({url:'/api/v1/stock',headers});assert.deepEqual(result.json(),before);await second.close();
 });
 await t.test('xlsx совпадает с БД, ведущий ноль GTIN сохранён',async()=>{
  for(const kind of ['products','stock','movements']){
   const r=await call('/exports/'+kind);assert.equal(r.statusCode,200);assert.match(String(r.headers['content-type']),/spreadsheetml/);
   const book=new ExcelJS.Workbook();await book.xlsx.load(r.rawPayload as any);const sheet=book.worksheets[0];assert.ok(sheet.rowCount>1);
   const gtinColumn=(sheet.getRow(1).values as any[]).findIndex((x:any)=>x==='GTIN');assert.equal(typeof sheet.getRow(2).getCell(gtinColumn).value,'string');
   if(kind==='stock')assert.equal(sheet.getRow(2).getCell(6).value,(await ok('/stock'))[0].physical);
  }
 });
 await t.test('импорт только выбранных моделей без вымышленных вариантов и остатков',async()=>{
  const preview=await ok('/import/legacy/preview');const candidate=preview.find((r:any)=>r.status==='ready');assert.ok(candidate);
  const before=await ok('/stock');await ok('/import/legacy',{indices:[candidate.index]});assert.deepEqual(await ok('/stock'),before);
  assert.equal((await call('/import/legacy',{indices:[candidate.index]})).statusCode,409);
 });
 await t.test('производство: крой, швеи, контроль, брак, упаковка, конкуренция и отмена',async()=>{
  const before=await ok('/gtin/'+v.gtin);
  const p=await ok('/production/plans',{variantId:v.id,quantity:10,dueDate:'2026-10-10'});
  assert.equal((await call('/production/plans',{variantId:v.id,quantity:1.5,dueDate:'2026-10-10'})).statusCode,400);
  assert.equal((await call('/production/plans',{variantId:v.id,quantity:1,dueDate:'2026-02-30'})).statusCode,400);
  const cutBody={planId:p.id,quantity:10,cutDate:'2026-10-05',fabricKg:'3.500',responsible:'Закройщик'};
  const key=randomUUID();const c=await ok('/production/cuts',cutBody,key);assert.equal((await ok('/production/cuts',cutBody,key)).id,c.id);
  assert.equal((await call('/production/cuts',cutBody)).statusCode,409);
  const w=await ok('/production/workers',{name:'Анна'}),w2=await ok('/production/workers',{name:'Ирина'});
  const event=(fromStage:string,toStage:string,n:number,workerId?:string)=>({cutId:c.id,fromStage,toStage,quantity:n,operationDate:'2026-10-05',...(workerId?{workerId}:{}),...(toStage==='defect'?{reason:'Дефект строчки'}:{})});
  const results=await Promise.all([call('/production/events',event('cut','sewing',7,w.id)),call('/production/events',event('cut','sewing',7,w2.id))]);
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
  const assigned=results.find(r=>r.statusCode===200)!.json();const worker=assigned.worker_id;
  assert.equal((await call('/production/events',event('sewing','qc',1,worker===w.id?w2.id:w.id))).statusCode,409);
  const sewn=await ok('/production/events',event('sewing','qc',7,worker));
  assert.equal((await call('/production/events/'+assigned.id+'/reverse',{reason:'Тест отмены'})).statusCode,409);
  await ok('/production/events',event('qc','defect',1));
  await ok('/production/events',event('qc','packing',6));
  assert.equal((await ok('/gtin/'+v.gtin)).physical,before.physical);
  const readyKey=randomUUID();const ready=await ok('/production/events',event('packing','ready',6),readyKey);
  assert.equal((await ok('/production/events',event('packing','ready',6),readyKey)).id,ready.id);
  assert.equal((await call('/production/events',event('packing','ready',1))).statusCode,409);
  assert.equal((await call('/documents/'+ready.document_id+'/reverse',{reason:'Нельзя отдельно'})).statusCode,409);
  let stock=await ok('/gtin/'+v.gtin);assert.equal(stock.physical,before.physical+6);assert.equal(stock.defect,before.defect+1);
  await ok('/production/events/'+ready.id+'/reverse',{reason:'Вернуть на упаковку'});
  assert.equal((await call('/production/events/'+ready.id+'/reverse',{reason:'Повторная отмена'})).statusCode,409);
  stock=await ok('/gtin/'+v.gtin);assert.equal(stock.physical,before.physical);
  const row=(await ok('/production/cuts')).find((r:any)=>r.id===c.id);assert.equal(row.fabric_per_unit,'0.350000');assert.equal(row.cut_remaining,3);assert.equal(row.packing,6);assert.equal(row.ready,0);assert.equal(row.defect,1);
  await assert.rejects(env.db.query('DELETE FROM production_events WHERE id=$1',[sewn.id]),/immutable/);
  assert.deepEqual(await ok('/stock/reconciliation'),[]);
  const exported=await call('/exports/production');assert.equal(exported.statusCode,200,exported.body);const book=new ExcelJS.Workbook();await book.xlsx.load(exported.rawPayload as any);assert.equal(book.worksheets[0].getRow(2).getCell(9).value,'3.500');
 });
 await t.test('резервная копия и восстановление в пустую схему PostgreSQL, последовательности и защита от перезаписи',async()=>{
  const dump=await backup(env.db);const name='restore_'+randomUUID().replaceAll('-','');await env.db.query('CREATE SCHEMA '+name);
  const url=new URL(env.url);url.searchParams.set('options','-c search_path='+name);const target=makePool(url.href);
  try{await restore(target,JSON.parse(JSON.stringify(dump)));assert.equal((await target.query('SELECT COUNT(*) FROM movements')).rows[0].count,String(dump.data.movements.length));
   assert.deepEqual((await target.query('SELECT * FROM balances ORDER BY variant_id')).rows,(await env.db.query('SELECT * FROM balances ORDER BY variant_id')).rows);
   assert.equal((await target.query('SELECT COUNT(*) FROM sessions')).rows[0].count,'0');
   for(const table of ['production_plans','production_cuts','production_workers','production_events'])assert.deepEqual((await target.query('SELECT * FROM '+table+' ORDER BY id')).rows,(await env.db.query('SELECT * FROM '+table+' ORDER BY id')).rows);
   await assert.rejects(restore(target,dump),/empty database/);
   const next=(await target.query("SELECT nextval(pg_get_serial_sequence('documents','number')) AS n")).rows[0].n;assert.ok(Number(next)>Math.max(...dump.data.documents.map(r=>Number(r.number))));
  }finally{await target.end();await env.db.query('DROP SCHEMA '+name+' CASCADE');}
 });
});
