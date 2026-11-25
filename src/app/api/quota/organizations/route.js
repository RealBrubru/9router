import { createQuotaReadApi } from "@/lib/quota/readApi.js";

export const runtime = "nodejs";

const api = createQuotaReadApi();

export async function GET(request) {
  return api.list(request);
}
