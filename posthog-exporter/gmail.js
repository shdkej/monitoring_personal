const {execFile} = require('node:child_process');
const {mkdtemp, readFile, rm} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {promisify} = require('node:util');
const {setTimeout: delay} = require('node:timers/promises');
const {OAuth2Client} = require('google-auth-library');
const {validScope} = require('./support');

const run = promisify(execFile);
const readScope = 'https://www.googleapis.com/auth/gmail.readonly';
const secret = '/etc/analytics-gmail';
const families = ['ga4_app_rolling7d_count', 'posthog_app_calendar_count'];
const prometheus = 'http://kube-prometheus-stack-prometheus.monitoring.svc:9090/api/v1/query';
let runtime;

async function prepareGog() {
  if (runtime) return runtime;
  const dir = await mkdtemp(join(tmpdir(), 'gog-support-'));
  try {
    await run('/bin/sh', [join(__dirname, 'install-gog.sh')], {
      cwd: dir, env: {PATH: '/usr/bin:/bin'}, timeout: 120000,
    });
    runtime = {dir, bin: join(dir, 'gog')};
    return runtime;
  } catch {
    await rm(dir, {recursive: true, force: true});
    throw new Error('gog install failed');
  }
}

function validateGrant(scopes, mode) {
  if (!Array.isArray(scopes)) throw new Error('Missing Gmail scopes');
  const isReadable = [readScope, 'https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/']
    .some(scope => scopes.includes(scope));
  if (mode === 'existing-gog' && isReadable) return;
  const allowed = new Set([readScope, 'openid', 'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile']);
  if (mode !== 'readonly' || !scopes.includes(readScope) || !scopes.every(scope => allowed.has(scope)))
    throw new Error('Gmail grant does not match collector permissions');
}

async function authorize(account) {
  const credentials = JSON.parse(await readFile(join(secret, 'credentials.json'), 'utf8'));
  const {type, client_id, client_secret, refresh_token} = credentials;
  if (type !== 'authorized_user' || !client_id || !client_secret || !refresh_token)
    throw new Error('Invalid Gmail credential');
  const client = new OAuth2Client({clientId: client_id, clientSecret: client_secret, transporterOptions: {timeout: 20000}});
  client.setCredentials({refresh_token});
  const {token} = await client.getAccessToken();
  if (!token) throw new Error('Missing Gmail access token');
  const info = await client.getTokenInfo(token);
  let mode;
  try { mode = (await readFile(join(secret, 'grant-mode'), 'utf8')).trim(); }
  catch (err) { if (err.code !== 'ENOENT') throw err; mode = 'readonly'; }
  validateGrant(info.scopes, mode);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress', {
    headers: {Authorization: 'Bearer ' + token}, redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  if (!res.ok || (await res.json()).emailAddress?.toLowerCase() !== account.toLowerCase())
    throw new Error('Unexpected Gmail account');
  return token;
}

