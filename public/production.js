export function productionView({api,app,heading,table,field,formEnd,bindForm,show,esc,state,exportLink}) {
 const stages={cut:'Крой',sewing:'Пошив',qc:'Контроль качества',packing:'Упаковка',ready:'Готово / склад',defect:'Брак'};
 const option=(id,label)=>`<option value="${esc(id)}">${esc(label)}</option>`;
 const select=(label,name,options)=>`<label>${label}<select name="${name}" required>${options}</select></label>`;
 const count=()=>field('Количество, шт.','quantity','1','number','min="1" max="1000000" step="1" required');
 const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
 const date=(label,name)=>field(label,name,today(),'date','required');
 const form=(id,title,content,button)=>`<form id="${id}" class="card stack"><h3>${title}</h3><div class="fields">${content}</div>${formEnd(button)}</form>`;
 return async()=>{
  const [variants,plans,cuts,workers,events]=await Promise.all(['/variants','/production/plans','/production/cuts','/production/workers','/production/events'].map(p=>api(p)));
  return()=>{
   app.innerHTML=heading('Производство',exportLink('production'))+`<p class="notice">План → крой → пошив → контроль → упаковка → готово. Только «Готово» увеличивает собственный склад; брак учитывается отдельно. Рекомендации по продажам WB пока не подключены.</p>`+
    form('prodPlan','План по цвету и размеру',select('Вариант','variantId',variants.map(v=>option(v.id,[v.article,v.color,v.size].join(' · '))).join(''))+count()+date('Срок готовности','dueDate')+field('Комментарий','comment'),'Создать план')+
    table(['План','Вариант','План, шт.','Выкроено','Осталось по плану','Срок'],plans.map(p=>`<tr><td>№${p.number}</td><td>${esc([p.article,p.color,p.size].join(' · '))}</td><td>${p.quantity}</td><td>${p.cut_quantity}</td><td>${Math.max(0,p.quantity-p.cut_quantity)}</td><td>${esc(String(p.due_date).slice(0,10))}</td></tr>`))+
    form('prodCut','Новый отдельный крой',select('План','planId',plans.map(p=>option(p.id,`№${p.number} · ${p.article} · ${p.color} · ${p.size}`)).join(''))+count()+date('Дата кроя','cutDate')+field('Общий расход ткани, кг','fabricKg','','text','required inputmode="decimal"')+field('Ответственный за крой','responsible','','text','required')+field('Причина превышения плана','reason')+field('Комментарий','comment'),'Зафиксировать крой')+
    `<div class="card"><h3>Партии кроя</h3>${table(['Крой / план','Вариант','Дата','Выкроено','Ткань кг / кг на изделие','Не выдано','Пошив','Контроль','Упаковка','Готово','Брак'],cuts.map(c=>`<tr><td>№${c.number} / №${c.plan_number}</td><td>${esc([c.article,c.color,c.size].join(' · '))}</td><td>${esc(String(c.cut_date).slice(0,10))}</td><td>${c.quantity}</td><td>${esc(c.fabric_kg)} / ${esc(c.fabric_per_unit)}</td>${['cut_remaining','sewing','qc','packing','ready','defect'].map(k=>`<td>${c[k]}</td>`).join('')}</tr>`))}</div>`+
    form('prodWorker','Добавить швею',field('Имя','name','','text','required'),'Добавить швею')+
    form('prodEvent','Передать изделия на следующий этап',select('Крой','cutId',cuts.map(c=>option(c.id,`№${c.number} · ${c.article} · ${c.color} · ${c.size}`)).join(''))+select('Операция','transition',[['cut:sewing','Выдать крой швее'],['sewing:qc','Принять пошив на контроль'],['qc:packing','Контроль пройден → упаковка'],['qc:defect','Выявлен брак'],['packing:ready','Упаковано → принять на наш склад']].map(([id,label])=>option(id,label)).join(''))+select('Швея (выдача / сдача пошива)','workerId',option('','Выберите швею')+workers.map(w=>option(w.id,w.name)).join(''))+count()+date('Дата операции','operationDate')+field('Причина брака / комментарий','reason'),'Подтвердить операцию')+
    `<div class="card"><h3>Остатки у швей по кроям</h3>${table(['Крой','Швея','Выдано','Сдано на контроль','Осталось'],cuts.flatMap(c=>workers.flatMap(w=>{const rows=events.filter(e=>e.cut_id===c.id&&e.worker_id===w.id);if(!rows.length)return [];const sum=stage=>rows.filter(e=>e.from_stage===stage).reduce((n,e)=>n+(e.reverses_id?-e.quantity:e.quantity),0);return [`<tr><td>№${c.number}</td><td>${esc(w.name)}</td><td>${sum('cut')}</td><td>${sum('sewing')}</td><td>${sum('cut')-sum('sewing')}</td></tr>`];})))}</div>`+
    `<div class="card"><h3>История производства</h3>${table(['№ / дата','Крой','Операция','Швея','Шт.','Автор','Причина',''],events.map(e=>`<tr><td>${e.number} / ${esc(String(e.operation_date).slice(0,10))}</td><td>№${e.cut_number}</td><td>${e.reverses_id?'Отмена: ':''}${stages[e.from_stage]} → ${stages[e.to_stage]}</td><td>${esc(e.worker)}</td><td>${e.quantity}</td><td>${esc(e.author)}</td><td>${esc(e.reason)}</td><td>${e.reversed_by?'Отменено':!e.reverses_id&&state.user.role==='owner'?`<button class="link" data-prod-reverse="${e.id}">Отменить</button>`:''}</td></tr>`))}</div><div id="prodReverse"></div>`;
   const save=path=>(body,key)=>api('/production/'+path,{method:'POST',body,key});
   const refresh=()=>show('production');
   bindForm('prodPlan',(b,k)=>save('plans')({...b,quantity:Number(b.quantity)},k),refresh);
   bindForm('prodCut',(b,k)=>save('cuts')({...b,quantity:Number(b.quantity),fabricKg:b.fabricKg.replace(',','.')},k),refresh);
   bindForm('prodWorker',save('workers'),refresh);
   const eventForm=document.getElementById('prodEvent');
   const toggle=()=>{const needed=['cut:sewing','sewing:qc'].includes(eventForm.elements.transition.value);eventForm.elements.workerId.disabled=!needed;eventForm.elements.workerId.required=needed;};eventForm.elements.transition.onchange=toggle;toggle();
   bindForm('prodEvent',(b,k)=>{const [fromStage,toStage]=b.transition.split(':');return save('events')({cutId:b.cutId,fromStage,toStage,quantity:Number(b.quantity),operationDate:b.operationDate,reason:b.reason,...(['cut','sewing'].includes(fromStage)?{workerId:b.workerId}:{})},k);},refresh);
   app.querySelectorAll('[data-prod-reverse]').forEach(button=>button.onclick=()=>{document.querySelector('#prodReverse').innerHTML=form('prodUndo','Отменить операцию',field('Причина','reason','','text','required minlength="3"'),'Подтвердить отмену');bindForm('prodUndo',save('events/'+button.dataset.prodReverse+'/reverse'),refresh);});
  };
 };
}
