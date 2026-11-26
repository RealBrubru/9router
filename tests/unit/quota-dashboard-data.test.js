import { describe, expect, it, vi } from "vitest";
import {
  quotaIndicators, quotaOrganizationsUrl, readQuotaDashboard, reconciliationUrl, snapshotUrl,
} from "@/app/(dashboard)/dashboard/quota-manager/quotaDashboardData.js";

const group = { modelCount: 1 };
const available = (indicative, remote = { incentivized: "0", unclassifiedModel: "5" }) => ({
  status: "available", remote, indicative, local: {
    totals: { observed: "32" },
    registry: { totals: { observed: "32" }, counts: { measured: 2, pending: 1, unknown: 1 } },
  },
});

describe("quota dashboard view data", () => {
  it.each(["current", "historical"])("preserves explicit zero and the %s amount from the engine", status => {
    const indicative = { status, amount: "9007199254740993", referenceWindow: { start: 0, end: 1 } };
    expect(quotaIndicators(available(indicative), group)).toEqual({
      incentivized: "0", unclassified: "5", indicative, observed: "32", legacy: "32",
      counts: { measured: 2, pending: 1, unknown: 1 },
    });
    expect(quotaIndicators(available({ ...indicative, amount: "0" }), group).indicative.amount).toBe("0");
  });

  it("keeps absent or unusable data unknown and keeps observed subtotals", () => {
    expect(quotaIndicators(available({ status: "unknown", amount: "12" }, null), group)).toMatchObject({
      incentivized: null, unclassified: null, indicative: null, observed: "32", legacy: "32",
    });
    expect(quotaIndicators(available({ status: "current", amount: null }), { modelCount: 0 })).toMatchObject({
      incentivized: null, unclassified: "5", indicative: null,
    });
    expect(quotaIndicators({ status: "unavailable" }, group)).toEqual({
      incentivized: null, unclassified: null, indicative: null, observed: null, legacy: null, counts: null,
    });
  });

  it("uses local daily APIs and an exact UTC day for historical costs", () => {
    const usage = new URL(snapshotUrl("fixture-org", "usage"), "http://localhost");
    const costs = new URL(snapshotUrl("fixture-org", "costs", { previousDayStart: 172800, offset: 100 }), "http://localhost");
    expect(Object.fromEntries(usage.searchParams)).toEqual({ source: "usage", resolution: "1d", offset: "0", limit: "1" });
    expect(Object.fromEntries(costs.searchParams)).toEqual({
      source: "costs", resolution: "1d", start: "86400", end: "172800", offset: "100", limit: "100",
    });
    expect(reconciliationUrl("fixture-org", "fixture-group"))
      .toBe("/api/quota/organizations/fixture-org/groups/fixture-group/reconciliation");
  });

  it("paginates accessible organizations without duplicating IDs", async () => {
    const first = { id: "fixture-first" }, second = { id: "fixture-second" };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [first], nextOffset: 100 }))
      .mockResolvedValueOnce(Response.json({ data: [first, second], nextOffset: null }));
    const signal = new AbortController().signal;
    await expect(readQuotaDashboard(quotaOrganizationsUrl, signal, fetchImpl))
      .resolves.toEqual({ organizations: [first, second], truncated: false });
    expect(fetchImpl.mock.calls).toEqual([0, 100].map(offset => [
      quotaOrganizationsUrl + "?limit=100&offset=" + offset, { signal, cache: "no-store", credentials: "same-origin" },
    ]));
  });

  it("marks a truncated organization list at the display bound", async () => {
    let nextOffset = 0;
    const fetchImpl = vi.fn(async () => Response.json({ data: [], nextOffset: nextOffset += 100 }));
    await expect(readQuotaDashboard(quotaOrganizationsUrl, undefined, fetchImpl))
      .resolves.toEqual({ organizations: [], truncated: true });
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it.each([401, 403, 404, 503])("preserves HTTP %s without returning raw error details", async status => {
    await expect(readQuotaDashboard(quotaOrganizationsUrl, undefined, async () =>
      Response.json({ error: "fixture-sensitive-detail" }, { status })))
      .rejects.toMatchObject({ status, message: "Quota data unavailable" });
  });

  it("keeps the supported configuration limitation from reconciliation HTTP 422", async () => {
    const result = { status: "unavailable", reason: "unsupported_quota_scope", result: null };
    await expect(readQuotaDashboard(reconciliationUrl("a", "b"), undefined, async () => Response.json(result, { status: 422 })))
      .resolves.toEqual(result);
  });
});
