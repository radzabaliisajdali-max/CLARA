import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit, command, Problem, randomUUID, type DB, type Tx } from './db.js';
import { postStock, uuid } from './stock.js';

const quantity=z.number().int().min(1).max(1000000);
const note=z.string().trim().max(1000).default('');
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'Некорректная дата');
const planInput=z.object({variantId:uuid,quantity,dueDate:date,comment:note}).strict();
const cutInput=z.object({planId:uuid,quantity,cutDate:date,fabricKg:z.string().regex(/^\d{1,10}(\.\d{1,3})?$/).refine(v=>Number(v)>0),responsible:z.string().trim().min(1).max(150),reason:note,comment:note}).strict();
const eventInput=z.object({cutId:uuid,fromStage:z.enum(['cut','sewing','qc','packing']),toStage:z.enum(['sewing','qc','packing','ready','defect']),quantity,workerId:uuid.optional(),operationDate:date,reason:note}).strict();
const transitions=['cut:sewing','sewing:qc','qc:packing','qc:defect','packing:ready'];
const totalsSQL=`SELECT COALESCE(SUM(CASE WHEN reverses_id IS NULL THEN quantity ELSE -quantity END) FILTER(WHERE from_stage=$2),0) AS outgoing, COALESCE(SUM(CASE WHEN reverses_id IS NULL THEN quantity ELSE -quantity END) FILTER(WHERE to_stage=$2),0) AS incoming FROM production_events WHERE cut_id=$1`;
async function remaining(tx:Tx,cut:any,stage:string,worker?:string|null) {
 const row=(await tx.query(totalsSQL+(stage==='sewing'?' AND worker_id=$3':''),stage==='sewing'?[cut.id,stage,worker]:[cut.id,stage])).rows[0];
 return (stage==='cut'?cut.quantity:0)+Number(row.incoming)-Number(row.outgoing);
}
export const productionQuery=`SELECT c.*,p.variant_id,p.number AS plan_number,p.quantity AS planned,p.due_date,v.color,v.size,v.gtin,pr.article,
 round(c.fabric_kg/c.quantity,6)::text AS fabric_per_unit,
 c.quantity-COALESCE(e.cut_out,0)::int AS cut_remaining,COALESCE(e.sewing,0)::int AS sewing,COALESCE(e.qc,0)::int AS qc,COALESCE(e.packing,0)::int AS packing,COALESCE(e.ready,0)::int AS ready,COALESCE(e.defect,0)::int AS defect
 FROM production_cuts c JOIN production_plans p ON p.id=c.plan_id JOIN variants v ON v.id=p.variant_id JOIN products pr ON pr.id=v.product_id
 LEFT JOIN LATERAL (SELECT SUM(q) FILTER(WHERE from_stage='cut') AS cut_out,
 SUM(CASE WHEN to_stage='sewing' THEN q WHEN from_stage='sewing' THEN -q ELSE 0 END) AS sewing,
 SUM(CASE WHEN to_stage='qc' THEN q WHEN from_stage='qc' THEN -q ELSE 0 END) AS qc,
 SUM(CASE WHEN to_stage='packing' THEN q WHEN from_stage='packing' THEN -q ELSE 0 END) AS packing,
 SUM(q) FILTER(WHERE to_stage='ready') AS ready,SUM(q) FILTER(WHERE to_stage='defect') AS defect
 FROM (SELECT *,CASE WHEN reverses_id IS NULL THEN quantity ELSE -quantity END AS q FROM production_events WHERE cut_id=c.id) events) e ON true`;

