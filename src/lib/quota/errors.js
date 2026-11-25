export class QuotaCollectionError extends Error {
  constructor(code, status = null, retryAfterMs = null) {
    super(`Quota collection failed: ${code}`);
    this.name = "QuotaCollectionError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
