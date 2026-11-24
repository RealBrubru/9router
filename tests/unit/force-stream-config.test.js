// Guards forceStream moved from chatCore hardcode → PROVIDERS schema (#5).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({
  injectCaveman: vi.fn(),
}));

vi.mock("../../open-sse/rtk/ponytail.js", () => ({
  injectPonytail: vi.fn(),
}));

vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));

vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  // chatCore also imports these (fb543a1f); a mock missing them fails the import.
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({}),
  getApiKeys: async () => [],
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: async () => ({ connectionId: "test-connection", apiKey: "sk-test" }),
  markAccountUnavailable: async () => ({ shouldFallback: false }),
  clearAccountError: async () => {},
  extractApiKey: () => null,
}));

vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));

vi.mock("@/shared/utils/machineId", () => ({
  getConsistentMachineId: async () => "test-machine",
}));

const FORCED = ["openai", "codex", "commandcode"];

function makeOptions(bodyStream) {
  const body = {
    model: "gpt-4.1",
    messages: [{ role: "user", content: "hello" }],
  };
  if (bodyStream !== undefined) body.stream = bodyStream;

  return {
    body,
    modelInfo: { provider: "openai", model: "gpt-4.1" },
    credentials: { apiKey: "sk-test" },
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: "application/json" },
    },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

// The first test pays for importing chatCore's module graph (3s+ under full-suite
// load); a test that times out keeps running and its late fetch call leaks into the
// next test's mock counts, so give the file room instead of cascading failures.
describe("forceStream provider config", { timeout: 20_000 }, () => {
  beforeEach(() => {
    executeMock.mockReset();
    executeMock.mockRejectedValue(new Error("boom"));
  });

  it("only openai/codex/commandcode force streaming", async () => {
    const { PROVIDERS } = await import("../../open-sse/config/providers.js");
    for (const id of FORCED) {
      expect(PROVIDERS[id]?.forceStream, `${id} forced`).toBe(true);
    }
    // a sample of others must NOT force
    for (const id of ["deepseek", "claude", "gemini", "openrouter"]) {
      expect(PROVIDERS[id]?.forceStream, `${id} not forced`).not.toBe(true);
    }
  });

  it.each([undefined, false])( "keeps forced-stream providers streaming for JSON clients when body.stream is %s", async (bodyStream) => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

    await handleChatCore(makeOptions(bodyStream));

    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock.mock.calls[0][0].stream).toBe(true);
  });
});

const completion = {
  id: "chatcmpl-test",
  object: "chat.completion",
  created: 1,
  model: "gpt-4.1",
  choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 19, completion_tokens: 6, total_tokens: 25, prompt_tokens_details: { cached_tokens: 0 } },
};
const chunks = [
  { delta: { role: "assistant", content: "Hello" }, finish_reason: null },
  { delta: {}, finish_reason: "stop" },
].map((choice) => ({
  id: completion.id,
  object: "chat.completion.chunk",
  created: completion.created,
  model: completion.model,
  choices: [{ index: 0, ...choice }],
}));
const done = "data: [DONE]";

function upstreamSse() {
  const usageChunk = { ...chunks[0], choices: [], usage: completion.usage };
  const frames = [...chunks, usageChunk].map((chunk) => `data: ${JSON.stringify(chunk)}`);
  return new Response([...frames, done, ""].join("\n\n"), {
    headers: { "content-type": "text/event-stream" },
  });
}

async function postChat(stream, accept, model = "openai/gpt-4.1") {
  const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");
  const body = { model, messages: [{ role: "user", content: "hello" }], stream };
  const headers = { "content-type": "application/json" };
  if (accept) headers.accept = accept;
  return POST(new Request("http://localhost/api/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify(body),
  }));
}

