const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Registry} = require('prom-client');
const {tagsFor, countQueries, validateGrant} = require('./gmail');
const {registerSupport} = require('./support');

const page = (messages, nextPageToken = '') => ({messages: messages.map(([subject, threadId]) => ({subject, threadId})),
  count: messages.length, has_more: Boolean(nextPageToken), nextPageToken});

test('read-only Gmail acquisition preserves inbound self-addressed messages and deduplicates across pages', async () => {
  const source = ['policycock', 'Virtue', 'app:foo'];
  const results = [page([['[모두의정책] One', 'a'], ['[virtue] [AI 브리핑] Two', 'b'],
    ['Re: [virtue] Three', 'c'], [' [Virtue] Four', 'd'], ['[foo] Five', 'e']], 'NEXT'),
  page([['[policycock] One', 'a'], ['[VIRTUE] Six', 'f']])];
  const row = await countQueries('support@example.org', 1700000000000, source, async (query, cursor) => {
    assert.match(query, /after:1699395200 before:1700000000/);
    assert.match(query, /\{to:support@example.org deliveredto:support@example.org\} -in:spam -in:trash -in:drafts -in:sent/);
    assert.doesNotMatch(query, /from:me|in:inbox/);
    assert.equal(cursor, results.length === 2 ? '' : 'NEXT');
    return results.shift();
  });
  assert.deepEqual(row.counts, {policycock:1, Virtue:1, 'app:foo':1});
  assert.equal(tagsFor(['project-1 / app:foo', 'project-2 / app:foo']).has('foo'), false);
  assert.equal(tagsFor(['foo','project-1 / app:foo']).get('foo'), 'foo');
  assert.throws(() => tagsFor(['Foo','foo']));
});

test('empty source is zero, incomplete pages and duplicate pagination tokens fail the snapshot', async () => {
  const count = read => countQueries('support@example.org', 1234000, ['blog'], read);
  assert.deepEqual((await count(async () => page([]))).counts, {blog:0});
  for (const batch of [{...page([]), count:1}, {...page([]), has_more:true}, page([], 'repeat')]) {
    await assert.rejects(count(async () => batch));
  }
});

test('direct collector honors expiry, omits stale or unavailable data, never reads a PC snapshot', async () => {
  let now = Date.now();
  const registry = new Registry();
  const gmail = new Map([['customer-support', null]]);
  const never = () => {throw Error('unexpected legacy read');};
  registerSupport(registry, never, () => now, {gmail});
  const metric = registry.getSingleMetric('customer_support_threads');
  assert.deepEqual((await metric.get()).values, []);
  gmail.set('customer-support', {observed:now, counts:{blog:0,policycock:4}});
  assert.deepEqual((await metric.get()).values.map(r=>r.value), [0,4]);
  now += 3 * 3600000 + 1;
  assert.deepEqual((await metric.get()).values, []);
});

test('shared gog credentials require explicit opt-in and actual Gmail read capability', () => {
  const shared = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/drive'];
  assert.doesNotThrow(() => validateGrant(shared, 'existing-gog'));
  assert.throws(() => validateGrant(shared, 'readonly'));
  assert.throws(() => validateGrant(shared.slice(1), 'existing-gog'));
  assert.throws(() => validateGrant(shared, 'typo'));
});
