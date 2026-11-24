import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";

const reported = {
  prompt_tokens: 19,
  completion_tokens: 144,
  total_tokens: 163,
  prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 128, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
};
const chunk = { id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: "gpt-5-mini" };
const content = { ...chunk, choices: [{ index: 0, delta: { content: "123456789012345678901234" }, finish_reason: null }], usage: null };
const stop = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: null };
const trailer = { ...chunk, choices: [], usage: reported };
const done = "data: [DONE]";
const frame = (data) => `data: ${JSON.stringify(data)}\n\n`;

let dir, db, analytics, streaming, createStreamController;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "9router-chat-usage-"));
  vi.stubEnv("DATA_DIR", dir);
  vi.stubEnv("ENABLE_REQUEST_LOGS", "false");
  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();
  analytics = await import("@/lib/usageDb.js");
  streaming = await import("../../open-sse/handlers/chatCore/streamingHandler.js");
  ({ createStreamController } = await import("../../open-sse/utils/streamHandler.js"));
  const { initTranslators } = await import("../../open-sse/translator/index.js");
  await initTranslators();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  db.run("DELETE FROM usageHistory");
  db.run("DELETE FROM usageDaily");
});

function setup(upstream, { includeUsage, provider = "openai", targetFormat = FORMATS.OPENAI, streamController = createStreamController() } = {}) {
  const body = { model: "gpt-5-mini", messages: [{ role: "user", content: "" }], stream: true };
  if (includeUsage !== undefined) body.stream_options = { include_usage: includeUsage };
  body.messages[0].content = "x".repeat(192 - JSON.stringify(body).length);
  const ctx = {
    provider, model: "gpt-5-mini", sourceFormat: FORMATS.OPENAI, targetFormat,
    body, stream: true, connectionId: "fixture-account", requestStartTime: Date.now(),
    clientRawRequest: { body, endpoint: "/v1/chat/completions" },
    providerResponse: new Response(upstream, { headers: { "content-type": "text/event-stream" } }),
    streamController,
  };
  return streaming.handleStreamingResponse({ ...ctx, ...streaming.buildOnStreamComplete(ctx) });
}

async function readFrames(response) {
  const frames = (await response.text()).trim().split("\n\n").map((line) => line.trim()).filter(Boolean);
  expect(frames.filter((line) => line === done)).toEqual([done]);
  expect(frames.pop()).toBe(done);
  return frames.map((line) => JSON.parse(line.slice("data: ".length)));
}

async function history() {
  await vi.waitFor(async () => expect(await analytics.getUsageHistory()).toHaveLength(1));
  const [entry] = await analytics.getUsageHistory();
  return entry.tokens;
}

