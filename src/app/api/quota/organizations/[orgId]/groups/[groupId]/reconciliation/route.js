import { createQuotaReadApi } from "@/lib/quota/readApi.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const api = createQuotaReadApi();

export async function GET(request, { params }) {
  const { orgId, groupId } = await params;
  return api.reconciliation(request, orgId, groupId);
}
