const {readFile} = require('node:fs/promises');
const {Gauge} = require('prom-client');

const scopes = ['policycock', 'Virtue'];
const maxAge = 30 * 3600;

function registerSupport(registry, read = () => readFile('/etc/customer-support/report.json', 'utf8'), clock = Date.now) {
  new Gauge({
    name: 'customer_support_threads', help: 'Unique inbound support threads with a leading app tag in the last seven days',
    labelNames: ['scope'], registers: [registry],
    async collect() {
      this.reset();
      let report;
      try { report = JSON.parse(await read()); } catch { return; }
      const now = Math.floor(clock() / 1000);
      if (report?.schemaVersion !== 1 || !Number.isSafeInteger(report.observedAt) ||
          report.observedAt > now || now - report.observedAt > maxAge || !report.counts ||
          !scopes.every(scope => Number.isSafeInteger(report.counts[scope]) && report.counts[scope] >= 0)) return;
      for (const scope of scopes) this.set({scope}, report.counts[scope]);
    },
  });
}

module.exports = {registerSupport};
