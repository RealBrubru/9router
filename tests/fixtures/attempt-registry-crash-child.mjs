import { register } from "node:module";

register(new URL("./attempt-registry-crash-loader.mjs", import.meta.url));

const { createBetterSqliteAdapter } = await import("../../src/lib/db/adapters/betterSqliteAdapter.js");
const { createOpenAiDirectAttemptPilot } = await import("../../src/lib/quota/openAiDirectAttemptPilot.js");

const [file, stage, connectionId] = process.argv.slice(2);
const db = createBetterSqliteAdapter(file);
let calls = 0;
let lastKind;
const storage = {
  ...db,
  run(sql, params) {
    if (sql.startsWith("INSERT INTO inferenceAttemptEvents")) lastKind = params[3];
    return db.run(sql, params);
  },
  transaction(action) {
    lastKind = null;
    const result = db.transaction(action);
    if (stage === "usage_committed" && lastKind === "usage") {
      // The supervisor kills this child after observing that the usage write
      // committed, while the separate finish transaction has yet to start.
      announce();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return result;
  },
};
const pilot = createOpenAiDirectAttemptPilot({ openDb: () => storage, env: { ATTEMPT_REGISTRY_OPENAI_DIRECT: "true" } });
const observer = pilot().forModel("openai/fixture-model").execution().prepare({
  connectionId, sentModel: "fixture-model",
});

function simulateTransport(request) {
  if (!request.body.includes("fixture-private-prompt")) throw new Error("fixture setup");
  calls++;
  return new Response(null, { headers: { "x-fixture": "fixture-private-response-header" } });
}

if (stage !== "prepared") observer.beforeSend(true);
if (!["prepared", "barrier"].includes(stage)) {
  const response = simulateTransport({ body: "fixture-private-prompt", auth: "fixture-private-secret" });
  if (stage !== "submitted") observer.observeResponse(response);
  if (["streaming", "buffered_usage", "usage_committed"].includes(stage)) {
    const encoder = new TextEncoder();
    observer.sseChunk(encoder.encode('data: {"model":"fixture-model","choices":[{"delta":{"content":"fixture-private-response"}}]}\n\n'));
    if (stage !== "streaming") {
      observer.sseChunk(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n'));
    }
    if (stage === "usage_committed") observer.sseChunk(encoder.encode("data: [DONE]\n\n"));
  }
}

function announce() {
  const { attemptId, instanceId } = db.get(`SELECT a.id AS attemptId, e.instanceId FROM inferenceAttempts a
    JOIN inferenceCoverageEpochs e ON a.epochId = e.id WHERE a.connectionId = ?`, [connectionId]);
  process.send({ attemptId, instanceId, calls });
}
process.on("message", message => {
  if (message === "ping") process.send("pong");
});
announce();
