import { z } from 'zod';
import { audit, Problem, randomUUID, type Tx } from './db.js';
export const uuid=z.string().uuid();
const qty=z.number().int().min(1).max(1000000);
const line=z.object({variantId:uuid,quantity:qty}).strict();
export const documentInput=z.object({
 lines:z.array(line).min(1).max(500), reason:z.string().trim().max(1000).default(''), reference:z.string().trim().max(200).default(''),
 bucket:z.enum(['physical','transit','wb','defect']).default('physical'), direction:z.enum(['in','out']).default('in')
}).strict();
export const reversalInput=z.object({reason:z.string().trim().min(3).max(1000)}).strict();
type Delta={variant_id:string,physical:number,reserved:number,transit:number,wb:number,defect:number};
const buckets=['physical','reserved','transit','wb','defect'] as const;
export async function postStock(tx: Tx, user: string, kind: string, reason: string, reference: string, deltas: Delta[], reversesId: string|null=null) {
 const ids=deltas.map(d=>d.variant_id).sort();
 if(new Set(ids).size!==ids.length) throw new Problem(400,'Объедините повторные строки одного варианта');
 // All operations lock balances in the same order to avoid cross-document deadlocks.
 const rows=(await tx.query('SELECT * FROM balances WHERE variant_id=ANY($1::uuid[]) ORDER BY variant_id FOR UPDATE',[ids])).rows;
 if(rows.length!==ids.length) throw new Problem(404,'Вариант товара не найден');
 const id=randomUUID();
 const doc=(await tx.query('INSERT INTO documents(id,kind,reason,reference,reverses_id,user_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,kind,reason,reference,reversesId,user])).rows[0];
 for(const d of deltas) {
  const before=rows.find(r=>r.variant_id===d.variant_id); const after={...before};
  for(const b of buckets) after[b]+=d[b];
  if(buckets.some(b=>after[b]<0 || after[b]>2147483647) || after.reserved>after.physical) throw new Problem(409,'Недостаточно остатка или доступного количества');
  await tx.query('UPDATE balances SET physical=$2,reserved=$3,transit=$4,wb=$5,defect=$6 WHERE variant_id=$1',[d.variant_id,...buckets.map(b=>after[b])]);
  await tx.query('INSERT INTO movements(document_id,variant_id,physical,reserved,transit,wb,defect) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,d.variant_id,...buckets.map(b=>d[b])]);
  await audit(tx,user,'stock.'+kind,d.variant_id,before,{...after,documentId:id},reason);
 }
 return doc;
}
export async function postDocument(tx: Tx,user:string,kind:'receipt'|'adjustment'|'reserve'|'release',input:z.infer<typeof documentInput>) {
 if(kind==='adjustment' && input.reason.length<3) throw new Problem(400,'Укажите причину корректировки');
 if(kind!=='adjustment' && (input.bucket!=='physical' || input.direction!=='in')) throw new Problem(400,'Направление и место учёта доступны только для корректировки');
 const deltas=input.lines.map(l=>{
  const d:Delta={variant_id:l.variantId,physical:0,reserved:0,transit:0,wb:0,defect:0};
  if(kind==='reserve'||kind==='release') d.reserved=l.quantity*(kind==='release'?-1:1);
  else d[kind==='receipt'?'physical':input.bucket]=l.quantity*(input.direction==='out'?-1:1);
  return d;
 });
 return postStock(tx,user,kind,input.reason,input.reference,deltas);
}
export async function reverseDocument(tx: Tx,user:string,id:string,reason:string) {
 const original=(await tx.query('SELECT * FROM documents WHERE id=$1 FOR UPDATE',[id])).rows[0];
 if(!original) throw new Problem(404,'Документ не найден');
 if(original.kind==='production') throw new Problem(409,'Отмените операцию в разделе «Производство»');
 if(original.kind==='reversal' || (await tx.query('SELECT id FROM documents WHERE reverses_id=$1',[id])).rowCount) throw new Problem(409,'Документ уже отменён либо сам является отменой');
 const deltas=(await tx.query('SELECT variant_id,physical,reserved,transit,wb,defect FROM movements WHERE document_id=$1',[id])).rows as Delta[];
 for(const d of deltas) for(const b of buckets) d[b]=-d[b];
 return postStock(tx,user,'reversal',reason,'Отмена №'+original.number,deltas,id);
}
