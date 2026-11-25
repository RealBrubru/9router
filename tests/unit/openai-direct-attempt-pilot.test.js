import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const upstream = vi.hoisted(() => vi.fn());
vi.mock("undici", async original => ({ ...await original(), fetch: upstream }));

const model = "gpt-5-mini";
const upstreamModel = "gpt-5-mini-fixture-version";
const usage = { prompt_tokens: 19, completion_tokens: 144, total_tokens: 163,
  prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 128 } };
const chunk = { id: "fixture-upstream-id", object: "chat.completion.chunk", created: 1, model: upstreamModel };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const content = frame({ ...chunk, choices: [{ index: 0, delta: { content: "fixture-assistant-content" }, finish_reason: null }], usage: null });
const stop = frame({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null });
const trailer = frame({ ...chunk, choices: [], usage });
const done = "data: [DONE]\n\n";
const json = { ...chunk, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "fixture-assistant-content" }, finish_reason: "stop" }] };
const headers = { "x-request-id": "fixture-header-value", "x-should-retry": "false" };
const jsonReply = (reported = usage) => Response.json({ ...json, ...(reported ? { usage: reported } : {}) }, { headers });
const sseReply = body => new Response(body, { headers: { ...headers, "content-type": "text/event-stream" } });
const errorReply = (status, reported) => Response.json({ error: { message: "fixture upstream rejection" }, usage: reported }, { status, headers });
const encoder = new TextEncoder();
const silence = vi.fn();

let temp, db, repo, quota, post, getExecutor, executorConfig;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), "openai-attempt-pilot-"));
  vi.stubEnv("DATA_DIR", temp);
  vi.stubEnv("ENABLE_REQUEST_LOGS", "false");
  vi.stubEnv("JWT_SECRET", "fixture-jwt-for-attempt-pilot");
  vi.stubEnv("NO_PROXY", "api.openai.com");
  vi.stubEnv("STREAM_STALL_TIMEOUT_MS", "3000");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  const { createQuotaRepository } = await import("@/lib/db/repos/quotaRepo.js");
  const { createAttemptRegistryRepository } = await import("@/lib/db/repos/attemptRegistryRepo.js");
  ({ getExecutor } = await import("open-sse/executors/index.js"));
  executorConfig = getExecutor("openai").config;
  ({ POST: post } = await import("@/app/api/v1/chat/completions/route.js"));
  db = await getAdapter();
  repo = createAttemptRegistryRepository(db);
  await updateSettings({ requireApiKey: false });
  db.run(`INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt)
    VALUES ('fixture-account', 'openai', 'apikey', 'fixture', 1, ?, 'fixture', 'fixture')`,
  [JSON.stringify({ apiKey: "fixture-provider-secret" })]);
  quota = createQuotaRepository(db);
  quota.putOrganization({ id: "fixture-org", provider: "openai", externalId: "fixture-admin-org", credentialRef: "ref:fixture", enabled: false });
  quota.bindConnection({
    organizationId: "fixture-org", connectionId: "fixture-account", apiKeyId: "fixture-administrative-key",
    projectId: "fixture-project-id", validFrom: 0,
  });
});

afterAll(async () => {
  db?.close();
  delete global._dbAdapter;
  vi.unstubAllEnvs();
  if (temp) await rm(temp, { recursive: true, force: true });
});

beforeEach(() => {
  // Preserve the process-wide epoch for successive enabled requests. Delete only scenario data.
  db.exec("DELETE FROM inferenceAttempts; DELETE FROM inferenceRequests; DELETE FROM usageHistory; DELETE FROM usageDaily;");
  db.run("UPDATE providerConnections SET data = ? WHERE id = 'fixture-account'", [JSON.stringify({ apiKey: "fixture-provider-secret" })]);
  getExecutor("openai").config = { ...executorConfig, retry: {
    502: { attempts: 1, delayMs: 0 }, 503: { attempts: 1, delayMs: 0 }, 504: { attempts: 1, delayMs: 0 },
  } };
  upstream.mockReset();
  silence.mockReset();
  vi.stubEnv("ATTEMPT_REGISTRY_OPENAI_DIRECT", "true");
});

