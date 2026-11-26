const {readFile} = require('node:fs/promises');
const {Gauge} = require('prom-client');

const scopeName = /^(?:project-[0-9]+ \/ )?(?:(?:app|host):)?([A-Za-z0-9가-힣][A-Za-z0-9가-힣._ -]{0,99})$/u;
function validScope(scope) {
  if (typeof scope !== 'string' || scope.length > 160 || /[\r\n]/.test(scope)) return false;
  const match = scope.match(scopeName);
  return match && !['ai 브리핑', '앱 미지정'].includes(match[1].toLowerCase());
}
const maxAge = 30 * 3600;

function registerSupport(registry, read = () => readFile('/etc/customer-support/report.json', 'utf8'), clock = Date.now, api) {
  new Gauge({
    name: 'customer_support_threads', help: 'Unique inbound support threads with a leading app tag in the last seven days',
    labelNames: ['scope'], registers: [registry],
    async collect() {
      this.reset();
      if (api?.gmail.has('customer-support')) {
        const row = api.gmail.get('customer-support');
        const age = row && clock() - row.observed;
        if (row && age >= 0 && age <= 3 * 3600000) {
          for (const [scope, count] of Object.entries(row.counts)) this.set({scope}, count);
        }
        return;
      }
      let report;
      try { report = JSON.parse(await read()); } catch { return; }
      const now = Math.floor(clock() / 1000);
      if (!report || ![1, 2].includes(report.schemaVersion)) return;
      const scopes = report.schemaVersion === 1 ? ['policycock', 'Virtue'] : report.scopes;
      if (!Array.isArray(scopes) || !scopes.length || scopes.length > 512 ||
          !scopes.every(validScope) || new Set(scopes).size !== scopes.length ||
          !Number.isSafeInteger(report.observedAt) ||
          report.observedAt > now || now - report.observedAt > maxAge || !report.counts ||
          Array.isArray(report.counts) || Object.keys(report.counts).length !== scopes.length ||
          !scopes.every(scope => Object.hasOwn(report.counts, scope) && Number.isSafeInteger(report.counts[scope]) && report.counts[scope] >= 0)) return;
      for (const scope of scopes) this.set({scope}, report.counts[scope]);
    },
  });
}

module.exports = {registerSupport, validScope};
