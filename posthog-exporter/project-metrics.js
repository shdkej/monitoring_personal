const {discover} = require('./inventory');
const {createSnapshotCache, collectSnapshot} = require('./calendar');
const {collectHealth} = require('./app-health');

const freshFor = 45 * 60 * 1000;
function projectMetrics(host, token, hogql) {
  let inventory;
  const snapshots = new Map();
  const refresh = createSnapshotCache(async () => {
    if (!inventory || Date.now() - inventory.at >= 60 * 60 * 1000) {
      try { inventory = {projects: await discover(host, token, hogql, inventory?.projects), at:Date.now()}; }
      catch (err) { if (!inventory) throw err; console.error('PostHog inventory refresh failed:', err.message); }
    }
    for (const project of inventory.projects) {
      if (!project.groups) continue;
      try {
        const [calendar, health] = await Promise.all([
          collectSnapshot(hogql, new Date(), project), collectHealth(hogql, Date.now(), project),
        ]);
        snapshots.set(project.id, {calendar, health});
      } catch (err) { console.error('PostHog project collection failed:', project.id, err.message); }
    }
    for (const id of snapshots.keys()) if (!inventory.projects.some(p => p.id === id)) snapshots.delete(id);
  });
  return {
    refresh: refresh.refresh,
    get projects() { return inventory?.projects.map(p=>p.id) ?? []; },
    get fresh() { return [...snapshots.values()].filter(s => Date.now() - s.health.observedAt <= freshFor); },
  };
}

// Preserve the existing product_* metrics and the historical lower-case Virtue
// label. Every observation now comes from the same app-scoped query as Grafana.
function registerActivity(client, register, source) {
  const metrics = [
    ['product_app_connected', 'Known PostHog app connection', () => 1],
    ['product_last_success_timestamp_seconds', 'Source observation time of the last successful PostHog app collection', (_r, _p, health) => health.observedAt / 1000],
    ['product_active_users','Unique pageview users over the last day or week', (r,p) => p==='1d'?r.activity.dau:r.activity.wau, ['1d','7d']],
    ['product_page_views','Pageviews over the last week',r=>r.activity.pageviews,['7d']],
    ['product_sessions','Identified sessions over the last week',r=>r.activity.sessions],
    ['product_churned_users','Previous week active users absent this week',r=>r.values.churned7d],
    ['product_retained_users','Users active both weeks',r=>r.activity.retained],
    ['product_retention_rate','Weekly retention percent',r=>r.values.retentionPercent],
    ['product_errors','Exceptions over the last week',r=>r.values.errors7d],
    ['product_web_vitals_lcp_ms','Observed p75 LCP',r=>r.values.lcpP75ms],
    ['product_web_vitals_inp_ms','Observed p75 INP',r=>r.values.inpP75ms],
    ['product_funnel_started_users','Distinct users starting the configured funnel',r=>r.activity.starts || undefined],
    ['product_conversions','Distinct converting users when there are starts',r=>r.activity.starts?r.activity.conversions:undefined],
    ['product_conversion_rate','Configured funnel conversion percent',r=>r.activity.starts?100*r.activity.conversions/r.activity.starts:undefined],
    ['product_funnel_dropoff_rate','Configured funnel drop-off percent',r=>r.activity.starts?100*(1-r.activity.conversions/r.activity.starts):undefined],
  ];
  for (const [name, help, value, periods] of metrics) {
    new client.Gauge({name,help,labelNames:periods?['service','period']:['service'],registers:[register],collect() {
      this.reset();
      const connected = new Set();
      for (const {health} of source.fresh) for (const row of health.rows) {
        const service = row.scope === 'Virtue' ? 'virtue' : row.scope;
        if (name === 'product_app_connected' && row.scope.endsWith('앱 미지정')) continue;
        connected.add(service);
        for (const period of periods || [null]) {
          const n=value(row, period, health);
          if (Number.isFinite(n)) this.set(period ? {service,period} : {service},n);
        }
      }
      if (name==='product_app_connected' && source.projects.length) {
        for (const service of ['blog','afzma']) if (!connected.has(service)) this.set({service},0);
      }
    }});
  }
}
module.exports = {projectMetrics,registerActivity};
