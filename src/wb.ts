import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Problem, type DB } from './db.js';

const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
const statQuery=z.object({ids:z.string().regex(/^\d+(,\d+){0,49}$/),beginDate:day,endDate:day}).strict().refine(v=>{const days=(Date.parse(v.endDate)-Date.parse(v.beginDate))/86400000;return days>=0&&days<31;},'Период должен быть от 1 до 31 дня');
const campaigns=z.object({adverts:z.array(z.object({type:z.number(),status:z.number(),advert_list:z.array(z.object({advertId:z.number().int().positive(),changeTime:z.string().optional()}))})).nullish(),all:z.number().int().nonnegative()});
const stats=z.array(z.object({advertId:z.number().int().positive(),views:z.number().nonnegative().optional(),clicks:z.number().nonnegative().optional(),atbs:z.number().nonnegative().optional(),orders:z.number().nonnegative().optional(),sum:z.number().nonnegative().optional(),sum_price:z.number().nonnegative().optional()}).passthrough());

export function registerWb(app:FastifyInstance,db:DB,options:{token?:string,fetcher?:typeof fetch}={}) {
 const token=options.token??process.env.WB_ADS_TOKEN??'';
 const fetcher=options.fetcher??fetch;
 const account=token?createHash('sha256').update(token).digest('hex').slice(0,24):'unconfigured';
 app.get('/api/v1/integrations',async()=>({wbAds:{configured:!!token,mode:'read-only',source:'WB API',liveVerified:false},wbFbs:{configured:false},wbAnalytics:{configured:false},marking:{configured:false}}));
 async function load(endpoint:string,params:Record<string,string>,user:string,parser:z.ZodType){
  if(!token)throw new Problem(503,'Реклама WB не подключена. Владелец должен задать WB_ADS_TOKEN на сервере.');
  const query=new URLSearchParams(params).toString();const key=account+':'+endpoint+'?'+query;
  const previous=(await db.query('SELECT payload,fetched_at FROM wb_snapshots WHERE cache_key=$1',[key])).rows[0];
  if(previous&&Date.now()-new Date(previous.fetched_at).getTime()<60000)return {data:previous.payload,fetchedAt:previous.fetched_at,cached:true,stale:false};
  const stale=(message:string)=>previous?{data:previous.payload,fetchedAt:previous.fetched_at,cached:true,stale:true,message}:null;
  // Shared across processes. A failed request still consumes its rate-limit slot.
  const seconds=endpoint.includes('fullstats')?21:2;
  const reserved=await db.query(`INSERT INTO wb_request_limits(endpoint,next_at) VALUES($1,now()+$2*interval '1 second') ON CONFLICT(endpoint) DO UPDATE SET next_at=EXCLUDED.next_at WHERE wb_request_limits.next_at<=now() RETURNING endpoint`,[account+':'+endpoint,seconds]);
  if(!reserved.rowCount){const old=stale('Пауза между запросами WB. Показаны сохранённые данные.');if(old)return old;throw new Problem(429,'WB: следующий запрос доступен через несколько секунд.');}
  let response:Response;
  try{response=await fetcher('https://advert-api.wildberries.ru'+endpoint+(query?'?'+query:''),{method:'GET',headers:{Authorization:token},signal:AbortSignal.timeout(15000),redirect:'error'});}
  catch{const old=stale('WB недоступен. Показаны сохранённые данные.');if(old)return old;throw new Problem(502,'Нет связи с WB. Попробуйте позже.');}
  if(!response.ok){
   if(response.status===429)await db.query("UPDATE wb_request_limits SET next_at=now()+interval '60 seconds' WHERE endpoint=$1",[account+':'+endpoint]);
   const message=response.status===401||response.status===403?'WB отклонил доступ. Проверьте срок токена и категорию «Продвижение».':response.status===429?'WB ограничил частоту запросов. Повторите через минуту.':'WB не вернул отчёт. Проверьте выбранные кампании и период.';
   const old=stale(message);if(old)return old;throw new Problem(response.status===429?429:502,message);
  }
  let payload:unknown;try{payload=parser.parse(await response.json());}catch{const old=stale('Формат ответа WB изменился. Показаны сохранённые данные.');if(old)return old;throw new Problem(502,'Не удалось проверить формат ответа WB.');}
  const saved=(await db.query('INSERT INTO wb_snapshots(cache_key,payload,user_id) VALUES($1,$2,$3) ON CONFLICT(cache_key) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=now(),user_id=EXCLUDED.user_id RETURNING fetched_at',[key,JSON.stringify(payload),user])).rows[0];
  return {data:payload,fetchedAt:saved.fetched_at,cached:false,stale:false};
 }
 app.get('/api/v1/wb/ads/campaigns',async r=>{
  const report=await load('/adv/v1/promotion/count',{},r.user.id,campaigns);
  const parsed=campaigns.parse(report.data);return {...report,data:(parsed.adverts??[]).flatMap(g=>g.advert_list.map(a=>({id:a.advertId,type:g.type,status:g.status,changedAt:a.changeTime??null})))};
 });
 app.get('/api/v1/wb/ads/statistics',async r=>{
  const q=statQuery.parse(r.query);q.ids=[...new Set(q.ids.split(','))].sort((a,b)=>Number(a)-Number(b)).join(',');
  if(q.ids.split(',').some(id=>!Number.isSafeInteger(Number(id))||Number(id)<=0))throw new Problem(400,'Некорректный номер кампании');
  return load('/adv/v3/fullstats',q,r.user.id,stats);
 });
}
