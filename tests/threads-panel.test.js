const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const dashboard=require('../grafana/provisioning/dashboards/layer-customer.json');
function render(width,series=[],initialWidth=width){const context={grafana:{replaceVariables:()=>'.*'},panel:{data:{series},chart:{getWidth:()=>initialWidth,getHeight:()=>820}}};const option=vm.runInNewContext('(function(){'+dashboard.panels.find(p=>p.id===2).options.getOption+'})()',{context});return {...(option.baseOption||option),...option.media?.find(m=>(m.query.minWidth===undefined||width>=m.query.minWidth)&&(m.query.maxWidth===undefined||width<=m.query.maxWidth))?.option};}
test('both Threads handles remain visible without fabricated zero values when unconnected',()=>{
 for(const width of [340,1400]){const o=render(width),titles=o.title.filter(t=>/minimal_collector|_archivenoh/.test(t.text));assert.equal(titles.length,2);assert.ok(titles.every(t=>/연결 필요/.test(t.subtext)));assert.ok(titles.every(t=>!t.subtext.includes('0')));assert.ok(titles.every(t=>t.top+80<=820));}
});
test('verified measured zeros render and Threads accounts never become Instagram rows',()=>{
 const series=[{refId:'L',fields:[{type:'number',labels:{account:'_archivenoh',metric:'views'},values:[0]}]},{refId:'M',fields:[{type:'number',labels:{account:'_archivenoh'},values:[2]}]}];const o=render(1400,series);const title=o.title.find(t=>t.text==='@_archivenoh');assert.match(title.subtext,/프로필 조회 0회/);assert.doesNotMatch(o.title.find(t=>t.text.startsWith('Instagram')).subtext,/_archivenoh/);
});

test('resizing from desktop to mobile reflows accounts without waiting for data refresh',()=>{
 const o=render(340,[],1440),titles=o.title.filter(t=>/minimal_collector|_archivenoh/.test(t.text));
 assert.equal(titles[0].left,titles[1].left);assert.ok(titles[1].top-titles[0].top>=90);
});
