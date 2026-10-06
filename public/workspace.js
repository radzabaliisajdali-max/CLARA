export const menuGroups=[
 ['Рабочий день',['home']],['Товары',['products']],['Производство',['production']],
 ['Наш склад',['stock','receipt','movements']],['Wildberries',['fbs','returns']],
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
export function organizePage(page){
 if(page==='products')foldForm(document.querySelector('#product'),'＋ Добавить модель');
 if(page==='stock'){
  foldForm(document.querySelector('#stockOperation'),'＋ Операция: резерв или корректировка');
  foldForm(document.querySelector('#rebuild'),'Восстановление остатков');
 }
 if(page==='users')foldForm(document.querySelector('#newUser'),'＋ Добавить сотрудника');
}
export function organizeProduction(app,state){
 const forms=['prodPlan','prodCut','prodWorker','prodEvent'];
 const groups=[['plans','Планы'],['cuts','Крой'],['sewing','Швеи'],['transfer','Передача изделий'],['history','История']];
 const members={plans:[],cuts:[],sewing:[],transfer:[],history:[]};
 const plan=document.getElementById(forms[0]),cut=document.getElementById(forms[1]),worker=document.getElementById(forms[2]),event=document.getElementById(forms[3]);
 members.plans.push(plan,plan.nextElementSibling);
 members.cuts.push(cut,cut.nextElementSibling);
 members.sewing.push(worker,event.nextElementSibling);
 members.transfer.push(event);
 members.history.push(event.nextElementSibling.nextElementSibling,document.getElementById('prodReverse'));
 const tabs=document.createElement('div');tabs.className='workspace-tabs';tabs.setAttribute('aria-label','Разделы производства');
 app.querySelector('.notice').after(tabs);
 const select=key=>{state.productionTab=key;for(const [name,nodes] of Object.entries(members))nodes.forEach(n=>n.hidden=name!==key);tabs.querySelectorAll('button').forEach(b=>{b.classList.toggle('active',b.dataset.productionTab===key);b.setAttribute('aria-pressed',String(b.dataset.productionTab===key));});};
 for(const [key,label] of groups){const b=document.createElement('button');b.type='button';b.className='tab';b.dataset.productionTab=key;b.textContent=label;b.onclick=()=>select(key);tabs.append(b);}
 foldForm(plan,'＋ Создать план');foldForm(cut,'＋ Зафиксировать крой');foldForm(worker,'＋ Добавить швею');
 // The disclosure belongs to the same tab as its form.
 for(const key of ['plans','cuts','sewing'])members[key][0]=members[key][0].closest('details');
 select(state.productionTab??'plans');
}
