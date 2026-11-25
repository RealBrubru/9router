// Observe upstream SSE during the existing text aggregation without storing its content.
export async function readAttemptSseText(response, attempt) {
  if (!attempt) return response.text();
  if (!response.body) {
    attempt.failure("transport_error");
    return response.text();
  }
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      attempt.sseChunk(chunk);
      controller.enqueue(chunk);
    },
    flush() { attempt.sseEof(); },
  }));
  try {
    return await new Response(stream).text();
  } catch (error) {
    attempt.failure(error.name === "TimeoutError" ? "timeout" : "transport_error");
    throw error;
  }
}
