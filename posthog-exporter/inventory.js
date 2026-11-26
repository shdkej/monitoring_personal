const {PROJECT, scopes} = require('./calendar');

// Only aggregate app IDs or owned hostnames become private Prometheus labels.
// Do not turn arbitrary event properties, visitor URLs or external hosts into labels.
function projectScopes(project, rows) {
  if (!Array.isArray(rows) || rows.length > 200) throw Error('Unexpected PostHog app inventory');
  const shared = project === PROJECT;
  const known = shared ? scopes.slice(0, -1) : [];
  const added = new Map();
  for (const [app, host] of rows) {
    if (typeof app === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(app)) {
      if (!known.some(s => s.appId === app)) added.set('id:'+app, {name: shared && ['blog', 'afzma'].includes(app) ? app : 'app:'+app, appId:app});
    } else if (!app && typeof host === 'string' && /^(?:[a-z0-9-]+\.)+shdkej\.com$/.test(host) && host.length <= 100) {
      if (!known.some(s => s.hosts?.includes(host))) added.set('host:'+host, {name:'host:'+host, hosts:[host]});
    }
  }
  const groups = [...known, ...[...added.keys()].sort().map(k=>added.get(k)), {name:'앱 미지정'}];
  if (!shared) for (const s of groups) s.name = 'project-'+project+' / '+s.name;
  return groups;
}

async function discover(base, token, hogql, previous = [], request = fetch) {
  const endpoint = new URL('/api/projects/', base);
  let next = endpoint.href;
  const ids = new Set();
  while (next) {
    const url = new URL(next, endpoint);
    if (url.origin !== endpoint.origin || url.pathname !== endpoint.pathname) throw Error('Invalid PostHog pagination');
    const r = await request(url, {headers:{Authorization:'Bearer '+token}, redirect:'error', signal:AbortSignal.timeout(15000)});
    if (!r.ok) throw Error('PostHog inventory HTTP '+r.status);
    const page = await r.json();
    for (const p of page.results) {
      const id = String(p.id);
      if (!/^\d+$/.test(id) || ids.has(id)) throw Error('Invalid PostHog project inventory');
      ids.add(id);
    }
    next = page.next;
  }
  if (!ids.has(PROJECT)) throw Error('Shared PostHog project missing from inventory');
  const projects = [];
  for (const id of ids) {
    let groups;
    try {
      const rows = await hogql(id, `SELECT properties.app_id,
        if(properties.app_id IS NULL AND endsWith(coalesce(toString(properties.$host), ''), '.shdkej.com'), properties.$host, NULL)
        FROM events WHERE coalesce(properties.traffic_kind, '') != 'synthetic'
        AND timestamp >= now() - interval 120 day GROUP BY 1, 2 LIMIT 201`);
      groups = projectScopes(id, rows);
    } catch (error) {
      console.error('PostHog app inventory unavailable:', id, error.message);
      groups = previous.find(p => p.id === id)?.groups;
      // Known scopes can be queried independently of inventory permissions.
      if (!groups && id === PROJECT) groups = scopes;
    }
    projects.push({id, groups, privateScope:true});

  }
  return projects;
}

module.exports = {discover, projectScopes};
