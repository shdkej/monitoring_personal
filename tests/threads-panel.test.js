const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const dashboard=require('../grafana/provisioning/dashboards/layer-customer.json');
function render(width,series=[]){const context={grafana:{replaceVariables:()=>'.*'},panel:{data:{series},chart:{getWidth:()=>width,getHeight:()=>820}}};return vm.runInNewContext('(function(){'+dashboard.panels.find(p=>p.id===2).options.getOption+'})()',{context});}
test('both Threads handles remain visible without fabricated zero values when unconnected',()=>{
 for(const width of [340,1400]){const o=render(width),titles=o.title.filter(t=>/minimal_collector|_archivenoh/.test(t.text));assert.equal(titles.length,2);assert.ok(titles.every(t=>/연결 필요/.test(t.subtext)));assert.ok(titles.every(t=>!t.subtext.includes('0')));assert.ok(titles.every(t=>t.top+80<=820));}
});
test('verified measured zeros render and Threads accounts never become Instagram rows',()=>{
 const series=[{refId:'L',fields:[{type:'number',labels:{account:'_archivenoh',metric:'views'},values:[0]}]},{refId:'M',fields:[{type:'number',labels:{account:'_archivenoh'},values:[2]}]}];const o=render(1400,series);const title=o.title.find(t=>t.text==='@_archivenoh');assert.match(title.subtext,/프로필 조회 0회/);assert.doesNotMatch(o.title.find(t=>t.text.startsWith('Instagram')).subtext,/_archivenoh/);
});
