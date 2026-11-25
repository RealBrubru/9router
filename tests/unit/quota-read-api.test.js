import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const day = 86400;
const utcDay = Math.floor(Date.now() / 1000 / day) * day;
const start = utcDay - day;
const end = utcDay;
const window = `start=${start}&end=${end}`;
const issuer = "https://fixture.invalid/oidc";
const secretRef = "ref:private-fixture-a";
const adminCredential = "fixture-administrative-credential";
const externalId = "fictional-provider-organization";
const model = "fixture-model";
const usageRow = {
  object: "organization.usage.completions.result",
  model, service_tier: "incentivized-tier",
  input_tokens: 40, output_tokens: 11, num_model_requests: 2, input_cached_tokens: 17,
  project_id: "fictional-project-private", api_key_id: "fictional-inference-key-private",
};
let temp, db, repo, readList, readSnapshots, token, delegated, outsider, oldOidc, saml, createAdapter;

function request(suffix, auth, headers = {}) {
  const cookie = auth ? { cookie: `auth_token=${auth}` } : {};
  return new NextRequest("http://localhost/api/quota/organizations" + suffix, { headers: { ...cookie, ...headers } });
}

async function get(id, search = window, auth = token) {
  return readSnapshots(request(`/${id}/snapshots?${search}`, auth), { params: Promise.resolve({ orgId: id }) });
}

function organization(id, readers = []) {
  return {
    id, provider: "openai", externalId: externalId + "-" + id, credentialRef: secretRef, enabled: true,
    config: { groups: [{ id: "fixture-group", limit: 500, models: [model] }], oidcReaders: readers },
  };
}

function sample(buckets) {
  return Response.json({
    object: "page", has_more: false, next_page: null,
    data: buckets.map(([lo, hi, results]) => ({ object: "bucket", start_time: lo, end_time: hi, results })),
  });
}