describe("chat usage from provider events through SQLite and Analytics", () => {
  it("keeps only the final real OpenAI usage and records it once", async () => {
    const { response } = await setup(frame(content) + frame(stop) + frame(trailer) + done + "\n\n", { includeUsage: true });
    const frames = await readFrames(response);
    const tokens = await history();
    const daily = JSON.parse(db.get("SELECT data FROM usageDaily").data);
    const stats = await analytics.getUsageStats("all");

    expect({
      wire: frames.map((item) => item.usage),
      stored: [tokens.prompt_tokens, tokens.completion_tokens, tokens.total_tokens, tokens.reasoning_tokens],
      daily: [daily.requests, daily.promptTokens, daily.completionTokens],
      stats: [stats.totalPromptTokens, stats.totalCompletionTokens],
    }).toEqual({
      wire: [null, null, reported],
      stored: [19, 144, 163, 128],
      daily: [1, 19, 144],
      stats: [19, 144],
    });
    expect(frames.at(-1).choices).toEqual([]);
    expect(tokens.prompt_tokens_details).toEqual(reported.prompt_tokens_details);
    expect(tokens.completion_tokens_details).toEqual(reported.completion_tokens_details);
  });

  it("keeps explicit zero usage in a terminal trailer and does not estimate", async () => {
    const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    const { response } = await setup(frame(content) + frame(stop) + frame({ ...trailer, usage }) + done + "\n\n", { includeUsage: true });
    expect((await readFrames(response)).map((event) => event.usage)).toEqual([null, null, usage]);
    expect(await history()).toMatchObject(usage);
    expect((await history()).estimated).toBeUndefined();
  });

  it.each([undefined, false])("keeps consumption internal with include_usage=%s", async (includeUsage) => {
    const { response } = await setup(frame(content) + frame(stop) + frame(trailer) + done + "\n\n", { includeUsage });
    const frames = await readFrames(response);
    const tokens = await history();
    expect(frames.map((item) => item.choices)).toEqual([content.choices, stop.choices]);
    expect(frames.every((item) => !Object.hasOwn(item, "usage"))).toBe(true);
    expect(tokens).toMatchObject({ prompt_tokens: 19, completion_tokens: 144, total_tokens: 163, reasoning_tokens: 128 });
  });

  it("marks a fallback estimate in SQLite after EOF and leaves it off the wire", async () => {
    const { response } = await setup(frame(content) + frame(stop), { includeUsage: true });
    const frames = await readFrames(response);
    const tokens = await history();
    expect(frames.map((item) => item.usage)).toEqual([null, null]);
    expect(tokens).toEqual({ prompt_tokens: 48, completion_tokens: 6, total_tokens: 54, estimated: true });
  });

  it("keeps a final usage event without a terminating newline", async () => {
    const { response } = await setup(frame(content) + frame(stop) + frame(trailer).trimEnd(), { includeUsage: true });
    const frames = await readFrames(response);
    expect(frames.at(-1)).toEqual(trailer);
    expect(await history()).toMatchObject({ prompt_tokens: 19, completion_tokens: 144, total_tokens: 163 });
  });

  it.each(["cancel", "abort"])("preserves usage and [DONE] on %s after the terminal event", async (end) => {
    const streamController = createStreamController();
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(content) + frame(stop) + frame(trailer) + done + "\n\n"));
        streamController.signal.addEventListener("abort", () => {
          controller.error(new DOMException("upstream disconnected", "AbortError"));
        }, { once: true });
      },
    });
    const { response } = await setup(upstream, { includeUsage: true, streamController });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let wire = "";
    while (!wire.includes(done)) {
      const { value, done: closed } = await reader.read();
      expect(closed).toBe(false);
      wire += decoder.decode(value, { stream: true });
    }
    if (end === "cancel") await reader.cancel();
    else {
      streamController.abort();
      for (;;) {
        const { value, done: closed } = await reader.read();
        if (closed) break;
        wire += decoder.decode(value, { stream: true });
      }
      expect(wire.match(/data: \[DONE\]/g)).toHaveLength(1);
      expect(wire).not.toContain('"error"');
    }
    expect(await history()).toMatchObject({ prompt_tokens: 19, completion_tokens: 144, total_tokens: 163 });
  });

  it("keeps a truncated stream without reported usage out of Analytics", async () => {
    const { response } = await setup(frame(content), { includeUsage: true });
    expect(await readFrames(response)).toEqual([content]);
    expect(await analytics.getUsageHistory()).toEqual([]);
    expect(db.get("SELECT data FROM usageDaily")).toBeUndefined();
  });

  it("keeps unknown usage off the ledger when the client cancels", async () => {
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(content)));
      },
    });
    const { response } = await setup(upstream, { includeUsage: true });
    const reader = response.body.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();

    expect(await analytics.getUsageHistory()).toEqual([]);
  });

  it("reports an interrupted upstream without creating an estimate", async () => {
    const streamController = createStreamController();
    const upstream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(content)));
        streamController.signal.addEventListener("abort", () => {
          controller.error(new DOMException("upstream timeout", "AbortError"));
        }, { once: true });
      },
    });
    const { response } = await setup(upstream, { includeUsage: true, streamController });
    const reader = response.body.getReader();
    expect((await reader.read()).done).toBe(false);
    streamController.abort();
    let tail = "";
    for (;;) {
      const { value, done: closed } = await reader.read();
      if (closed) break;
      tail += new TextDecoder().decode(value);
    }
    expect(tail).toContain('"error"');
    expect(tail.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(await analytics.getUsageHistory()).toEqual([]);
  });

  it("combines actual Anthropic input/cache and output events for a Chat Completions client", async () => {
    const native = [
      { type: "message_start", message: { id: "msg-test", model: "claude-test", usage: { input_tokens: 19, cache_read_input_tokens: 20, cache_creation_input_tokens: 2, output_tokens: 1 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 144 } },
      { type: "message_stop" },
    ].map((item) => `event: ${item.type}\n${frame(item)}`).join("");
    const { response } = await setup(native, { includeUsage: true, provider: "anthropic", targetFormat: FORMATS.CLAUDE });
    const frames = await readFrames(response);
    const tokens = await history();
    expect(frames.slice(0, -1).every((item) => item.usage === null)).toBe(true);
    expect(frames.at(-1)).toMatchObject({
      choices: [], usage: { prompt_tokens: 41, completion_tokens: 144, total_tokens: 185, prompt_tokens_details: { cached_tokens: 20 } },
    });
    expect(tokens).toMatchObject({ prompt_tokens: 41, completion_tokens: 144, total_tokens: 185, cached_tokens: 20, cache_creation_input_tokens: 2 });
  });

  it("uses actual Codex Responses counts and reasoning in the Chat Completions trailer", async () => {
    const events = [
      { type: "response.created", response: { id: "resp-test", model: "gpt-5-mini", created_at: 1 } },
      { type: "response.output_text.delta", delta: "hello" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 19, output_tokens: 144, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 128 } },
        },
      },
    ].map((item) => `event: ${item.type}\n${frame(item)}`).join("");
    const { response } = await setup(events, { includeUsage: true, provider: "codex", targetFormat: FORMATS.OPENAI_RESPONSES });
    const frames = await readFrames(response);
    expect(frames.at(-1)).toMatchObject({
      choices: [],
      usage: {
        prompt_tokens: 19, completion_tokens: 144, total_tokens: 163,
        prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 128 },
      },
    });
    expect(await history()).toMatchObject({
      prompt_tokens: 19, completion_tokens: 144, total_tokens: 163, cached_tokens: 3, reasoning_tokens: 128,
    });
  });
});

describe("internal upstream usage requests", () => {
  it("requests usage from native OpenAI streaming without mutating client options", async () => {
    const { DefaultExecutor } = await import("../../open-sse/executors/default.js");
    const clientBody = { model: "gpt-5-mini", stream: true, stream_options: { include_usage: false, include_obfuscation: false } };
    const executor = new DefaultExecutor("openai");

    expect(executor.transformRequest(clientBody.model, clientBody, true).stream_options)
      .toEqual({ include_usage: true, include_obfuscation: false });
    expect(clientBody.stream_options).toEqual({ include_usage: false, include_obfuscation: false });
    const { stream_options, ...streaming } = clientBody;
    expect(executor.transformRequest(streaming.model, streaming, true).stream_options).toEqual({ include_usage: true });
    expect(executor.transformRequest(streaming.model, { ...streaming, stream: false }, true).stream_options).toBeUndefined();
    const compatible = new DefaultExecutor("openai-compatible-fixture");
    expect(compatible.transformRequest(streaming.model, streaming, true).stream_options).toBeUndefined();
  });
});
