export const menuGroups=[
 ['Рабочий день',['home']],['Товары',['products']],['Производство',['production']],
 ['Наш склад',['stock','receipt','reservations','adjustments','movements','reconciliation']],['Wildberries',['fbs','returns']],
 ['Аналитика и рост',['analytics','ads','seo','competitors']],['Финансы',['finance']],
 ['Управление',['connections','users','audit','import']]
];
export function navigation(names,state,ownerPages){
 return menuGroups.map(([label,pages])=>{
  const visible=pages.filter(p=>state.user.role==='owner'||!ownerPages.includes(p));
  if(!visible.length)return '';
  if(visible.length===1){const p=visible[0];return `<div class="nav-group"><button data-page="${p}" class="${state.page===p?'active':''}" ${state.page===p?'aria-current="page"':''}>${label}</button></div>`;}
  return `<details class="nav-group" ${visible.includes(state.page)?'open':''}><summary>${label}</summary><div>${visible.map(p=>`<button data-page="${p}" class="${state.page===p?'active':''}" ${state.page===p?'aria-current="page"':''}>${names[p]}</button>`).join('')}</div></details>`;
 }).join('');
}
export function foldForm(form,label){
 if(!form||form.closest('details'))return;
 const detail=document.createElement('details');detail.className='form-disclosure';
 const summary=document.createElement('summary');summary.textContent=label;
 form.before(detail);detail.append(summary,form);
}
export function organizePage(page,state){
 if(page==='products')foldForm(document.querySelector('#product'),'＋ Добавить модель');
 if(['stock','reservations','adjustments','reconciliation'].includes(page)){
  const form=document.querySelector('#stockOperation'),rebuild=document.querySelector('#rebuild');
  if(page==='stock'||page==='reconciliation')form.remove();
  else {
   const adjustment=page==='adjustments';
   form.querySelector('h3').textContent=adjustment?'Корректировка с указанием причины':'Резервирование и снятие резерва FBS';
   for(const option of [...form.elements.kind.options])if((option.value==='adjustments')!==adjustment)option.remove();
   for(const name of ['bucket','direction','reason'])form.elements[name].closest('label').hidden=!adjustment;
   if(adjustment){form.elements.kind.closest('label').hidden=true;form.elements.reason.required=true;form.elements.reason.minLength=3;}
   const label=()=>form.querySelector('[type=submit]').textContent=adjustment?'Провести корректировку':form.elements.kind.value==='releases'?'Снять резерв':'Зарезервировать';
   form.elements.kind.onchange=label;label();
  }
  if(rebuild){if(page!=='reconciliation')rebuild.parentElement.remove();else foldForm(rebuild,'Восстановить остатки из документов');}
 }
 if(page==='users')foldForm(document.querySelector('#newUser'),'＋ Добавить сотрудника');
}
export function organizeProduction(app,state){
 const forms=['prodPlan','prodCut','prodWorker','prodEvent'];
 const groups=[['plans','Планы'],['cuts','Крой'],['issue','Выдача в пошив'],['sewing','Приём пошива'],['qc','Контроль качества'],['packing','Выпуск на склад'],['workers','Швеи'],['history','История']];
 const members={plans:[],cuts:[],issue:[],sewing:[],qc:[],packing:[],workers:[],history:[]};
 const plan=document.getElementById(forms[0]),cut=document.getElementById(forms[1]),worker=document.getElementById(forms[2]),event=document.getElementById(forms[3]);
 members.plans.push(plan,plan.nextElementSibling);
 members.cuts.push(cut,cut.nextElementSibling);
 members.workers.push(worker,event.nextElementSibling);
 for(const key of ['issue','sewing','qc','packing'])members[key].push(event);
 members.history.push(event.nextElementSibling.nextElementSibling,document.getElementById('prodReverse'));
 const tabs=document.createElement('div');tabs.className='workspace-tabs';tabs.setAttribute('aria-label','Разделы производства');
 app.querySelector('.notice').after(tabs);
 const transitions=[...event.elements.transition.options].map(o=>[o.value,o.textContent]);
 const allowed={issue:['cut:sewing'],sewing:['sewing:qc'],qc:['qc:packing','qc:defect'],packing:['packing:ready']};
 const select=(key,update=true)=>{if(!members[key])key='plans';state.productionTab=key;
  for(const node of new Set(Object.values(members).flat()))node.hidden=!members[key].includes(node);
  if(allowed[key]){event.elements.transition.replaceChildren(...transitions.filter(([v])=>allowed[key].includes(v)).map(([v,label])=>new Option(label,v)));event.elements.transition.onchange();event.elements.transition.closest('label').hidden=key!=='qc';event.elements.workerId.closest('label').hidden=!['issue','sewing'].includes(key);event.querySelector('h3').textContent=groups.find(([v])=>v===key)[1];event.querySelector('[type=submit]').textContent=key==='issue'?'Передать швее':key==='sewing'?'Принять на контроль':key==='qc'?'Сохранить результат контроля':'Принять готовые изделия на склад';}
  tabs.querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b.dataset.productionTab===key);b.setAttribute('aria-pressed',String(b.dataset.productionTab===key));});if(update)state.updateAddress();};
 for(const [key,label] of groups){const b=document.createElement('button');b.type='button';b.className='tab';b.dataset.productionTab=key;b.textContent=label;b.onclick=()=>select(key);tabs.append(b);}
 foldForm(plan,'＋ Создать план');foldForm(cut,'＋ Зафиксировать крой');foldForm(worker,'＋ Добавить швею');
 // The disclosure belongs to the same tab as its form.
 for(const key of ['plans','cuts','workers'])members[key][0]=members[key][0].closest('details');
 select(state.productionTab??'plans',false);
}