async function registeredScopes() {
  const q = 'group by (__name__,scope) (last_over_time({__name__=~"' + families.join('|') + '"}[15m]))';
  const res = await fetch(prometheus + '?' + new URLSearchParams({query: q}), {
    signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  if (!res.ok) throw new Error('App inventory unavailable');
  const report = await res.json();
  if (report.status !== 'success' || report.warnings?.length || report.data?.resultType !== 'vector')
    throw new Error('Incomplete app inventory');
  const sources = new Set();
  const scopes = new Set();
  for (const {metric} of report.data.result) {
    const {scope, __name__: family} = metric;
    if (!families.includes(family) || typeof scope !== 'string') throw new Error('Invalid app inventory');
    if (scope.split(' / ').at(-1) === '앱 미지정' || /^(?:project-\d+ \/ )?(?:(?:host|app):)?ai 브리핑$/i.test(scope)) continue;
    if (!validScope(scope)) throw new Error('Invalid app label');
    sources.add(family);
    scopes.add(scope);
  }
  if (sources.size !== families.length || !scopes.size || scopes.size > 512) throw new Error('Incomplete app inventory');
  return [...scopes].sort();
}

function tagsFor(scopes) {
  const canonical = new Map();
  const candidates = new Map();
  function add(tag, scope) {
    const key = tag.toLowerCase();
    candidates.set(key, candidates.has(key) && candidates.get(key) !== scope ? null : scope);
  }
  for (const scope of scopes) {
    const key = scope.toLowerCase();
    if (canonical.has(key)) throw new Error('Ambiguous app name');
    canonical.set(key, scope);
    const app = scope.split(' / ').at(-1);
    const short = app.replace(/^(app|host):/, '');
    add(app, scope);
    add(short, scope);
    if (app.startsWith('host:')) add(short.split('.')[0], scope);
    if (scope === 'policycock') add('모두의정책', scope);
  }
  for (const [key, scope] of canonical) candidates.set(key, scope);
  return new Map([...candidates].filter(([, scope]) => scope !== null));
}

function* queries(account, end, tags) {
  const base = `after:${end - 7*86400} before:${end} {to:${account} deliveredto:${account}} -in:spam -in:trash -in:drafts -in:sent `;
  let terms = [];
  let length = 0;
  for (const tag of tags.keys()) {
    const term = 'subject:"' + tag + '"';
    if (length + term.length > 1200 && terms.length) {
      yield base + '{' + terms.join(' ') + '}';
      terms = []; length = 0;
    }
    terms.push(term);
    length += term.length + 1;
  }
  if (terms.length) yield base + '{' + terms.join(' ') + '}';
}

async function countQueries(account, now, scopes, search) {
  const tags = tagsFor(scopes);
  const threads = new Map(scopes.map(scope => [scope, new Set()]));
  for (const q of queries(account, Math.floor(now / 1000), tags)) {
    let pageToken = '';
    const seen = new Set();
    do {
      const page = await search(q, pageToken);
      if (!Array.isArray(page.messages) || page.messages.length !== page.count ||
          typeof page.has_more !== 'boolean' || page.has_more !== Boolean(page.nextPageToken))
        throw new Error('Incomplete Gmail result');
      for (const {subject, threadId} of page.messages) {
        if (typeof subject !== 'string' || !threadId || typeof threadId !== 'string')
          throw new Error('Invalid Gmail metadata');
        const match = /^\[([^\[\]\r\n]{1,160})\]/u.exec(subject);
        if (!match || /\[AI\s+브리핑\]/iu.test(subject)) continue;
        const scope = tags.get(match[1].toLowerCase());
        if (scope) threads.get(scope).add(threadId);
      }
      pageToken = page.nextPageToken;
      if (pageToken && (typeof pageToken !== 'string' || seen.has(pageToken))) throw new Error('Invalid Gmail pagination');
      seen.add(pageToken);
    } while (pageToken);
  }
  return {observed: now, counts: Object.fromEntries([...threads].map(([scope, ids]) => [scope, ids.size]))};
}

async function readGmail(now) {
  const account = (await readFile(join(secret, 'account'), 'utf8')).trim();
  if (!/^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+$/.test(account)) throw new Error('Invalid support account');
  // After a rollout the app families may need one Prometheus scrape to appear.
  let scopes;
  for (let attempt = 0; ; attempt++) {
    try { scopes = await registeredScopes(); break; } catch (err) {
      if (attempt >= 6) throw err;
      await delay(60000);
    }
  }
  const {bin, dir} = await prepareGog();
  const token = await authorize(account);
  return countQueries(account, now, scopes, async (q, pageToken) => {
    const args = ['--enable-commands-exact=gmail.messages.search', '--readonly', '--gmail-no-send', '--no-input', '--json', '--account', account,
      'gmail', 'messages', 'search', q, '--max', '100'];
    if (pageToken) args.push('--page', pageToken);
    try {
      const {stdout} = await run(bin, args, {env: {GOG_HOME: dir, HOME: dir, GOG_ACCESS_TOKEN: token},
        timeout: 120000, maxBuffer: 8*1024*1024});
      return JSON.parse(stdout);
    } catch {
      // Child errors may include queries, Gmail metadata, or raw API diagnostics.
      throw new Error('Gmail search failed');
    }
  });
}

module.exports = {readGmail, tagsFor, countQueries, validateGrant};
