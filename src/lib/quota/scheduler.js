const DAY_SECONDS = 86400;
const MINUTE_SECONDS = 60;
const RETRY_BASE_MS = 30_000;
const RETRY_CAP_MS = 300_000;
const CONFIGURATION_RETRY_MS = 900_000;

export function quotaDailyStart(seconds) {
  return Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
}

function jobsFor(organization) {
  const config = organization.config;
  const jobs = [
    { source: "usage", resolution: "1d", interval: config.usageIntervalMs, lookback: config.usageLookbackDays },
    { source: "costs", resolution: "1d", interval: config.costsIntervalMs, lookback: config.costsLookbackDays },
  ];
  if (config.minuteEnabled) {
    jobs.push({ source: "usage", resolution: "1m", interval: config.minuteIntervalMs, lookback: config.minuteLookback });
  }
  return jobs;
}

function windowFor(job, timestamp) {
  const end = Math.floor(timestamp / 1000);
  const start = job.resolution === "1d"
    ? quotaDailyStart(end) - job.lookback * DAY_SECONDS
    : (Math.floor(end / MINUTE_SECONDS) - job.lookback) * MINUTE_SECONDS;
  return { start: Math.max(0, start), end };
}

function delayAfterFailure(error, failures) {
  if (error?.code === "authorization" || error?.code === "configuration") return CONFIGURATION_RETRY_MS;
  const backoff = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (failures - 1));
  return Math.max(backoff, error?.retryAfterMs ?? 0);
}

export function createQuotaScheduler({
  repository, adapters, enabled = false, concurrency = 2, pollMs = 1000,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => {},
}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16 ||
      !Number.isSafeInteger(pollMs) || pollMs < 1) throw new TypeError("Invalid quota scheduler options");
  const active = new Map();
  const pendingSchedules = new Map();
  let controller = null;
  let timer = null;

  async function run(organization, job, previous, signal, window) {
    if (signal.aborted) return;
    let next;
    try {
      await repository.collect(organization.id, { source: job.source, resolution: job.resolution, ...window },
        adapters[organization.provider], { signal });
      next = { nextAt: now() + job.interval, failures: 0 };
    } catch (error) {
      if (signal.aborted) return;
      const failures = Math.min((previous?.failures ?? 0) + 1, 16);
      next = { nextAt: now() + delayAfterFailure(error, failures), failures };
    }
    if (!signal.aborted) {
      const key = JSON.stringify([organization.id, job.source, job.resolution]);
      pendingSchedules.set(key, { organizationId: organization.id, job, next });
      flushSchedules();
    }
  }

  function flushSchedules() {
    for (const [key, item] of pendingSchedules) {
      try {
        repository.writeSchedule(item.organizationId, item.job.source, item.job.resolution, item.next);
        pendingSchedules.delete(key);
      } catch {
        onError();
      }
    }
  }

  function tick() {
    if (!controller || controller.signal.aborted) return;
    flushSchedules();
    if (active.size >= concurrency) return;
    const timestamp = now();
    const candidates = [];
    for (const organization of repository.listOrganizations()) {
      if (!organization.enabled || !Object.hasOwn(adapters, organization.provider)) continue;
      for (const job of jobsFor(organization)) {
        const key = JSON.stringify([organization.id, job.source]);
        const scheduleKey = JSON.stringify([organization.id, job.source, job.resolution]);
        if (active.has(key) || pendingSchedules.has(scheduleKey)) continue;
        const previous = repository.readSchedule(organization.id, job.source, job.resolution);
        if (previous?.nextAt > timestamp) continue;
        const window = windowFor(job, timestamp);
        if (window.end > window.start) candidates.push({ key, organization, job, previous, window });
      }
    }

    candidates.sort((a, b) => (a.previous?.nextAt ?? 0) - (b.previous?.nextAt ?? 0));
    for (const { key, organization, job, previous, window } of candidates) {
      if (active.size >= concurrency) break;
      if (active.has(key)) continue;
      const { signal } = controller;
      const promise = Promise.resolve().then(() => run(organization, job, previous, signal, window))
        .catch(() => onError()).finally(() => active.delete(key));
      active.set(key, { promise, resolution: job.resolution, startedAt: timestamp });
    }
  }

  function pulse() {
    if (!controller || controller.signal.aborted) return;
    try {
      tick();
    } catch {
      onError();
    } finally {
      if (!controller.signal.aborted) {
        timer = setTimer(pulse, pollMs);
        timer?.unref?.();
      }
    }
  }

  function start() {
    if (!enabled || controller) return false;
    controller = new AbortController();
    timer = setTimer(pulse, 0);
    timer?.unref?.();
    return true;
  }

  async function stop() {
    if (!controller) return;
    const stopping = controller;
    stopping.abort();
    clearTimer(timer);
    await Promise.allSettled([...active.values()].map(item => item.promise));
    if (controller === stopping) {
      pendingSchedules.clear();
      controller = null;
    }
  }

  function startedAt(organizationId, source, resolution) {
    const job = active.get(JSON.stringify([organizationId, source]));
    return job?.resolution === resolution ? job.startedAt : null;
  }

  return { start, stop, startedAt };
}