afterEach(() => {
  getExecutor("openai").config = executorConfig;
  vi.restoreAllMocks();
});

function request(stream = false, overrides = {}) {
  return post(new Request("http://localhost/api/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-client-secret" },
    body: JSON.stringify({ model: `openai/${model}`, messages: [{ role: "user", content: "fixture-user-content" }], stream, ...overrides }),
  }));
}

function attempts() {
  return db.all("SELECT id FROM inferenceAttempts ORDER BY rowid").map(({ id }) => repo.readAsKnownAt(id, repo.captureReadCutoff()));
}

async function history(count) {
  await vi.waitFor(() => expect(db.get("SELECT COUNT(*) AS n FROM usageHistory").n).toBe(count));
}

function assertChain(causes) {
  const chain = attempts();
  expect(chain).toHaveLength(upstream.mock.calls.length);
  expect(chain.map(({ events }) => events[0].details.submissionCause)).toEqual(causes);
  expect(new Set(chain.map(({ attempt }) => attempt.id)).size).toBe(chain.length);
  expect(new Set(chain.map(({ attempt }) => attempt.requestId)).size).toBe(1);
  expect(chain.map(({ attempt }) => attempt.previousAttemptId)).toEqual([null, ...chain.slice(0, -1).map(({ attempt }) => attempt.id)]);
  return chain;
}

async function withFallbackAccount(test) {
  db.run(`INSERT INTO providerConnections(id, provider, authType, name, isActive, priority, data, createdAt, updatedAt)
    VALUES ('fixture-fallback', 'openai', 'apikey', 'fixture-fallback', 1, 999, ?, 'fixture', 'fixture')`,
  [JSON.stringify({ apiKey: "fixture-fallback-secret" })]);
  quota.bindConnection({ organizationId: "fixture-org", connectionId: "fixture-fallback", apiKeyId: "fixture-other-key", validFrom: 5 });
  try { await test(); }
  finally {
    db.run("DELETE FROM quotaConnectionBindings WHERE connectionId = 'fixture-fallback'");
    db.run("DELETE FROM providerConnections WHERE id = 'fixture-fallback'");
  }
}

