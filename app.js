const KEY="clara_v1";let s=JSON.parse(localStorage.getItem(KEY)||"null")||{
products:INITIAL_PRODUCTS,batches:[],shipments:[],settings:{spp:.2578,commission:.435,acq:.04,ads:.05,tax:.06,buyout:.60,logistics:.25,returnLogistics:50}};
function save(){localStorage.setItem(KEY,JSON.stringify(s))}
function money(x){return Math.round(x||0).toLocaleString("ru-RU")+" ₽"}
function pc(x){return ((x||0)*100).toFixed(1)+"%"}
function p(a){return s.products.find(x=>x.article===a)}
function show(page){
const titles={home:"Главная",products:"Товары",production:"Производство",warehouse:"Склад",wb:"Wildberries",unit:"Юнит-экономика",reports:"Отчёты",settings:"Настройки"};
document.getElementById("title").textContent=titles[page];
({home,products,production,warehouse,wb,unit,reports,settings}[page])();save()}
function home(){
let made=s.batches.reduce((a,b)=>a+b.qty,0),sent=s.shipments.reduce((a,b)=>a+b.qty,0);
document.getElementById("app").innerHTML=`<div class=grid>
<div class=card><small>Артикулов</small><div class=num>${s.products.length}</div></div>
<div class=card><small>Произведено</small><div class=num>${made} шт.</div></div>
<div class=card><small>Отправлено в WB</small><div class=num>${sent} шт.</div></div>
<div class=card><small>Остаток внутреннего склада</small><div class=num>${Math.max(0,made-sent)} шт.</div></div></div>
<div class=card style="margin-top:20px"><b>Контроль</b><p class=note>Базовый СПП ${pc(s.settings.spp)}. Комиссия ${pc(s.settings.commission)}. ДРР ${pc(s.settings.ads)}. Эти параметры можно изменить в «Настройки».</p></div>`}
function products(){
let rows=s.products.map(x=>`<tr><td>${x.article}</td><td>${x.name}</td><td>${money(x.cost)}</td><td>${money(x.price)}</td><td>${x.discount||0}%</td></tr>`).join("");
document.getElementById("app").innerHTML=`<div style="margin-bottom:12px"><button class=btn onclick=addProduct()>+ Добавить товар</button></div>
<table><tr><th>Артикул</th><th>Товар</th><th>Себестоимость</th><th>Цена</th><th>Скидка</th></tr>${rows}</table>`}
function addProduct(){
document.getElementById("app").innerHTML=`<div class=card><h2>Новый товар</h2><div class=form>
<div class=field><label>Артикул</label><input id=a></div><div class=field><label>Название</label><input id=n></div>
<div class=field><label>Себестоимость</label><input id=c type=number></div><div class=field><label>Цена</label><input id=pr type=number></div>
<div class=field><label>Скидка %</label><input id=d type=number></div></div><p><button class=btn onclick=saveProduct()>Сохранить</button></p></div>`}
function saveProduct(){s.products.push({article:a.value,name:n.value,cost:+c.value||0,price:+pr.value||0,discount:+d.value||0});show("products")}
function production(){
let rows=s.batches.map(b=>`<tr><td>${b.date}</td><td>${b.article}</td><td>${b.qty}</td><td>${b.sizes||""}</td></tr>`).join("");
document.getElementById("app").innerHTML=`<div class=card><h2>Новая партия</h2><div class=form>
<div class=field><label>Товар</label><select id=ba>${s.products.map(x=>`<option>${x.article}</option>`).join("")}</select></div>
<div class=field><label>Количество</label><input id=bq type=number></div><div class=field><label>Размерный ряд</label><input id=bs placeholder="48:10; 50:10; 52:10"></div></div>
<p><button class="btn" onclick=createBatch()>Завершить производство</button></p><small>После завершения партия попадает во внутренний склад.</small></div>
<div style="margin-top:20px"><table><tr><th>Дата</th><th>Артикул</th><th>Количество</th><th>Размеры</th></tr>${rows||"<tr><td colspan=4>Пока партий нет</td></tr>"}</table></div>`}
function createBatch(){let q=+bq.value;if(q<=0)return alert("Укажите количество");s.batches.push({date:new Date().toLocaleDateString("ru-RU"),article:ba.value,qty:q,sizes:bs.value});show("production")}
function warehouse(){document.getElementById("app").innerHTML=`<div class=grid>
<div class=card><small>Произведено</small><div class=num>${s.batches.reduce((a,b)=>a+b.qty,0)}</div></div>
<div class=card><small>Отправлено</small><div class=num>${s.shipments.reduce((a,b)=>a+b.qty,0)}</div></div>
<div class=card><small>Продажи</small><div class=num>0</div></div><div class=card><small>Возвраты</small><div class=num>0</div></div></div>
<div class=card style="margin-top:20px"><p class=note>Пока склад ведётся внутри CLARA. После подключения WB API продажи, возвраты и остатки WB будут синхронизироваться автоматически.</p></div>`}
function wb(){document.getElementById("app").innerHTML=`<div class=card><h2>Wildberries</h2><p>Статус: API не подключён.</p><p class=note>В следующем этапе подключаем серверный модуль WB API. Токен WB не вставлять в код браузера.</p></div>`}
function unit(){
let rows=s.products.map(x=>{let buyer=x.price*(1-(x.discount||0)/100)*(1-s.settings.spp),kvv=buyer*(x.commission||s.settings.commission),acq=buyer*s.settings.acq,ads=buyer*s.settings.ads,tax=buyer*s.settings.tax,log=buyer*s.settings.logistics/s.settings.buyout+(1-s.settings.buyout)/s.settings.buyout*s.settings.returnLogistics,pr=buyer-kvv-acq-ads-tax-log-x.cost,cls=pr>=0?"ok":"bad";return `<tr><td>${x.article}</td><td>${x.name}</td><td>${money(x.cost)}</td><td>${money(buyer)}</td><td class=${cls}>${money(pr)}</td><td>${pc(buyer?pr/buyer:0)}</td></tr>`}).join("");
document.getElementById("app").innerHTML=`<p class=note>Расчёт: СПП ${pc(s.settings.spp)}, КВВ ${pc(s.settings.commission)}, эквайринг ${pc(s.settings.acq)}, ДРР ${pc(s.settings.ads)}, налог ${pc(s.settings.tax)}, выкуп ${pc(s.settings.buyout)}.</p><table><tr><th>Артикул</th><th>Товар</th><th>Себестоимость</th><th>Цена покупателя</th><th>Чистая прибыль</th><th>Маржа</th></tr>${rows}</table>`}
function reports(){document.getElementById("app").innerHTML=`<div class=card><h2>Отчёты</h2><p>V1: производство, склад и юнит-экономика. Далее добавим недельные/месячные отчёты WB и рекомендации по производству.</p></div>`}
function settings(){
let x=s.settings;
document.getElementById("app").innerHTML=`<div class=card><h2>Настройки</h2><div class=form>
<div class=field><label>СПП %</label><input id=i_spp type=number step=.1 value=${x.spp*100}></div>
<div class=field><label>Комиссия %</label><input id=i_comm type=number step=.1 value=${x.commission*100}></div>
<div class=field><label>Эквайринг %</label><input id=i_acq type=number step=.1 value=${x.acq*100}></div>
<div class=field><label>ДРР %</label><input id=i_ads type=number step=.1 value=${x.ads*100}></div>
<div class=field><label>Налог %</label><input id=i_tax type=number step=.1 value=${x.tax*100}></div>
<div class=field><label>Выкуп %</label><input id=i_buy type=number step=.1 value=${x.buyout*100}></div>
<div class=field><label>Логистика %</label><input id=i_log type=number step=.1 value=${x.logistics*100}></div>
<div class=field><label>Возвратная логистика ₽</label><input id=i_ret type=number value=${x.returnLogistics}></div>
</div><p><button class=btn onclick=saveSettings()>Сохранить</button></p></div>`}
function saveSettings(){s.settings.spp=+i_spp.value/100;s.settings.commission=+i_comm.value/100;s.settings.acq=+i_acq.value/100;s.settings.ads=+i_ads.value/100;s.settings.tax=+i_tax.value/100;s.settings.buyout=+i_buy.value/100;s.settings.logistics=+i_log.value/100;s.settings.returnLogistics=+i_ret.value;show("settings")}
show("home");