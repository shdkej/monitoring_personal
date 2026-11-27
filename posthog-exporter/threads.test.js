const test = require('node:test');
const assert = require('node:assert/strict');
const {Registry} = require('prom-client');
const {readThreadsAccount, createThreads, ACCOUNTS} = require('./threads');
const now = Date.parse('2026-11-27T12:00:00Z');
const until = Math.floor(now / 86400000) * 86400 + 8*3600;
function fixture(account = 'minimal_collector') {
  return async (url, token) => {
    assert.equal(new URL(url).host, 'graph.threads.com');
    assert.equal(token, 'private-test-token');
    assert.ok(!url.includes(token));
    if (url.includes('/me?')) return {id:'123456789',username:account};
    const params=new URL(url).searchParams;
    const next = new URL(url);
    next.pathname = '/v1.0/987654321/threads_insights';
    next.searchParams.set('since', String(Number(params.get('until')) + 1));
    next.searchParams.set('until', String(Number(params.get('until')) + 86400));
    const paging = {next:next.href};
    if(params.get('metric')==='views') return {paging,data:[{name:'views',period:'day',values:Array.from({length:8},(_,i)=>({value:i,end_time:new Date((until-(7-i)*86400)*1000).toISOString()}))}]};
    assert.equal(Number(params.get('since')),until - 6*86400);
    assert.equal(Number(params.get('until')),until);
    return {paging,data:[
      {name:'views',period:'day',values:Array.from({length:7},(_,i)=>({value:i,end_time:new Date((until-(6-i)*86400)*1000).toISOString()}))},
      ...['likes','replies','reposts','quotes'].map(name=>({name,period:'day',total_value:{value:0}}))
    ]};
  };
}
test('Threads verifies the requested account, sums a complete seven-day view window and preserves measured zero', async()=>{
  const row=await readThreadsAccount('minimal_collector','private-test-token',now,fixture());
  assert.equal(row.account,'minimal_collector');
  assert.deepEqual(row.values,{views:21,likes:0,replies:0,reposts:0,quotes:0});
  assert.equal(row.periodEnd,'2026-11-27T08:00:00.000Z');
  assert.equal(row.periodStart,'2026-11-20T08:00:00.000Z');
  await assert.rejects(readThreadsAccount('_archivenoh','private-test-token',now,fixture()),/account mismatch/);
  await assert.rejects(readThreadsAccount('other','private-test-token',now,fixture()),/Unsupported/);
});
test('empty, partial, duplicate and invalid provider metrics never become zero counts', async()=>{
  for (const change of [d=>d.data=[],d=>d.data[0].values.pop(),d=>d.data[0].values[1]=d.data[0].values[0],d=>d.data[1].total_value.value=-1,d=>d.data.push(d.data[1]),d=>d.paging={next:'https://example.com/page2'}]) {
    const original=fixture();const get=async(url,token)=>{const d=await original(url,token);if(d.data && new URL(url).searchParams.get('metric')!=='views')change(d);return d};
    await assert.rejects(readThreadsAccount('minimal_collector','private-test-token',now,get));
  }
});
test('rejects paging that may contain more data in the requested interval', async()=>{
  for (const stage of ['views', 'views,likes,replies,reposts,quotes']) {
    for (const mutate of [
      (page, request) => page.searchParams.set('since', request.searchParams.get('until')),
      page => page.searchParams.set('after', 'next-cursor'),
      page => {page.pathname = '/another/endpoint';},
    ]) {
      const original = fixture();
      const get = async (url, token) => {
        const response = await original(url, token);
        const request = new URL(url);
        if (request.searchParams.get('metric') === stage) {
          const page = new URL(response.paging.next);
          mutate(page, request);
          response.paging.next = page.href;
        }
        return response;
      };
      await assert.rejects(readThreadsAccount('minimal_collector','private-test-token',now,get));
    }
  }
});

test('missing authentication exposes connection state, no metrics, and each account fails independently', async()=>{
  let time=now;const tokens=new Map();let fail=false;
  const registry=new Registry();
  const source=createThreads(registry,{clock:()=>time,readToken:async account=>tokens.get(account),readAccount:async account=>{if(fail&&account==='_archivenoh')throw Error('private-test-token');return {account,observedAt:new Date(time).toISOString(),periodEnd:new Date(until*1000).toISOString(),values:{views:0,likes:0,replies:0,reposts:0,quotes:0}}}});
  await source.refresh();
  const metric=async name=>(await registry.getSingleMetric(name).get()).values;
  assert.equal((await metric('threads_account_discovery')).length,0);
  assert.deepEqual((await metric('threads_account_connection')).map(x=>x.value),[0,0]);
  for(const a of ACCOUNTS)tokens.set(a,'private-test-token');
  await source.refresh();assert.equal((await metric('threads_account_discovery')).length,10);
  fail=true;time+=2*3600000;await source.refresh();assert.equal((await metric('threads_account_discovery')).length,10);
  time+=2*3600000;await source.refresh();
  assert.deepEqual([...new Set((await metric('threads_account_discovery')).map(x=>x.labels.account))],['minimal_collector']);
  tokens.delete('minimal_collector');await source.refresh();
  assert.equal((await metric('threads_account_discovery')).length,0);
  assert.doesNotMatch(await registry.metrics(),/private-test-token/);
});

test('source day discovery rejects sparse, duplicate, stale or unbounded windows', async()=>{
  for(const change of [d=>d.data[0].values.pop(), d=>d.data[0].values[1]=d.data[0].values[0], d=>d.data[0].values.forEach(x=>x.end_time='2026-01-01T08:00:00Z'), d=>d.data[0].values[7].end_time='2099-01-01T08:00:00Z']) {
    const original=fixture();
    const get=async(url,token)=>{const d=await original(url,token);if(new URL(url).searchParams.get('metric')==='views')change(d);return d};
    await assert.rejects(readThreadsAccount('minimal_collector','private-test-token',now,get));
  }
});
