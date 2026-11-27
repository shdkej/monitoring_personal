const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => require('./pmf');
const at = value => Date.parse(value) / 1000;
const now = at('2026-11-27T03:00:00Z');
const row = (app, start, done = null, shared = 0) => [app, at(start), done ? at(done) : null, shared, 0, []];

test('activation rate uses only equally matured visitors, including early successes in pending', () => {
  const {aggregatePmf} = load();
  const report = aggregatePmf([
    row('policycock', '2026-11-25T03:00:00Z', '2026-11-25T04:00:00Z'),
    row('policycock', '2026-11-26T03:00:00Z', null, 1),
    row('policycock', '2026-11-27T02:00:00Z', '2026-11-27T02:05:00Z', 1),
  ], now);
  const summary = report.summary.find(r => r.service === 'policycock');
  assert.equal(summary.entrants, 3);
  assert.equal(summary.activated, 2);
  assert.equal(summary.activationNumerator, 1);
  assert.equal(summary.activationDenominator, 2);
  assert.equal(summary.activationPercent, 50);
  assert.equal(summary.activationSample, '1 / 2');
  assert.equal(summary.pending, 1);
  assert.equal(summary.reusePercent, null);
  assert.equal(summary.reuseSample, '— / —');
});

test('KST Monday splits cohorts without moving old entrants into the current week', () => {
  const {aggregatePmf} = load();
  const report = aggregatePmf([
    row('policycock', '2026-11-22T14:59:59Z', '2026-11-22T15:01:00Z'),
    row('policycock', '2026-11-22T15:00:00Z', '2026-11-22T15:01:00Z'),
    row('virtue', '2026-11-23T03:00:00Z', null),
  ], now);
  assert.equal(report.weekStart, '2026-11-23');
  assert.equal(report.summary.find(r => r.service === 'policycock').entrants, 1);
  const previous = report.cohorts.find(r => r.service === 'policycock' && r.weekStart === '2026-11-16');
  assert.equal(previous.entrants, 1);
  assert.equal(previous.activated, 1);
  assert.equal(report.summary.find(r => r.service === 'virtue').activationPercent, 0);
});

test('completion outside the 24h window or before entry is not activation', () => {
  const {aggregatePmf} = load();
  const report = aggregatePmf([
    row('policycock', '2026-11-24T01:00:00Z', '2026-11-25T01:00:00Z'),
    row('policycock', '2026-11-24T01:00:00Z', '2026-11-25T01:00:01Z'),
    row('policycock', '2026-11-24T01:00:00Z', '2026-11-24T00:59:59Z'),
  ], now);
  assert.equal(report.summary[0].activated, 1);
  assert.equal(report.summary[0].activationNumerator, 1);
  assert.equal(report.summary[0].activationDenominator, 3);
});

test('no sample and pending-only cohorts are not reported as zero conversion', () => {
  const {aggregatePmf} = load();
  const empty = aggregatePmf([], now).summary[0];
  assert.equal(empty.entrants, 0);
  assert.equal(empty.activationPercent, null);
  assert.equal(empty.activationSample, '0 / 0');
  const pending = aggregatePmf([row('policycock', '2026-11-27T02:00:00Z')], now).summary[0];
  assert.equal(pending.activationDenominator, 0);
  assert.equal(pending.pending, 1);
});

test('channel counts reconcile with cohort totals and unsupported apps are not fabricated', () => {
  const {aggregatePmf, selectPmf} = load();
  const report = aggregatePmf([
    row('policycock', '2026-11-24T01:00:00Z', '2026-11-24T02:00:00Z', 1),
    row('policycock', '2026-11-25T01:00:00Z'),
    row('virtue', '2026-11-24T01:00:00Z', '2026-11-24T02:00:00Z'),
  ], now);
  const policy = selectPmf(report, 'policycock');
  assert.deepEqual(policy.summary.map(r => r.service), ['policycock']);
  assert.equal(policy.channels.reduce((n, r) => n + r.entrants, 0), 2);
  assert.equal(policy.channels.reduce((n, r) => n + r.activationNumerator, 0), 1);
  assert.throws(() => selectPmf(report, 'blog'));
  assert.throws(() => selectPmf(report, '.*'));
});

test('invalid and truncated source responses fail instead of becoming zeros', () => {
  const {aggregatePmf} = load();
  for (const rows of [null, [['x', now - 100, null, 0]], [['policycock', NaN, null, 0]], [['policycock', now + 1, null, 0]], [['policycock', now - 10, null, 4]], new Array(50001).fill(row('policycock','2026-11-24T01:00:00Z'))]) {
    assert.throws(() => aggregatePmf(rows, now));
  }
});

test('PMF cache preserves last good data briefly and hides stale data after collection errors', async () => {
  const {createPmf} = load();
  let clock = now * 1000, fails = false;
  const source = createPmf(async () => {if (fails) throw Error('offline'); return [];}, () => clock);
  assert.equal(source.current, null);
  await source.refresh();
  assert.equal(source.current.summary[0].entrants, 0);
  fails = true; clock += 15 * 60 * 1000;
  await assert.rejects(source.refresh());
  assert.ok(source.current);
  clock += 31 * 60 * 1000;
  assert.equal(source.current, null);
});

test('reuse counts mature linked activations only and uses the following seven full days', () => {
  const {aggregatePmf} = load();
  const linked = (done, core) => ['policycock', at('2026-11-17T01:00:00Z'), at(done), 0, 1, core.map(at)];
  const report = aggregatePmf([
    linked('2026-11-17T02:00:00Z', ['2026-11-18T02:00:00Z']),
    linked('2026-11-17T02:00:00Z', ['2026-11-18T01:59:59Z','2026-11-25T02:00:00Z']),
    ['policycock', at('2026-11-26T01:00:00Z'), at('2026-11-26T02:00:00Z'), 0, 1, [at('2026-11-27T02:00:00Z')]],
    row('policycock','2026-11-17T01:00:00Z','2026-11-17T02:00:00Z'),
  ], now);
  const r = report.reuse[0];
  assert.equal(r.reuseNumerator, 1);
  assert.equal(r.reuseDenominator, 2);
  assert.equal(r.reusePercent, 50);
  assert.equal(r.reusePending, 1);
  assert.equal(r.unlinked, 1);
});