describe("Chat Completions response format with forced upstream streaming", { timeout: 20_000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request"); }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, "application/json", "text/event-stream"])("returns JSON for stream:false with Accept %s", async (accept) => {
    executeMock.mockResolvedValue({ response: Response.json(completion) });

    const response = await postChat(false, accept);

    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    const text = await response.text();
    expect(text).not.toContain(done);
    // The JSON handler still applies the existing prompt-token margin on the wire.
    expect(JSON.parse(text)).toMatchObject({
      ...completion,
      usage: { completion_tokens: 6, prompt_tokens_details: { cached_tokens: 0 } },
    });
    const { saveRequestUsage } = await import("@/lib/usageDb.js");
    expect(saveRequestUsage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      tokens: expect.objectContaining({ prompt_tokens: 19, completion_tokens: 6, total_tokens: 25 }),
    }));
  });

  it.each([
    [false, undefined],
    [false, "application/json"],
    [undefined, undefined],
  ])("aggregates upstream SSE for stream:%s with Accept %s", async (stream, accept) => {
    executeMock.mockResolvedValue({ response: upstreamSse() });

    const response = await postChat(stream, accept);

    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject(completion);
  });

  it("converts forced Codex Responses SSE into Chat Completions JSON", async () => {
    const item = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Hello" }],
    };
    const events = [
      ["response.created", { response: { id: "resp-test", created_at: 1 } }],
      ["response.output_item.done", { output_index: 0, item }],
      ["response.completed", { response: { usage: { input_tokens: 19, output_tokens: 6, total_tokens: 25 } } }],
    ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
    executeMock.mockResolvedValue({
      response: new Response(events, { headers: { "content-type": "text/event-stream" } }),
    });

    const response = await postChat(false, "application/json", "codex/gpt-5.6-sol");

    expect(executeMock).toHaveBeenCalledWith(expect.objectContaining({
      stream: true,
      body: expect.objectContaining({ stream: true }),
    }));
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({
      id: "resp-test",
      object: "chat.completion",
      choices: completion.choices,
      usage: { prompt_tokens: 19, completion_tokens: 6, total_tokens: 25 },
    });
  });

  it.each([undefined, "application/json"])("keeps explicit streaming with Accept %s", async (accept) => {
    executeMock.mockResolvedValue({ response: upstreamSse() });

    const response = await postChat(true, accept);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const frames = (await response.text()).trim().split("\n\n");
    expect(frames.filter((frame) => frame === done)).toEqual([done]);
    expect(frames.pop()).toBe(done);
    const received = frames.map((frame) => JSON.parse(frame.slice("data: ".length)));
    expect(received.slice(0, 2)).toMatchObject(chunks);
    expect(received.at(-1)).toMatchObject({ choices: [], usage: completion.usage });
  });

  it("cancels the upstream body when the streaming client disconnects", async () => {
    const cancel = vi.fn();
    executeMock.mockResolvedValue({
      response: new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } }),
    });

    const response = await postChat(true, "application/json");
    await response.body.cancel("client disconnected");

    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it("honors Accept: application/json when stream is omitted and upstream responds with JSON", async () => {
    executeMock.mockResolvedValue({ response: Response.json(completion) });

    const response = await postChat(undefined, "application/json");

    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({ choices: completion.choices });
  });

  it("preserves an upstream HTTP error", async () => {
    executeMock.mockResolvedValue({
      response: Response.json({ error: { message: "Rate limited" } }, { status: 429, headers: { "retry-after": "10" } }),
    });

    const response = await postChat(false);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("10");
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("Rate limited") } });
  });

  it("returns a JSON gateway error for an unexpected upstream body", async () => {
    executeMock.mockResolvedValue({ response: new Response("<html>unexpected</html>", {
      headers: { "content-type": "text/html" },
    }) });

    const response = await postChat(false);

    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("Invalid JSON") } });
  });

  it("passes the Dashboard model probe through the chat route", async () => {
    const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");
    const { pingModelByKind } = await import("../../src/app/api/models/test/ping.js");
    executeMock.mockResolvedValue({ response: Response.json(completion) });
    vi.stubGlobal("fetch", vi.fn((url, options) => {
      expect(url).toBe("http://localhost/api/v1/chat/completions");
      return POST(new Request(url, options));
    }));

    await expect(pingModelByKind("openai/gpt-4.1", "llm", "http://localhost"))
      .resolves.toMatchObject({ ok: true, status: 200, error: null });
  });
});
