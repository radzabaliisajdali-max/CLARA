import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { database } from './helpers.js';
import { buildApp } from '../src/app.js';
const env=process.env.UI_URL?null:await database(55440);
const app=env?await buildApp(env.db,{origin:'http://127.0.0.1:3008'}):null;
if(app)await app.listen({host:'127.0.0.1',port:3008});
const browser=process.env.CDP_URL?await chromium.connectOverCDP(process.env.CDP_URL):await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});const page=await context.newPage();
const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto(process.env.UI_URL??'http://127.0.0.1:3008');
 await page.getByLabel('Логин',{exact:true}).fill('owner');await page.getByLabel('Пароль',{exact:true}).fill('test-password-12345');await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('button',{name:'Открыть товары',exact:true}).click();
 await page.locator('#product [name=article]').fill('UI-01');await page.locator('#product [name=name]').fill('Платье');await page.getByRole('button',{name:'Добавить модель',exact:true}).click();
 await page.getByRole('row').filter({hasText:'UI-01'}).getByRole('button',{name:'Открыть',exact:true}).click();
 await page.locator('#variant [name=color]').fill('Чёрный');await page.locator('#variant [name=size]').fill('52');await page.locator('#variant [name=gtin]').fill('0123456789001');await page.locator('#variant [name=cost]').fill('225,00');await page.getByRole('button',{name:'Сохранить вариант',exact:true}).click();
 await page.locator('#variant').waitFor({state:'detached'});await page.locator('nav [data-page=receipt]').click();await page.locator('#gtin').fill('99999999');await page.locator('#gtin').press('Enter');await page.locator('#scanError').filter({hasText:'Неизвестный GTIN'}).waitFor();
 for(let i=0;i<2;i++){await page.locator('#gtin').fill('0123456789001');await page.locator('#gtin').press('Enter');await page.waitForFunction(n=>document.querySelector<HTMLInputElement>('[data-qty]')?.value===String(n),i+1);}
 await page.locator('[data-qty]').fill('20');
 // Commit on the server, then lose the response. Retry must use the same key.
 let intercepted=false;await page.route('**/api/v1/receipts',async route=>{if(!intercepted){intercepted=true;await route.fetch();await route.abort('failed');}else await route.continue();});
 await page.getByRole('button',{name:'Подтвердить приёмку',exact:true}).click();await page.locator('#receipt .error').filter({hasText:'Нет связи'}).waitFor();assert.equal(await page.locator('[data-qty]').inputValue(),'20');
 await page.getByRole('button',{name:'Подтвердить приёмку',exact:true}).click();await page.locator('#receiptResult').filter({hasText:'проведена'}).waitFor();
 await page.locator('nav [data-page=stock]').click();await page.locator('#stockOperation').waitFor();
 const row=page.locator('tbody tr').filter({hasText:'UI-01'});assert.equal(await row.locator('td').nth(4).textContent(),'20');
 await page.locator('#stockOperation [name=quantity]').fill('5');await page.getByRole('button',{name:'Провести операцию',exact:true}).click();await page.waitForFunction(()=>document.querySelector('tbody tr td:nth-child(6)')?.textContent==='5');
 assert.equal(await row.locator('td').nth(4).textContent(),'20');assert.equal(await row.locator('td').nth(6).textContent(),'15');
 await page.reload();await page.getByRole('button',{name:'Открыть товары',exact:true}).waitFor();await page.locator('nav [data-page=stock]').click();await page.locator('#stockOperation').waitFor();assert.equal(await row.locator('td').nth(6).textContent(),'15');
 const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Скачать Excel'}).click();const download=await downloadPromise;assert.match(download.suggestedFilename(),/\.xlsx$/);
 await mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/warehouse.png',fullPage:true});
 await page.locator('nav [data-page=production]').click();
 await page.locator('#prodPlan [name=quantity]').fill('10');await page.locator('#prodPlan [type=submit]').click();
 await page.locator('#prodCut [name=planId] option').waitFor();
 await page.locator('#prodCut [name=quantity]').fill('10');await page.locator('#prodCut [name=fabricKg]').fill('3,5');await page.locator('#prodCut [name=responsible]').fill('Закройщик');await page.locator('#prodCut [type=submit]').click();
 await page.locator('#prodEvent [name=cutId] option').waitFor();
 await page.locator('#prodWorker [name=name]').fill('Анна');await page.locator('#prodWorker [type=submit]').click();
 await page.locator('#prodEvent [name=workerId] option').filter({hasText:'Анна'}).waitFor();
 for(const [transition,n] of [['cut:sewing',10],['sewing:qc',10],['qc:packing',10],['packing:ready',10]] as const){
  await page.locator('#prodEvent [name=transition]').selectOption(transition);
  if(transition==='cut:sewing'||transition==='sewing:qc')await page.locator('#prodEvent [name=workerId]').selectOption({label:'Анна'});
  await page.locator('#prodEvent [name=quantity]').fill(String(n));
  const response=page.waitForResponse(r=>r.url().endsWith('/production/events')&&r.request().method()==='POST');
  await page.locator('#prodEvent [type=submit]').click();assert.equal((await response).status(),200);
  await page.waitForFunction(()=>document.querySelector<HTMLSelectElement>('#prodEvent [name=transition]')?.value==='cut:sewing'&&!document.querySelector<HTMLButtonElement>('#prodEvent [type=submit]')?.disabled);
 }
 await page.screenshot({path:'test-results/production.png',fullPage:true});
 await page.locator('nav [data-page=stock]').click();await page.locator('#stockOperation').waitFor();assert.equal(await row.locator('td').nth(4).textContent(),'30');assert.equal(await row.locator('td').nth(6).textContent(),'25');
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);console.log('UI PASS: вход, модель, GTIN, повторный скан, потеря ответа, идемпотентный повтор, резерв, перезагрузка, Excel, план → крой → пошив → контроль → упаковка → склад; ошибок JS нет');
}finally{await context.close();await browser.close();if(app)await app.close();if(env)await env.stop();}