function adapter(reply, now) {
  return createAdapter({ resolveCredential: async () => adminCredential, fetchImpl: async () => reply, now, maxRetries: 0 });
}

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "quota-read-"));
  vi.stubEnv("DATA_DIR", temp);
  vi.stubEnv("JWT_SECRET", "test-only-quota-session-signing-fixture");
  vi.stubEnv("QUOTA_COLLECTOR_ENABLED", "true");
  const { getAdapter } = await import("@/lib/db/driver.js");
  const { createQuotaRepository } = await import("@/lib/db/repos/quotaRepo.js");
  ({ createOpenAIQuotaAdapter: createAdapter } = await import("@/lib/quota/openai.js"));
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");
  ({ GET: readList } = await import("@/app/api/quota/organizations/route.js"));
  ({ GET: readSnapshots } = await import("@/app/api/quota/organizations/[orgId]/snapshots/route.js"));
  db = await getAdapter();
  repo = createQuotaRepository(db);
  repo.putOrganization(organization("alpha", [{ issuer, subject: "fixture-reader" }]));
  repo.putOrganization(organization("beta"));
  repo.putOrganization(organization("stale"));
  token = await createDashboardAuthToken();
  delegated = await createDashboardAuthToken({ oidc: true, oidcIssuer: issuer, oidcSub: "fixture-reader" });
  outsider = await createDashboardAuthToken({ oidc: true, oidcIssuer: "https://other.fixture.invalid", oidcSub: "fixture-reader" });
  oldOidc = await createDashboardAuthToken({ oidc: true, oidcSub: "fixture-reader" });
  saml = await createDashboardAuthToken({ saml: true });
  await repo.collect("alpha", { source: "usage", start, end }, adapter(sample([[start, end, [
    usageRow, { ...usageRow, input_tokens: 5, output_tokens: 3, num_model_requests: 1, input_cached_tokens: 0,
      api_key_id: "another-fictional-inference-key" },
    { ...usageRow, service_tier: "default", input_cached_tokens: null },
  ]]])));
  await repo.collect("alpha", { source: "costs", start, end }, adapter(sample([[start, end, [
    { object: "organization.costs.result", line_item: "fixture-zero", quantity: 50, amount: { value: 0, currency: "usd" } },
    { object: "organization.costs.result", line_item: "fixture-unknown", quantity: 19 },
  ]]])));
  await repo.collect("stale", { source: "usage", start, end },
    adapter(sample([[start, end, [usageRow]]]), () => Date.now() - 400_000));
  repo.writeSchedule("alpha", "usage", "1d", { nextAt: 1_800_000_000_000, failures: 0 });
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  await updateSettings({ requireLogin: false });
});
afterAll(() => {
  db?.close();
  delete global._dbAdapter;
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("quota administrative read routes", () => {
  it("accepts an installation administrator session and denies anonymous, CLI and inference keys", async () => {
    expect((await readList(request("", token))).status).toBe(200);
    expect((await readList(request("", null))).status).toBe(401);
    expect((await readList(request("", null, { authorization: "Bearer synthetic-inference-key" }))).status).toBe(401);
    expect((await readList(request("", null, { "x-9r-cli-token": "synthetic-cli-key" }))).status).toBe(401);
    expect((await get("alpha", window, null)).status).toBe(401);
    expect((await readList(request("", "invalid-session"))).status).toBe(401);
  });

  it("scopes OIDC to the configured issuer and subject and conceals other organizations", async () => {
    const allowed = await readList(request("", delegated)).then(res => res.json());
    expect(allowed.data.map(org => org.id)).toEqual(["alpha"]);
    expect((await get("alpha", window, delegated)).status).toBe(200);
    expect((await get("beta", window, delegated)).status).toBe(404);
    expect((await get("missing", window, delegated)).status).toBe(404);
    expect((await readList(request("", outsider)).then(res => res.json())).data).toEqual([]);
    expect((await readList(request("", oldOidc))).status).toBe(401);
    expect((await readList(request("", saml))).status).toBe(401);
  });

  it("returns grouped Usage, timing and schedule, omitting sensitive identifiers", async () => {
    const reply = await get("alpha", window, delegated);
    expect(reply.headers.get("cache-control")).toBe("private, no-store");
    const raw = await reply.text();
    const data = JSON.parse(raw);
    expect(data).toMatchObject({
      status: "valid", coverage: "full", gaps: [], window: { start, end },
      lastSuccess: { window: { start, end }, dataAsOf: null },
      lastAttempt: { outcome: "success", window: { start, end } },
      schedule: { enabled: true, nextAt: 1_800_000_000_000, consecutiveFailures: 0 },
      groups: [{ id: "fixture-group" }],
    });
    expect(data.records.data).toEqual([
      { model, serviceTier: "incentivized-tier", incentive: "incentivized", input_tokens: 45, output_tokens: 14,
        num_model_requests: 3, input_cached_tokens: 17 },
      { model, serviceTier: "default", incentive: "other", input_tokens: 40, output_tokens: 11,
        num_model_requests: 2, input_cached_tokens: null },
    ]);
    for (const value of [secretRef, adminCredential, externalId, issuer, usageRow.project_id, usageRow.api_key_id, "credentialRef", "observationId"]) {
      expect(raw).not.toContain(value);
    }
  });

  it("distinguishes stale and unknown windows, zero costs and missing costs", async () => {
    const stale = await get("stale").then(res => res.json());
    expect(stale.status).toBe("stale");
    const unknown = await get("beta").then(res => res.json());
    expect(unknown).toMatchObject({ status: "unknown", coverage: "missing", gaps: [{ start, end }], lastSuccess: null });
    const costs = await get("alpha", window + "&source=costs").then(res => res.json());
    expect(costs.records.data.map(row => row.amount)).toEqual([{ value: "0", currency: "usd" }, null]);
  });

  it("validates parameters, paginates and performs no network or database writes", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network denied"));
    try {
      const before = db.get("SELECT total_changes() AS n").n;
      for (const invalid of ["limit=101", "start=-1", "start=1", "start=2&start=2", "source=x", "source=costs&resolution=1m", "ref=hidden"]) {
        expect((await get("alpha", invalid)).status).toBe(400);
      }
      expect(await get("alpha", window + "&limit=1").then(res => res.json()))
        .toMatchObject({ records: { nextOffset: 1, data: [{ serviceTier: "incentivized-tier" }] } });
      expect(await get("alpha", window + "&limit=1&offset=1").then(res => res.json()))
        .toMatchObject({ records: { nextOffset: null, data: [{ serviceTier: "default" }] } });
      expect(fetcher).not.toHaveBeenCalled();
      expect(db.get("SELECT total_changes() AS n").n).toBe(before);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("preserves a historical revision but surfaces a gap if the latest collection omits it", async () => {
    const query = { source: "usage", start: start - day, end };
    await repo.collect("beta", query, adapter(sample([
      [start - day, start, [usageRow]], [start, end, [{ ...usageRow, input_tokens: 12 }]],
    ])));
    await repo.collect("beta", query, adapter(sample([
      [start - day, start, [{ ...usageRow, input_tokens: 15 }]],
    ])));
    const data = await get("beta", `start=${query.start}&end=${end}`).then(res => res.json());
    expect(data).toMatchObject({
      status: "valid", coverage: "partial", gaps: [{ start, end }],
      records: { data: [{ input_tokens: 15 }] },
      buckets: [{ start: start - day, omitted: false }, { start, omitted: true }],
    });
    expect(repo.listObservedBuckets("beta", query)[1].rows[0].input_tokens).toBe(12);
  });
});
