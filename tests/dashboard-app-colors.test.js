const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const overview = require('../grafana/provisioning/dashboards/main.json');
const customer = require('../grafana/provisioning/dashboards/layer-customer.json');
const product = require('../grafana/provisioning/dashboards/layer-product.json');
const business = require('../grafana/provisioning/dashboards/layer-business.json');

const colors = {
  policycock: '#5794F2', Virtue: '#B39DDB', blog: '#73BF69', afzma: '#FF9830',
  Infinity: '#56C8C8', 'miniapp-image-tools': '#F2CC0C',
};
const scoped = {...colors, 'shdkej.com': colors.blog, '앱 미지정': '#9CA3AF'};
const pmf = {'모두의정책': colors.policycock, Virtue: colors.Virtue};

function panel(board, id) {
  return board.panels.find(item => item.id === id);
}

function checkFields(board, ids, expected, suffix = '') {
  for (const id of ids) {
    const overrides = panel(board, id).fieldConfig.overrides;
    for (const [app, color] of Object.entries(expected)) {
      const field = app + suffix;
      const match = overrides.find(({matcher}) =>
        matcher.id === 'byName' ? matcher.options === field :
        matcher.id === 'byRegexp' && new RegExp(matcher.options.slice(1, -1)).test(field));
      assert.deepEqual(match?.properties.find(p => p.id === 'color')?.value,
        {mode: 'fixed', fixedColor: color}, board.uid + ' / ' + id + ' / ' + field);
    }
  }
}

function chart(id, series) {
  const context = {
    grafana: {replaceVariables: () => '.*'},
    panel: {data: {series}, chart: {getHeight: () => 820}},
  };
  return vm.runInNewContext('(function(){' + panel(customer, id).options.getOption + '})()', {context});
}

test('app-scoped values and legends keep the same colors across Grafana dashboards', () => {
  checkFields(overview, [1], pmf);
  checkFields(overview, [2, 3], scoped);
  checkFields(customer, [1, 3, 4, 6, 7, 8], scoped);
  checkFields(product, [2, 3, 7, 8], scoped);
  for (const suffix of [' · LCP', ' · INP']) checkFields(product, [4], scoped, suffix);
  checkFields(product, [5, 6], {Virtue: colors.Virtue});
  checkFields(business, [1, 2], pmf);
  checkFields(business, [8], {policycock: colors.policycock, virtue: colors.Virtue});
  for (const id of [3, 4, 5, 7]) {
    const app = panel(business, id).fieldConfig.overrides.find(o => o.matcher.options === '앱');
    const mapping = app.properties.find(p => p.id === 'mappings').value[0].options;
    for (const [name, color] of Object.entries(pmf)) assert.equal(mapping[name].color, color);
  }
});

test('GA4 channel lines use app colors and retain independent channel marks', () => {
  const refs = {A: 'blog', B: 'afzma', J: 'policycock', K: 'Virtue', N: 'miniapp-image-tools', O: 'Infinity'};
  const frames = Object.keys(refs).map(refId => ({refId, fields: [
    {type: 'time', values: [1]},
    ...['Direct', 'Organic Search'].map(displayName => ({type: 'number', config: {displayName}, values: [1]})),
  ]}));
  const lines = chart(2, frames).baseOption.series;
  for (const app of Object.values(refs)) {
    const direct = lines.find(line => line.name === app + ' · Direct');
    const search = lines.find(line => line.name === app + ' · Organic Search');
    for (const line of [direct, search]) {
      assert.equal(line.lineStyle.color, colors[app]);
      assert.equal(line.itemStyle.color, colors[app]);
    }
    assert.notEqual(direct.lineStyle.type, search.lineStyle.type);
    assert.notEqual(direct.symbol, search.symbol);
  }
  for (const title of chart(5, []).title) assert.equal(title.textStyle.color, colors[title.id]);
});