export function registerProduction(app:FastifyInstance,db:DB) {
 const mutate=(r:FastifyRequest,body:unknown,run:Parameters<typeof command>[5])=>command(db,r.user.id,r.headers['idempotency-key'],r.method+' '+r.url,body,run);
 app.get('/api/v1/production/plans',async()=> (await db.query(`SELECT p.*,v.color,v.size,pr.article,COALESCE((SELECT SUM(quantity) FROM production_cuts WHERE plan_id=p.id),0)::int AS cut_quantity FROM production_plans p JOIN variants v ON v.id=p.variant_id JOIN products pr ON pr.id=v.product_id ORDER BY p.number DESC`)).rows);
 app.post('/api/v1/production/plans',async r=>{const b=planInput.parse(r.body);return mutate(r,b,async tx=>{
  // Same lock as catalogue edits: a variant cannot change identity as its first plan is created.
  await tx.query('SELECT variant_id FROM balances WHERE variant_id=$1 FOR UPDATE',[b.variantId]);
  const result=(await tx.query('INSERT INTO production_plans(id,variant_id,quantity,due_date,comment,user_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[randomUUID(),b.variantId,b.quantity,b.dueDate,b.comment,r.user.id])).rows[0];await audit(tx,r.user.id,'production.plan',result.id,null,result);return result;
 });});
 app.get('/api/v1/production/cuts',async()=> (await db.query(productionQuery+' ORDER BY c.number DESC')).rows);
 app.post('/api/v1/production/cuts',async r=>{const b=cutInput.parse(r.body);return mutate(r,b,async tx=>{
  const plan=(await tx.query('SELECT * FROM production_plans WHERE id=$1 FOR UPDATE',[b.planId])).rows[0];if(!plan)throw new Problem(404,'План не найден');
  const total=Number((await tx.query('SELECT COALESCE(SUM(quantity),0) AS n FROM production_cuts WHERE plan_id=$1',[b.planId])).rows[0].n);
  if(total+b.quantity>plan.quantity&&b.reason.length<3)throw new Problem(409,'Крой превышает план. Укажите причину отклонения');
  const result=(await tx.query('INSERT INTO production_cuts(id,plan_id,quantity,cut_date,fabric_kg,responsible,reason,comment,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[randomUUID(),b.planId,b.quantity,b.cutDate,b.fabricKg,b.responsible,b.reason,b.comment,r.user.id])).rows[0];await audit(tx,r.user.id,'production.cut',result.id,null,result,b.reason);return result;
 });});
 app.get('/api/v1/production/workers',async()=> (await db.query('SELECT id,name FROM production_workers ORDER BY name')).rows);
 app.post('/api/v1/production/workers',async r=>{const b=z.object({name:z.string().trim().min(1).max(150)}).strict().parse(r.body);return mutate(r,b,async tx=>{const result=(await tx.query('INSERT INTO production_workers(id,name,user_id) VALUES($1,$2,$3) RETURNING id,name',[randomUUID(),b.name,r.user.id])).rows[0];await audit(tx,r.user.id,'production.worker',result.id,null,result);return result;});});
 app.get('/api/v1/production/events',async()=> (await db.query(`SELECT e.*,c.number AS cut_number,w.name AS worker,u.name AS author,(SELECT id FROM production_events WHERE reverses_id=e.id) AS reversed_by FROM production_events e JOIN production_cuts c ON c.id=e.cut_id LEFT JOIN production_workers w ON w.id=e.worker_id JOIN users u ON u.id=e.user_id ORDER BY e.number DESC`)).rows);
 app.post('/api/v1/production/events',async r=>{const b=eventInput.parse(r.body);
  if(!transitions.includes(b.fromStage+':'+b.toStage))throw new Problem(400,'Недопустимый переход этапа');
  if(['cut','sewing'].includes(b.fromStage)!==!!b.workerId)throw new Problem(400,'Укажите швею только для выдачи и сдачи пошива');
  if(b.toStage==='defect'&&b.reason.length<3)throw new Problem(400,'Укажите причину брака');
  return mutate(r,b,async tx=>{
   const cut=(await tx.query('SELECT c.*,p.variant_id FROM production_cuts c JOIN production_plans p ON p.id=c.plan_id WHERE c.id=$1 FOR UPDATE OF c',[b.cutId])).rows[0];if(!cut)throw new Problem(404,'Крой не найден');
   if(b.operationDate<String(cut.cut_date instanceof Date?cut.cut_date.toISOString().slice(0,10):cut.cut_date))throw new Problem(400,'Дата операции раньше даты кроя');
   if(await remaining(tx,cut,b.fromStage,b.workerId)<b.quantity)throw new Problem(409,'Недостаточно изделий на выбранном этапе или у швеи');
   const id=randomUUID();let documentId=null;
   if(['ready','defect'].includes(b.toStage))documentId=(await postStock(tx,r.user.id,'production',b.reason,'Крой №'+cut.number,[{variant_id:cut.variant_id,physical:b.toStage==='ready'?b.quantity:0,defect:b.toStage==='defect'?b.quantity:0,reserved:0,wb:0,transit:0}])).id;
   const result=(await tx.query('INSERT INTO production_events(id,cut_id,from_stage,to_stage,quantity,worker_id,operation_date,reason,document_id,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[id,b.cutId,b.fromStage,b.toStage,b.quantity,b.workerId??null,b.operationDate,b.reason,documentId,r.user.id])).rows[0];await audit(tx,r.user.id,'production.transfer',id,null,result,b.reason);return result;
  });
 });
 app.post('/api/v1/production/events/:id/reverse',async r=>{
  if(r.user.role!=='owner')throw new Problem(403,'Доступно только владельцу');
  const id=uuid.parse((r.params as any).id),b=z.object({reason:z.string().trim().min(3).max(1000)}).strict().parse(r.body);
  return mutate(r,b,async tx=>{
   const original=(await tx.query('SELECT * FROM production_events WHERE id=$1',[id])).rows[0];if(!original)throw new Problem(404,'Операция не найдена');
   const cut=(await tx.query('SELECT c.*,p.variant_id FROM production_cuts c JOIN production_plans p ON p.id=c.plan_id WHERE c.id=$1 FOR UPDATE OF c',[original.cut_id])).rows[0];
   if(original.reverses_id||(await tx.query('SELECT 1 FROM production_events WHERE reverses_id=$1',[id])).rowCount)throw new Problem(409,'Операция уже отменена или является отменой');
   if(await remaining(tx,cut,original.to_stage,original.worker_id)<original.quantity)throw new Problem(409,'Изделия уже переданы дальше. Сначала отмените последующие операции');
   let documentId=null;
   if(original.document_id)documentId=(await postStock(tx,r.user.id,'production',b.reason,'Отмена производства №'+original.number,[{variant_id:cut.variant_id,physical:original.to_stage==='ready'?-original.quantity:0,defect:original.to_stage==='defect'?-original.quantity:0,reserved:0,wb:0,transit:0}],original.document_id)).id;
   const result=(await tx.query('INSERT INTO production_events(id,cut_id,from_stage,to_stage,quantity,worker_id,operation_date,reason,document_id,reverses_id,user_id) VALUES($1,$2,$3,$4,$5,$6,CURRENT_DATE,$7,$8,$9,$10) RETURNING *',[randomUUID(),cut.id,original.from_stage,original.to_stage,original.quantity,original.worker_id,b.reason,documentId,id,r.user.id])).rows[0];await audit(tx,r.user.id,'production.reverse',result.id,original,result,b.reason);return result;
  });
 });
}
