import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { createBetterSqliteAdapter } from "../../src/lib/db/adapters/betterSqliteAdapter.js";
import initial from "../../src/lib/db/migrations/001-initial.js";
import { createAttemptProfiler } from "../fixtures/attempt-registry-profiler.mjs";

const fixture = vi.hoisted(() => ({ db: null, fetch: null, profiler: null }));
vi.mock("@/lib/db/driver.js", async original => ({
  ...await original(), getAdapter: async () => fixture.db, getAdapterSync: () => fixture.db,
}));
vi.mock("undici", async original => ({ ...await original(), fetch: (...args) => fixture.fetch(...args) }));
vi.mock("@/lib/db/repos/attemptRegistryRepo.js", async original => {
  const actual = await original();
  return { ...actual, createAttemptRegistryRepository(...args) {
    const repo = actual.createAttemptRegistryRepository(...args);
    return fixture.profiler?.repository(repo) ?? repo;
  } };
});

const model = "gpt-5-mini";
const endpoint = "https://api.openai.com/v1/chat/completions";
const marker = "fixture-private-prompt";
const encoder = new TextEncoder();
const sseChunk = value => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
const retireFlag = "ATTEMPT_REGISTRY_OPENAI_DIRECT";
const turn = () => new Promise(resolve => setImmediate(resolve));
const round = value => Number(value.toFixed(3));
const compare = process.env.RUN_ATTEMPT_PROFILE_COMPARE === "1";
const profile = compare || process.env.RUN_ATTEMPT_PROFILE === "1";

function percentiles(samples) {
  if (!samples.length) return null;
  const sorted = samples.toSorted((a, b) => a - b);
  return [0.5, 0.95, 0.99].map(p => round(sorted[Math.ceil(p * sorted.length) - 1]));
}

