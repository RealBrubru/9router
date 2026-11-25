import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const encoder = new TextEncoder();
const silence = vi.fn();

let temp, db, repo, post, getExecutor;

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
  ({ POST: post } = await import("@/app/api/v1/chat/completions/route.js"));
  db = await getAdapter();
  repo = createAttemptRegistryRepository(db);
  await updateSettings({ requireApiKey: false });
  db.run(`INSERT INTO providerConnections(id, provider, authType, name, isActive, data, createdAt, updatedAt)
    VALUES ('fixture-account', 'openai', 'apikey', 'fixture', 1, ?, 'fixture', 'fixture')`,
  [JSON.stringify({ apiKey: "fixture-provider-secret" })]);
  const quota = createQuotaRepository(db);
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
  upstream.mockReset();
  silence.mockReset();
  vi.stubEnv("ATTEMPT_REGISTRY_OPENAI_DIRECT", "true");
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
  });

  it("preserves earlier measured counters when the final usage event is incomplete", async () => {
    const first = frame({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: null }],
      usage: { prompt_tokens: 19, prompt_tokens_details: { cached_tokens: 3 } } });
    const last = frame({ ...chunk, choices: [], usage: { completion_tokens: 144 } });
    upstream.mockReturnValueOnce(sseReply(first + stop + last + done));
    await (await request(true)).text();
    expect(attempts()[0].usage).toMatchObject({ quality: "measured", completeness: "partial", inputTokens: "19",
      outputTokens: "144", cachedInputTokens: "3" });
    await history(1);
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

  it("marks a timeout after possible dispatch without attributing a retry result", async () => {
    upstream.mockRejectedValueOnce(Object.assign(new Error("fixture-raw-timeout"), { name: "TimeoutError" }));
    // Existing lower-layer policy may retry. Only the first raw submission is in this pilot.
    upstream.mockImplementation(() => jsonReply());
    await request();
    expect(attempts()).toHaveLength(1);
    expect(attempts()[0]).toMatchObject({ attempt: { state: "uncertain", outcome: "timeout" }, usage: { quality: "unknown" } });
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