describe("OpenAI direct attempt pilot through the Chat Completions route", () => {
  it("persists the dispatch barrier before transport and preserves observed JSON and Analytics", async () => {
    upstream.mockImplementationOnce(() => {
      expect(attempts()[0]).toMatchObject({
        attempt: { state: "dispatch_possible", connectionId: "fixture-account" },
        request: { requestedModel: `openai/${model}` },
        dispatch: { sentModel: model, binding: { status: "configured", organizationId: "fixture-org", validFrom: 0 } },
      });
      return jsonReply();
    });
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(await response.json()).toMatchObject({ ...json, usage });
    const [attempt] = attempts();
    expect(attempt).toMatchObject({
      attempt: { state: "closed", outcome: "completed" }, acknowledgment: { httpStatus: 200, providerAccepted: "unknown" },
      returnedModel: upstreamModel, usage: { quality: "measured", completeness: "complete", inputTokens: "19", outputTokens: "144",
        cachedInputTokens: "3", reasoningTokens: "128" },
    });
    expect(attempt.request.id).not.toBe(attempt.attempt.id);
    await history(1);
    const day = JSON.parse(db.get("SELECT data FROM usageDaily").data);
    expect([day.requests, day.promptTokens, day.completionTokens]).toEqual([1, 19, 144]);
    expect(db.get("SELECT COUNT(*) AS n FROM requestDetails").n).toBe(0);
    expect(db.get("SELECT barrierCertified FROM inferenceCoverageEpochs").barrierCertified).toBe(0);
    const serialized = JSON.stringify(attempts());
    for (const value of ["fixture-user-content", "fixture-assistant-content", "fixture-provider-secret", "fixture-client-secret",
      "fixture-upstream-id", "fixture-header-value", "fixture-administrative-key", "fixture-project-id"]) {
      expect(serialized).not.toContain(value);
    }
  });

  it("leaves missing JSON usage unknown", async () => {
    upstream.mockReturnValueOnce(jsonReply(null));
    expect(await (await request()).json()).not.toHaveProperty("usage");
    expect(attempts()[0]).toMatchObject({ attempt: { state: "closed" }, usage: { quality: "unknown", explicitZero: false } });
    await history(0);
  });

  it("preserves measured JSON zero as explicit zero", async () => {
    upstream.mockReturnValueOnce(jsonReply({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }));
    expect((await request()).status).toBe(200);
    expect(attempts()[0].usage).toMatchObject({ explicitZero: true, inputTokens: "0", outputTokens: "0" });
    await history(1);
  });

  it("records native SSE usage once and preserves the client wire with the pilot disabled or enabled", async () => {
    const wire = content + stop + trailer + done;
    const responseFor = async enabled => {
      vi.stubEnv("ATTEMPT_REGISTRY_OPENAI_DIRECT", enabled);
      upstream.mockReturnValueOnce(sseReply(wire));
      const res = await request(true, { stream_options: { include_usage: true } });
      return { status: res.status, headers: Object.fromEntries(res.headers), text: await res.text() };
    };
    const disabled = await responseFor("false");
    expect(attempts()).toEqual([]);
    await history(1);
    db.exec("DELETE FROM usageHistory; DELETE FROM usageDaily;");
    const enabled = await responseFor("true");
    expect(enabled).toEqual(disabled);
    expect(enabled.text.match(/data: \[DONE\]/g)).toHaveLength(1);
    const [attempt] = attempts();
    expect(attempt.events.map(event => event.kind)).toEqual(["prepare", "dispatch", "acknowledge", "in_progress", "returned_model", "usage", "finish"]);
    expect(attempt).toMatchObject({ attempt: { state: "closed" }, usage: { completeness: "complete", outputTokens: "144" } });
    await history(1);
    expect(JSON.parse(db.get("SELECT data FROM usageDaily").data).requests).toBe(1);
  });

  it("keeps SSE without an upstream usage event unknown in the Registry", async () => {
    upstream.mockReturnValueOnce(sseReply(content + stop + done));
    const response = await request(true);
    expect(await response.text()).toContain(done);
    expect(attempts()[0]).toMatchObject({ attempt: { state: "closed", outcome: "completed" }, usage: { quality: "unknown" } });
    await history(1);
  });

  it("preserves earlier measured counters when the final usage event is incomplete", async () => {
    const first = frame({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: { prompt_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } } });
    const last = frame({ ...chunk, choices: [], usage: { completion_tokens: 144 } });
    upstream.mockReturnValueOnce(sseReply(first + stop + last + done));
    await (await request(true)).text();
    expect(attempts()[0].usage).toMatchObject({ quality: "measured", completeness: "partial", inputTokens: "19",
      outputTokens: "144", cachedInputTokens: "3" });
    await history(0);
  });

  it("records an upstream SSE terminal while aggregating the JSON requested by the client", async () => {
    upstream.mockReturnValueOnce(sseReply(content + stop + trailer + done));
    const response = await request();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({ model: upstreamModel, usage });
    expect(attempts()[0]).toMatchObject({ attempt: { state: "closed" }, usage: { completeness: "complete" } });
    await history(1);
  });

  it.each([true, false])("preserves partial usage after an upstream interruption with stream=%s", async stream => {
    let source;
    upstream.mockReturnValueOnce(sseReply(new ReadableStream({ start(controller) { source = controller; } })));
    const pending = request(stream);
    const first = frame({ ...chunk, choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      usage: { prompt_tokens: 19 } });
    source = await vi.waitFor(() => { expect(source).toBeDefined(); return source; });
    source.enqueue(encoder.encode(first));
    if (stream) {
      const reader = (await pending).body.getReader();
      await reader.read();
      source.error(new Error("fixture-raw-socket-error"));
      while (!(await reader.read()).done) {}
    } else {
      await vi.waitFor(() => expect(attempts()[0].attempt.state).toBe("in_progress"));
      source.error(new Error("fixture-raw-socket-error"));
      expect((await pending).status).toBe(503);
    }
    expect(attempts()[0]).toMatchObject({
      attempt: { state: "uncertain", outcome: "transport_error" }, usage: { completeness: "partial", inputTokens: "19", outputTokens: null },
    });
    expect(JSON.stringify(attempts())).not.toContain("fixture-raw-socket-error");
  });

  it("does not interpret EOF or a client-generated sentinel as a provider terminal", async () => {
    upstream.mockReturnValueOnce(sseReply(content + stop));
    expect(await (await request(true)).text()).toContain(done);
    expect(attempts()[0]).toMatchObject({ attempt: { state: "uncertain" }, usage: { quality: "unknown" } });
    await history(1);
  });

  it("classifies reader cancellation independently of provider completion", async () => {
    upstream.mockReturnValueOnce(sseReply(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(content)); } })));
    const reader = (await request(true)).body.getReader();
    await reader.read();
    await reader.cancel("fixture-client-cancel");
    expect(attempts()[0]).toMatchObject({ attempt: { state: "uncertain", outcome: "cancelled" }, usage: { quality: "unknown" } });
  });

  it("keeps a provider terminal when a downstream cancellation races with finalization", async () => {
    upstream.mockReturnValueOnce(sseReply(content + stop + trailer + done));
    const reader = (await request(true)).body.getReader();
    await reader.read();
    await reader.cancel();
    const [attempt] = attempts();
    expect(attempt).toMatchObject({ attempt: { state: "closed", outcome: "completed" }, usage: { completeness: "complete" } });
    expect(attempt.events.filter(event => event.kind === "finish")).toHaveLength(1);
  });

  it("records a proven live failure before the first transport invocation", async () => {
    const failure = vi.spyOn(getExecutor("openai"), "buildHeaders").mockImplementationOnce(() => { throw new Error("fixture-raw-setup-error"); });
    try {
      expect((await request()).status).toBe(503);
      expect(upstream).not.toHaveBeenCalled();
      expect(attempts()[0]).toMatchObject({
        attempt: { state: "not_sent", outcome: "internal_error" }, usage: { quality: "not_applicable" },
        events: [{ kind: "prepare" }, { kind: "finish", details: { noSendEvidence: "before_transport_invocation" } }],
      });
    } finally { failure.mockRestore(); }
  });

  it("keeps a timeout separate from the successful executor retry and its Analytics", async () => {
    upstream.mockRejectedValueOnce(Object.assign(new Error("fixture-raw-timeout"), { name: "TimeoutError" }));
    upstream.mockReturnValueOnce(jsonReply());
    expect(await (await request()).json()).toMatchObject({ ...json, usage });
    const [first, second] = assertChain([undefined, "executor_retry"]);
    expect(first).toMatchObject({ attempt: { state: "uncertain", outcome: "timeout" }, usage: { quality: "unknown" } });
    expect(second).toMatchObject({ attempt: { state: "closed", outcome: "completed" }, usage: { inputTokens: "19" } });
    await history(1);
  });

  it.each([
    ["UND_ERR_SOCKET", "socket_replay"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls_replay"],
  ])("records an observable %s transport replay separately", async (code, cause) => {
    vi.stubEnv("STRICT_SSL", "false");
    vi.stubEnv("FETCH_FRESH_RETRY", "on");
    upstream.mockRejectedValueOnce(Object.assign(new Error("fixture socket failure"), { code }));
    upstream.mockReturnValueOnce(sseReply(content + stop + trailer + done));
    expect(await (await request(true)).text()).toContain(done);
    const [first, second] = assertChain([undefined, cause]);
    expect(first).toMatchObject({ attempt: { state: "uncertain" }, usage: { quality: "unknown" } });
    expect(second).toMatchObject({ attempt: { state: "closed" }, usage: { outputTokens: "144" } });
    await history(1);
  });

  it("keeps every observed response when HTTP retries are exhausted", async () => {
    upstream.mockImplementation(() => errorReply(503));
    expect((await request()).status).toBe(503);
    for (const attempt of assertChain([undefined, "executor_retry"])) {
      expect(attempt).toMatchObject({ acknowledgment: { httpStatus: 503 }, usage: { quality: "unknown", explicitZero: false } });
    }
    await history(0);
  });

  it("preserves causality and a surfaced abort during an executor retry", async () => {
    const discarded = errorReply(502, { prompt_tokens: 2 });
    upstream.mockReturnValueOnce(discarded);
    upstream.mockRejectedValueOnce(new DOMException("fixture cancellation", "AbortError"));
    await request();
    const [first, second] = assertChain([undefined, "executor_retry"]);
    expect(first.acknowledgment.httpStatus).toBe(502);
    expect(first.usage.quality).toBe("unknown");
    expect(discarded.bodyUsed).toBe(false);
    expect(second).toMatchObject({ attempt: { state: "uncertain", outcome: "cancelled" }, usage: { quality: "unknown" } });
    await history(0);
  });

  it("does not invent an OpenAI API key refresh after a 401", async () => {
    upstream.mockReturnValueOnce(errorReply(401));
    await request();
    const [attempt] = assertChain([undefined]);
    expect(attempt).toMatchObject({ acknowledgment: { httpStatus: 401 }, usage: { quality: "unknown" } });
  });

  it("uses the refresh resubmission boundary when a refresh result is supplied synthetically", async () => {
    const refresh = vi.spyOn(getExecutor("openai"), "refreshCredentials").mockResolvedValueOnce({ accessToken: "fixture-refresh-token" });
    upstream.mockReturnValueOnce(errorReply(401));
    upstream.mockReturnValueOnce(jsonReply());
    expect(await (await request()).json()).toMatchObject({ ...json, usage });
    const [first, second] = assertChain([undefined, "credential_refresh"]);
    expect(first.acknowledgment.httpStatus).toBe(401);
    expect(second).toMatchObject({ acknowledgment: { httpStatus: 200 }, usage: { outputTokens: "144" } });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(attempts())).not.toContain("fixture-refresh-token");
    await history(1);
  });

  it("attributes the selected error body to the original attempt after a failed refresh submission", async () => {
    vi.spyOn(getExecutor("openai"), "refreshCredentials").mockResolvedValueOnce({ accessToken: "fixture-refresh-token" });
    upstream.mockReturnValueOnce(errorReply(401, { prompt_tokens: 5 }));
    const dropped = errorReply(400, { prompt_tokens: 13 });
    upstream.mockReturnValueOnce(dropped);
    await request();
    const [first, second] = assertChain([undefined, "credential_refresh"]);
    expect(first.usage).toMatchObject({ inputTokens: "5", completeness: "partial" });
    expect(second.acknowledgment.httpStatus).toBe(400);
    expect(second.usage.quality).toBe("unknown");
    expect(dropped.bodyUsed).toBe(false);
    await history(0);
  });

  it("keeps the binding unknown when the effective headers override the configured scope", async () => {
    const executor = getExecutor("openai");
    const buildHeaders = executor.buildHeaders.bind(executor);
    vi.spyOn(executor, "buildHeaders").mockImplementationOnce((...args) => ({
      ...buildHeaders(...args), "OpenAI-Project": "fixture-effective-project",
    }));
    upstream.mockReturnValueOnce(jsonReply());
    expect((await request()).status).toBe(200);
    expect(assertChain([undefined])[0].dispatch.binding).toEqual({ status: "unknown" });
    expect(JSON.stringify(attempts())).not.toContain("fixture-effective-project");
    await history(1);
  });

  it("re-evaluates the configured binding and keeps observed error usage on the connection that incurred it", () => withFallbackAccount(async () => {
    upstream.mockReturnValueOnce(errorReply(429, { prompt_tokens: 3 }));
    upstream.mockReturnValueOnce(jsonReply());
    expect(await (await request()).json()).toMatchObject({ ...json, usage });
    const [first, second] = assertChain([undefined, "connection_fallback"]);
    expect(first).toMatchObject({ attempt: { connectionId: "fixture-account" }, usage: { inputTokens: "3", completeness: "partial" } });
    expect(second).toMatchObject({ attempt: { connectionId: "fixture-fallback", purpose: "fallback" }, usage: { inputTokens: "19" },
      dispatch: { binding: { status: "configured", validFrom: 5 }, usageHistoryLink: "unverified" } });
    await history(1);
    expect(db.get("SELECT connectionId, promptTokens FROM usageHistory")).toEqual({ connectionId: "fixture-fallback", promptTokens: 19 });
    expect(db.get("SELECT COUNT(*) AS n FROM inferenceUsageLinks").n).toBe(0);
  }));

  it("keeps a partial stream on the earlier connection when SSE-to-JSON aborts and routing falls back", () => withFallbackAccount(async () => {
    let source;
    upstream.mockReturnValueOnce(sseReply(new ReadableStream({ start(controller) { source = controller; } })));
    upstream.mockReturnValueOnce(jsonReply());
    const pending = request();
    source = await vi.waitFor(() => { expect(source).toBeDefined(); return source; });
    source.enqueue(encoder.encode(frame({ ...chunk, choices: [{ index: 0 }], usage: { completion_tokens: 4 } })));
    await vi.waitFor(() => expect(attempts()[0].attempt.state).toBe("in_progress"));
    source.error(new Error("fixture socket interruption"));
    expect(await (await pending).json()).toMatchObject({ ...json, usage });
    const [first, second] = assertChain([undefined, "connection_fallback"]);
    expect(first).toMatchObject({ attempt: { state: "uncertain" }, usage: { outputTokens: "4", completeness: "partial" } });
    expect(second).toMatchObject({ attempt: { state: "closed" }, usage: { outputTokens: "144" } });
    await history(1);
  }));

  it("keeps the chain running through an intermediate storage failure without fabricating a predecessor", () => withFallbackAccount(async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(silence);
    db.exec(`CREATE TRIGGER fixture_middle_failure BEFORE INSERT ON inferenceAttemptEvents
      WHEN NEW.kind = 'prepare' AND json_extract(NEW.details, '$.submissionCause') = 'executor_retry'
      BEGIN SELECT RAISE(ABORT, 'fixture-private-storage-error'); END;`);
    try {
      upstream.mockReturnValueOnce(errorReply(502));
      upstream.mockReturnValueOnce(errorReply(429));
      upstream.mockReturnValueOnce(jsonReply());
      expect(await (await request()).json()).toMatchObject({ ...json, usage });
      expect(upstream).toHaveBeenCalledTimes(3);
      const chain = attempts();
      expect(chain).toHaveLength(2);
      const [first, last] = chain;
      expect(repo.readCoverage(first.attempt.epochId)).toMatchObject({ coverage: "gap", gapReason: "storage_failure" });
      expect(last.attempt).toMatchObject({ requestId: first.attempt.requestId, previousAttemptId: null, state: "closed" });
      expect(last.events[0].details).toEqual({ submissionCause: "connection_fallback", causalGap: "predecessor_unobserved" });
      expect(JSON.stringify(warning.mock.calls)).not.toContain("fixture-private-storage-error");
      await history(1);
    } finally { db.exec("DROP TRIGGER fixture_middle_failure"); }
  }));

  it("leaves consumption unknown when Undici reports an opaque redirect", async () => {
    const response = jsonReply();
    Object.defineProperty(response, "redirected", { value: true });
    upstream.mockReturnValueOnce(response);
    expect(await (await request()).json()).toMatchObject({ ...json, usage });
    const [called] = assertChain([undefined]);
    expect(called).toMatchObject({ attempt: { state: "uncertain" }, acknowledgment: null, usage: { quality: "unknown" } });
    await history(1);
  });

  it("excludes the automatic model fallback that runs through a combo", async () => {
    db.run(`INSERT INTO combos(id, name, models, createdAt, updatedAt)
      VALUES ('fixture-combo', 'fixture-combo', ?, 'fixture', 'fixture')`,
    [JSON.stringify([`openai/${model}`, "openai/gpt-4o-mini"])]);
    try {
      upstream.mockReturnValueOnce(errorReply(404));
      upstream.mockReturnValueOnce(jsonReply());
      expect((await request(false, { model: "fixture-combo" })).status).toBe(200);
      expect(upstream.mock.calls.map(([, options]) => JSON.parse(options.body).model)).toEqual([model, "gpt-4o-mini"]);
      expect(attempts()).toEqual([]);
      await history(1);
    } finally { db.run("DELETE FROM combos WHERE id = 'fixture-combo'"); }
  });

  it("preserves an HTTP error while keeping usage unknown", async () => {
    upstream.mockReturnValueOnce(Response.json({ error: { message: "fixture upstream rejection" } }, { status: 400, headers }));
    const response = await request();
    expect(response.status).toBe(400);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(attempts()[0]).toMatchObject({
      attempt: { state: "closed", outcome: "provider_error" }, acknowledgment: { httpStatus: 400, providerAccepted: "unknown" },
      usage: { quality: "unknown" },
    });
  });

  it("fails open, marks a gap, and seals it after the database can write again", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(silence);
    db.exec(`CREATE TRIGGER fixture_drop_attempt BEFORE INSERT ON inferenceAttemptEvents
      WHEN NEW.kind = 'dispatch' BEGIN SELECT RAISE(ABORT, 'fixture-private-storage-error'); END;
      CREATE TRIGGER fixture_drop_gap BEFORE UPDATE ON inferenceCoverageEpochs
      BEGIN SELECT RAISE(ABORT, 'fixture-private-storage-error'); END`);
    try {
      upstream.mockReturnValueOnce(jsonReply());
      expect(await (await request()).json()).toMatchObject({ ...json, usage });
      expect(attempts()[0].attempt.state).toBe("prepared");
      const epochId = attempts()[0].attempt.epochId;
      expect(repo.readCoverage(epochId).coverage).toBe("unknown");
      expect(warning).toHaveBeenCalledWith("[Attempt Registry] OpenAI direct pilot coverage is indeterminate");
      expect(JSON.stringify(warning.mock.calls)).not.toContain("fixture-private-storage-error");
      db.exec("DROP TRIGGER fixture_drop_gap; DROP TRIGGER fixture_drop_attempt;");
      upstream.mockReturnValueOnce(jsonReply());
      expect((await request()).status).toBe(200);
      expect(repo.readCoverage(epochId)).toMatchObject({ coverage: "gap", gapReason: "storage_failure" });
      expect(attempts()[1].attempt.state).toBe("closed");
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fixture_drop_gap; DROP TRIGGER IF EXISTS fixture_drop_attempt;");
      warning.mockRestore();
    }
  });

  it("does not instrument a configured proxy or an unset flag", async () => {
    vi.stubEnv("ATTEMPT_REGISTRY_OPENAI_DIRECT", undefined);
    upstream.mockReturnValueOnce(jsonReply());
    expect((await request()).status).toBe(200);
    vi.stubEnv("ATTEMPT_REGISTRY_OPENAI_DIRECT", "true");
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("HTTPS_PROXY", "http://fixture-proxy.invalid:3128");
    try {
      upstream.mockReturnValueOnce(jsonReply());
      expect((await request()).status).toBe(200);
      expect(attempts()).toEqual([]);
    } finally {
      vi.stubEnv("NO_PROXY", "api.openai.com");
      vi.stubEnv("HTTPS_PROXY", undefined);
    }
  });

  it.each(["JSON", "SSE"])("measures local %s latency with and without the pilot", async mode => {
    const streaming = mode === "SSE";
    const samples = { disabled: [], enabled: [] };
    for (let i = 0; i < 13; i++) {
      for (const label of ["disabled", "enabled"]) {
        vi.stubEnv("ATTEMPT_REGISTRY_OPENAI_DIRECT", label === "enabled" ? "true" : "false");
        upstream.mockReturnValueOnce(streaming ? sseReply(content + stop + trailer + done) : jsonReply());
        const start = performance.now();
        const response = await request(streaming);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        if (i > 0) samples[label].push(performance.now() - start);
        await history(i * 2 + (label === "disabled" ? 1 : 2));
      }
    }
    const p50 = values => {
      const ordered = values.toSorted((a, b) => a - b);
      return (ordered[5] + ordered[6]) / 2;
    };
    console.info(`[Attempt pilot fixture] 12 ${mode} calls per setting`, {
      disabledP50Ms: p50(samples.disabled), enabledP50Ms: p50(samples.enabled),
    });
    expect(attempts()).toHaveLength(13);
  });
});