function simulatedResponse(id, stream) {
  const meta = { model, created: 1, id: `fixture-response-${id}` };
  const usage = { prompt_tokens: id, completion_tokens: 3, total_tokens: id + 3 };
  if (!stream) return Response.json({ ...meta, object: "chat.completion", usage,
    choices: [{ index: 0, message: { role: "assistant", content: "fixture-private-response" }, finish_reason: "stop" }],
  });
  return new Response(new ReadableStream({
    async start(controller) {
      await turn();
      controller.enqueue(sseChunk({ ...meta, object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "fixture-private-response" }, finish_reason: null }] }));
      await turn();
      controller.enqueue(sseChunk({ ...meta, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      controller.enqueue(sseChunk({ ...meta, choices: [], usage }));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

async function readResponse(response, stream, sample, inputTokens) {
  expect(response.status).toBe(200);
  if (!stream) {
    expect(await response.json()).toMatchObject({
      choices: [{ message: { content: "fixture-private-response" } }],
      usage: { prompt_tokens: inputTokens, completion_tokens: 3 },
    });
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let wire = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    wire += decoder.decode(value, { stream: true });
    if (sample.firstToken == null && wire.includes('"content":"fixture-private-response"')) {
      sample.firstToken = performance.now() - sample.startedAt;
    }
  }
  expect(sample.firstToken).toBeTypeOf("number");
  expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
  expect(wire).toContain(`"prompt_tokens":${inputTokens},"completion_tokens":3`);
}

function measureDb(db, metrics) {
  const collect = (fn, samples) => {
    const start = performance.now();
    try { return fn(); }
    catch (err) {
      const busy = /SQLITE_(BUSY|LOCKED)/.test(err.code ?? "") || /database (?:is )?locked/i.test(err.message);
      if (busy) metrics.busy++;
      metrics.errors++;
      throw err;
    } finally { samples.push(performance.now() - start); }
  };
  return {
    ...db,
    transaction: fn => collect(() => db.transaction(fn), metrics.transactions),
    ...Object.fromEntries(["run", "get", "all"].map(method => [
      method, (sql, params) => /\binference(?:Requests|Attempts|AttemptEvents|CoverageEpochs|UsageLinks)\b/.test(sql)
        ? collect(() => db[method](sql, params), metrics.registryStatements)
        : db[method](sql, params),
    ])),
  };
}

async function fileBytes(file) {
  return (await stat(file).catch(error => { if (error.code !== "ENOENT") throw error; }))?.size ?? 0;
}

async function runCell({ post, updateSettings, disablePilot, root, stream, enabled, concurrency, warnings, mode }) {
  const file = join(root, `${stream}-${enabled}-${concurrency}-${mode}.sqlite`);
  const db = createBetterSqliteAdapter(file);
  if (mode === "readback") db.supportsInsertReturning = false;
  const profiler = profile ? createAttemptProfiler(db) : null;
  fixture.profiler = profiler;
  const sql = { transactions: [], registryStatements: [], errors: 0, busy: 0 };
  fixture.db = measureDb(profiler?.adapter ?? db, sql);
  const calls = new Map();
  let id = 1000;
  fixture.fetch = (url, options) => {
    if (url !== endpoint) throw new Error("fixture forbids external transport");
    const body = JSON.parse(options.body);
    const key = Number(body.messages[0].content.slice(marker.length));
    const sample = calls.get(key);
    if (!sample || sample.preDispatch != null || body.stream !== stream) throw new Error("unexpected submission");
    sample.preDispatch = performance.now() - sample.startedAt;
    return simulatedResponse(key, stream);
  };

  async function batch(size) {
    const releasedAt = performance.now();
    const results = await Promise.all(Array.from({ length: size }, async () => {
      const key = ++id;
      const request = new Request("http://localhost/api/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", "x-fixture": "fixture-private-header" },
        body: JSON.stringify({ model: `openai/${model}`, stream,
          ...(stream ? { stream_options: { include_usage: true } } : {}),
          messages: [{ role: "user", content: marker + key }],
        }),
      });
      const sample = { startedAt: performance.now() };
      sample.launchDelay = sample.startedAt - releasedAt;
      calls.set(key, sample);
      await readResponse(await post(request), stream, sample, key);
      sample.total = performance.now() - sample.startedAt;
      expect(sample.preDispatch).toBeTypeOf("number");
      return sample;
    }));
    return { results, elapsed: performance.now() - releasedAt };
  }

  const history = n => vi.waitFor(() => expect(db.get("SELECT COUNT(*) n FROM usageHistory").n).toBe(n),
    { interval: 5, timeout: 5000 });
  try {
    db.transaction(() => initial.up(db));
    await updateSettings({ requireApiKey: false });
    db.run(`INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt)
      VALUES ('fixture-account', 'openai', 'apikey', 'fixture', 1, ?, 'fixture', 'fixture')`,
    [JSON.stringify({ apiKey: "fixture-provider-secret" })]);
    vi.stubEnv(retireFlag, enabled ? "true" : "false");
    profiler?.phase("warm");
    const warmBatches = Math.max(2, Math.ceil(20 / concurrency));
    for (let i = 0; i < warmBatches; i++) await batch(concurrency);
    await history(warmBatches * concurrency);
    profiler?.phase("idle");
    db.exec("DELETE FROM inferenceAttempts; DELETE FROM inferenceRequests; DELETE FROM usageHistory; DELETE FROM usageDaily; VACUUM;");
    db.checkpoint();

    const baseDb = await fileBytes(file);
    const baseWal = await fileBytes(file + "-wal");
    sql.transactions.length = sql.registryStatements.length = 0;
    sql.errors = sql.busy = 0;
    warnings.count = 0;
    calls.clear();
    const rssStart = process.memoryUsage.rss();
    let rssPeak = rssStart;
    const samples = [];
    let elapsed = 0;
    const rounds = 3;
    const batches = Math.max(2, Math.ceil(120 / concurrency));
    profiler?.startLoad();
    for (let i = 0; i < rounds; i++) {
      for (let j = 0; j < batches; j++) {
        const loopProbe = profiler?.probeBatch();
        const result = await batch(concurrency);
        elapsed += result.elapsed;
        samples.push(...result.results);
        rssPeak = Math.max(rssPeak, process.memoryUsage.rss());
        if (loopProbe) await loopProbe;
      }
      await history(samples.length);
    }
    profiler?.stopLoad();

    const expected = enabled ? samples.length : 0;
    const persisted = db.get("SELECT COUNT(*) n FROM inferenceAttempts WHERE state = 'closed'").n;
    expect(db.get("SELECT COUNT(*) n FROM inferenceAttempts").n).toBe(expected);
    expect(persisted).toBe(expected);
    expect(calls.size).toBe(samples.length);
    expect(db.get("SELECT COUNT(*) n FROM requestDetails").n).toBe(0);
    const aggregate = JSON.parse(db.get("SELECT data FROM usageDaily").data);
    expect(aggregate.requests).toBe(samples.length);
    const registry = JSON.stringify(["inferenceRequests", "inferenceAttempts", "inferenceAttemptEvents", "inferenceCoverageEpochs", "inferenceUsageLinks"]
      .flatMap(table => db.all(`SELECT * FROM ${table}`)));
    for (const privateValue of [marker, "fixture-private-response", "fixture-private-header", "fixture-provider-secret"]) {
      expect(registry).not.toContain(privateValue);
    }
    const walBytes = await fileBytes(file + "-wal") - baseWal;
    const checkpointStarted = performance.now();
    db.checkpoint();
    const checkpointMs = performance.now() - checkpointStarted;
    if (profiler) {
      profiler.phase("coverage");
      vi.stubEnv(retireFlag, "false");
      disablePilot();
      profiler.phase("idle");
    }
    return {
      protocol: stream ? "SSE" : "JSON", enabled, mode, concurrency, rounds, batches, samples: samples.length,
      preDispatch: percentiles(samples.map(sample => sample.preDispatch)),
      launchDelay: percentiles(samples.map(sample => sample.launchDelay)),
      firstToken: stream ? percentiles(samples.map(sample => sample.firstToken)) : null,
      total: percentiles(samples.map(sample => sample.total)),
      requestsPerSecond: round(samples.length * 1000 / elapsed),
      sqliteTransactions: percentiles(sql.transactions), sqliteTransactionCount: sql.transactions.length,
      registryStatements: percentiles(sql.registryStatements), registryStatementCount: sql.registryStatements.length,
      sqliteErrors: sql.errors, sqliteBusy: sql.busy, registryWarnings: warnings.count,
      rssStart, rssPeak, dbBytes: await fileBytes(file) - baseDb, walBytes, expected, persisted,
      ...(profiler ? { checkpointMs, profile: profiler.report() } : {}),
    };
  } finally {
    profiler?.stopLoad();
    vi.stubEnv(retireFlag, "false");
    disablePilot();
    db.close();
    fixture.profiler = null;
  }
}

it.runIf(profile || process.env.RUN_ATTEMPT_BENCH === "1")("compares OpenAI direct registry performance offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "attempt-registry-benchmark-"));
  vi.stubEnv("DATA_DIR", root);
  vi.stubEnv("NO_PROXY", "api.openai.com");
  vi.stubEnv("ENABLE_REQUEST_LOGS", "false");
  vi.stubEnv("JWT_SECRET", "fixture-benchmark-jwt");
  const { log, warn } = console;
  const warnings = { count: 0 };
  console.log = () => {};
  console.warn = line => {
    if (typeof line === "string" && line.startsWith("[Attempt Registry]")) warnings.count++;
  };
  try {
    const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    const { POST: post } = await import("@/app/api/v1/chat/completions/route.js");
    const { beginOpenAiDirectAttempt: disablePilot } = await import("@/lib/quota/openAiDirectAttemptPilot.js");
    for (const stream of [false, true]) {
      const levels = profile ? [1, 100] : [1, 10, 50, 100];
      for (const [index, concurrency] of levels.entries()) {
        if (compare) {
          const reverse = (index + Number(stream) + Number(process.env.ATTEMPT_COMPARE_REVERSE === "1")) % 2;
          const modes = reverse ? ["returning", "readback"] : ["readback", "returning"];
          for (const mode of modes) {
            const result = await runCell({ post, updateSettings, disablePilot, root, stream, enabled: true, concurrency, warnings, mode });
            log.call(console, "ATTEMPT_BENCH", JSON.stringify(result));
          }
          continue;
        }
        for (const enabled of index % 2 ? [true, false] : [false, true]) {
          const result = await runCell({ post, updateSettings, disablePilot, root, stream, enabled, concurrency, warnings, mode: "current" });
          log.call(console, "ATTEMPT_BENCH", JSON.stringify(result));
        }
      }
    }
  } finally {
    console.log = log;
    console.warn = warn;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
