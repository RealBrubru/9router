import { monitorEventLoopDelay, performance } from "node:perf_hooks";

function distribution(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    count: sorted.length, total: sorted.reduce((a, b) => a + b, 0),
    percentiles: [0.5, 0.95, 0.99].map(p => sorted[Math.ceil(sorted.length * p) - 1]),
  };
}

function collect(target, key, duration) {
  (target[key] ??= []).push(duration);
}

function summarize(source) {
  return Object.fromEntries(Object.entries(source).map(([key, values]) => [key, distribution(values)]));
}

function sqlLabel(sql) {
  const normalized = sql.replace(/\s+/g, " ");
  if (normalized.includes("quotaConnectionBindings")) return normalized.includes("LIMIT 2") ? "binding_candidates" : "binding_validation";
  if (/^select/i.test(normalized) && normalized.includes("inferenceAttemptEvents")) {
    if (normalized.includes("eventId =")) return "event_identity_or_readback";
    if (normalized.includes("kind = 'usage'")) return "latest_usage";
    if (normalized.includes("kind NOT IN")) return "latest_lifecycle";
    if (normalized.includes("AND version =")) return "previous_knowledge";
  }
  return normalized.match(/^(?:SELECT .*? FROM|INSERT INTO|UPDATE|DELETE FROM) (\w+)/i)?.[0]
    .replace(/^SELECT .*? FROM/i, "SELECT") ?? "transaction_control_or_other";
}

const stage = () => ({ repository: {}, transaction: {}, statements: {}, preparation: {} });

export function createAttemptProfiler(db) {
  let phase = "idle";
  let method;
  let tx;
  const phases = { warm: stage(), load: stage(), coverage: stage() };
  const delay = monitorEventLoopDelay({ resolution: 2 });
  let utilization;
  let loop = null;
  const batchDelays = [];
  const rawPrepare = db.raw.prepare;
  db.raw.prepare = function (sql, ...args) {
    const data = phases[phase];
    if (!data) return rawPrepare.call(this, sql, ...args);
    const start = performance.now();
    try { return rawPrepare.call(this, sql, ...args); }
    finally { collect(data.preparation, sqlLabel(sql), performance.now() - start); }
  };

  function repository(repo) {
    return Object.fromEntries(Object.entries(repo).map(([name, operation]) => [name, function (...args) {
      const data = phases[phase];
      if (!data) return operation(...args);
      const previous = method;
      method = name;
      const start = performance.now();
      try { return operation(...args); }
      finally {
        method = previous;
        collect(data.repository, name, performance.now() - start);
      }
    }]));
  }

  const adapter = {
    ...db,
    transaction(action) {
      const data = phases[phase];
      if (!data) return db.transaction(action);
      const span = { group: method ?? "other", dbMs: 0 };
      const previous = tx;
      tx = span;
      const started = performance.now();
      try {
        return db.transaction(() => {
          const start = performance.now();
          try { return action(); }
          finally { span.callback = performance.now() - start; }
        });
      } finally {
        const total = performance.now() - started;
        tx = previous;
        collect(data.transaction, span.group + "/total", total);
        if (span.callback != null) {
          collect(data.transaction, span.group + "/sql", span.dbMs);
          collect(data.transaction, span.group + "/callback_other", Math.max(0, span.callback - span.dbMs));
          collect(data.transaction, span.group + "/transaction_boundary", Math.max(0, total - span.callback));
        }
      }
    },
    ...Object.fromEntries(["get", "run", "all"].map(name => [
      name, (sql, params) => {
        const data = phases[phase];
        if (!data) return db[name](sql, params);
        const start = performance.now();
        try { return db[name](sql, params); }
        finally {
          const duration = performance.now() - start;
          if (tx) {
            if (method == null && /(?:FROM|INTO) usageHistory\b/i.test(sql)) tx.group = "analytics";
            tx.dbMs += duration;
          }
          collect(data.statements, (method ?? tx?.group ?? "gateway") + "/" + sqlLabel(sql), duration);
        }
      },
    ])),
  };

  return {
    adapter, repository,
    phase(value) { phase = value; },
    startLoad() {
      phase = "load";
      utilization = performance.eventLoopUtilization();
      delay.enable();
    },
    probeBatch() {
      const queuedAt = performance.now();
      return new Promise(resolve => setImmediate(() => {
        batchDelays.push(performance.now() - queuedAt);
        resolve();
      }));
    },
    stopLoad() {
      if (phase !== "load") return;
      delay.disable();
      phase = "idle";
      loop = { samples: delay.count, p95Ms: delay.percentile(95) / 1e6, p99Ms: delay.percentile(99) / 1e6,
        maxMs: delay.max / 1e6, utilization: performance.eventLoopUtilization(utilization).utilization,
        batchDelays: distribution(batchDelays), batchMaxMs: Math.max(...batchDelays) };
    },
    report() {
      return { loop, ...Object.fromEntries(Object.entries(phases).map(([name, groups]) => [
        name, Object.fromEntries(Object.entries(groups).map(([kind, values]) => [kind, summarize(values)])),
      ])) };
    },
  };
}
