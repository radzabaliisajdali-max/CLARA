import type {FastifyInstance} from 'fastify';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {Problem,transaction,audit,randomUUID,type DB} from './db.js';
const card=z.object({nmID:z.number().int(),vendorCode:z.string(),title:z.string().default(''),sizes:z.array(z.object({chrtID:z.number().int(),techSize:z.string(),wbSize:z.string().default(''),skus:z.array(z.string())}).passthrough()),characteristics:z.array(z.object({name:z.string(),value:z.unknown()}).passthrough()).default([])}).passthrough();
const page=z.object({cards:z.array(card),cursor:z.object({total:z.number().int(),nmID:z.number().optional(),updatedAt:z.string().optional()})});
export function registerWbCatalog(app:FastifyInstance,db:DB,getToken:()=>Promise<string>,fetcher:typeof fetch){
 const keyFor=(token:string)=>createHash('sha256').update(token).digest('hex').slice(0,24)+':catalog';
 app.post('/api/v1/wb/catalog/sync',async r=>{
  if(r.user.role!=='owner')throw new Problem(403,'Загрузка каталога доступна владельцу');
  const token=await getToken();if(!token)throw new Problem(503,'Сначала подключите WB');
  const key=keyFor(token),lock=await db.connect();
  const acquired=(await lock.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[key])).rows[0].ok;
  if(!acquired){lock.release();throw new Problem(409,'Каталог уже загружается');}
  try{
   const slot=await lock.query("INSERT INTO wb_request_limits(endpoint,next_at) VALUES($1,now()+interval '60 seconds') ON CONFLICT(endpoint) DO UPDATE SET next_at=EXCLUDED.next_at WHERE wb_request_limits.next_at<=now() RETURNING endpoint",[key]);
   if(!slot.rowCount)throw new Problem(429,'Повтор загрузки доступен через минуту');
   let cursor:Record<string,unknown>={limit:100};const cards=new Map<number,z.infer<typeof card>>();let finished=false;
   for(let n=0;n<100;n++){
    if(n)await delay(650);
    let response:Response;try{response=await fetcher('https://content-api.wildberries.ru/content/v2/get/cards/list',{method:'POST',headers:{Authorization:token,'Content-Type':'application/json'},body:JSON.stringify({settings:{sort:{ascending:true},filter:{withPhoto:-1},cursor}}),signal:AbortSignal.timeout(20000),redirect:'error'});}catch{throw new Problem(502,'Связь с WB прервалась. Предыдущий каталог сохранён.');}
    if(!response.ok)throw new Problem(response.status===429?429:502,'WB не отдал каталог. Проверьте доступ к карточкам, срок ключа и лимиты. Предыдущие данные сохранены.');
    let parsed:z.infer<typeof page>;try{parsed=page.parse(await response.json());}catch{throw new Problem(502,'Не удалось проверить формат каталога WB');}
    for(const item of parsed.cards)cards.set(item.nmID,item);
    if(parsed.cursor.total<100){finished=true;break;}
    if(!parsed.cursor.updatedAt||parsed.cursor.nmID===undefined||JSON.stringify(cursor)===JSON.stringify({limit:100,updatedAt:parsed.cursor.updatedAt,nmID:parsed.cursor.nmID}))throw new Problem(502,'WB не продвинул страницу каталога');
    cursor={limit:100,updatedAt:parsed.cursor.updatedAt,nmID:parsed.cursor.nmID};
   }
   if(!finished)throw new Problem(422,'Каталог превышает 10 000 карточек. Требуется фоновая загрузка.');
   if(await getToken()!==token)throw new Problem(409,'Ключ изменён во время загрузки. Повторите синхронизацию.');
   return await transaction(db,async tx=>{
    const issues:string[]=[];let created=0;
    for(const c of cards.values()){
     const colorValue=c.characteristics.find(v=>v.name.toLowerCase()==='цвет')?.value;
     const color=Array.isArray(colorValue)?colorValue.map(String).join(', '):typeof colorValue==='string'?colorValue:'';
     if(!c.vendorCode||!color){issues.push(`${c.vendorCode||c.nmID}: нет артикула или цвета; исходная карточка сохранена`);continue;}
     const productId=randomUUID();const inserted=await tx.query('INSERT INTO products(id,article,name) VALUES($1,$2,$3) ON CONFLICT(article) DO NOTHING RETURNING id',[productId,c.vendorCode,c.title||c.vendorCode]);
     const product=(await tx.query('SELECT id FROM products WHERE article=$1',[c.vendorCode])).rows[0];
     if(inserted.rowCount)await audit(tx,r.user.id,'wb.product.import',product.id,null,{nmID:c.nmID,article:c.vendorCode});
     for(const size of c.sizes){
      if(size.skus.length!==1||! /^(?:\d{8}|\d{12,14})$/.test(size.skus[0])||!(size.wbSize||size.techSize)){issues.push(`${c.vendorCode} / ${size.techSize}: требуется проверка штрихкодов или размера`);continue;}
      const id=randomUUID(),gtin=size.skus[0],label=size.wbSize||size.techSize;
      const result=await tx.query('INSERT INTO variants(id,product_id,color,size,gtin) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',[id,product.id,color,label,gtin]);
      if(result.rowCount){await tx.query('INSERT INTO balances(variant_id) VALUES($1)',[id]);await audit(tx,r.user.id,'wb.variant.import',id,null,{nmID:c.nmID,chrtID:size.chrtID,gtin});created++;}
      else{const match=await tx.query('SELECT id FROM variants WHERE product_id=$1 AND color=$2 AND size=$3 AND gtin=$4',[product.id,color,label,gtin]);if(!match.rowCount)issues.push(`${c.vendorCode} / ${label}: конфликт с существующим вариантом; не перезаписан`);}
     }
    }
    const payload={cards:[...cards.values()],issues};
    await tx.query('INSERT INTO wb_snapshots(cache_key,payload,user_id) VALUES($1,$2,$3) ON CONFLICT(cache_key) DO UPDATE SET payload=EXCLUDED.payload,fetched_at=now(),user_id=EXCLUDED.user_id',[key,JSON.stringify(payload),r.user.id]);
    return {cards:cards.size,created,issues};
   });
  }finally{await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]);lock.release();}
 });
 app.get('/api/v1/wb/catalog',async()=>{
  const token=await getToken();if(!token)return {cards:[],issues:[],fetchedAt:null};
  const row=(await db.query('SELECT payload,fetched_at FROM wb_snapshots WHERE cache_key=$1',[keyFor(token)])).rows[0];
  return row?{...row.payload,fetchedAt:row.fetched_at}:{cards:[],issues:[],fetchedAt:null};
 });
}

