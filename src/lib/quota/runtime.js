import { getAdapter } from "../db/driver.js";
import { createQuotaRepository } from "../db/repos/quotaRepo.js";
import { createOpenAIQuotaAdapter } from "./openai.js";
import { createQuotaScheduler } from "./scheduler.js";
import { createQuotaSecretResolver } from "./secrets.js";

const state = globalThis[Symbol.for("9router.quotaScheduler")] ??= { starting: null, stop: null, scheduler: null };

export function quotaSchedulerEnabled(env = process.env) {
  return env.QUOTA_COLLECTOR_ENABLED === "true" &&
    !["phase-production-build", "phase-export", "phase-static"].includes(env.NEXT_PHASE);
}

export function startQuotaCollector() {
  if (!quotaSchedulerEnabled()) return;
  if (state.starting) return state.starting;
  state.starting = (async () => {
    const concurrency = Number(process.env.QUOTA_COLLECTOR_CONCURRENCY ?? 2);
    const timeoutMs = Number(process.env.QUOTA_COLLECTOR_TIMEOUT_MS ?? 10_000);
    const resolveCredential = createQuotaSecretResolver({
      directory: process.env.QUOTA_COLLECTOR_SECRETS_DIR,
      allowedRefs: (process.env.QUOTA_COLLECTOR_SECRET_REFS || "").split(",").map(ref => ref.trim()).filter(Boolean),
    });
    const scheduler = createQuotaScheduler({
      repository: createQuotaRepository(await getAdapter()),
      adapters: { openai: createOpenAIQuotaAdapter({ resolveCredential, timeoutMs }) },
      enabled: true, concurrency,
      onError: () => console.warn("[Quota Collector] Scheduler operation failed"),
    });

    const onSignal = () => { void stop(); };
    async function stop() {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await scheduler.stop();
      state.starting = state.stop = state.scheduler = null;
    }
    // Abort fetch and sleeps synchronously before existing SQLite signal hooks.
    process.prependOnceListener("SIGINT", onSignal);
    process.prependOnceListener("SIGTERM", onSignal);
    state.stop = stop;
    state.scheduler = scheduler;
    scheduler.start();
  })().catch(() => {
    state.starting = null;
    console.warn("[Quota Collector] Initialization failed");
  });
  return state.starting;
}

export async function stopQuotaCollector() {
  await state.starting;
  await state.stop?.();
}

export function quotaCollectorStartedAt(organizationId, source, resolution) {
  return state.scheduler?.startedAt(organizationId, source, resolution) ?? null;
}
