import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const route = "/api/quota/organizations";
const groupId = "fixture-group";
const issuer = "https://fixture.invalid/oidc";
const minute = 60_000;
const start = Date.UTC(2026, 0, 2);
const clock = start + 30 * minute;
const dayEnd = start + 1440 * minute;
const usageRow = {
  model: "fixture-model", service_tier: "incentivized-tier", incentive: "incentivized",
  input_tokens: 300, output_tokens: 300, num_model_requests: 1,
  project_id: "fixture-private-project", api_key_id: "fixture-private-key-id",
};

let temp, db, repo, readRoute, proxy, createQuotaReadApi, readService, createQuotaRepository;
let operator, delegated, outsider, oldOidc, saml, cold;

function request({ organization = "alpha", group = groupId, query = "", cookie = operator, headers = {} } = {}) {
  return new NextRequest(`http://localhost${route}/${organization}/groups/${group}/reconciliation${query ? "?" + query : ""}`, {
    headers: { ...(cookie ? { cookie: `auth_token=${cookie}` } : {}), ...headers },
  });
}

function get(options = {}) {
  return readRoute(request(options), {
    params: Promise.resolve({ orgId: options.organization ?? "alpha", groupId: options.group ?? groupId }),
  });
}

function organization(id, config = {}) {
  return {
    id, provider: "openai", externalId: "fixture-private-organization-" + id,
    credentialRef: "ref:fixture-private-secret", enabled: true,
    config: { groups: [{ id: groupId, limit: 1000, models: [usageRow.model] }], ...config },
  };
}

function collect(repository, id, { amount = 300, collectedAt = clock, resolution = "1d", rows, dataAsOf = null } = {}) {
  return repository.collect(id, { source: "usage", resolution, start: start / 1000, end: collectedAt / 1000 }, {
    collect: async query => ({
      query, startedAt: collectedAt, collectedAt, dataAsOf,
      buckets: [{
        start: start / 1000, end: (resolution === "1d" ? dayEnd : start + minute) / 1000,
        rows: rows ?? [{ ...usageRow, input_tokens: amount }],
      }],
    }),
  });
}

beforeAll(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "quota-reconciliation-api-"));
  vi.stubEnv("DATA_DIR", temp);
  vi.stubEnv("JWT_SECRET", undefined);
  vi.stubEnv("QUOTA_COLLECTOR_ENABLED", "false");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  const { getAdapter } = await import("@/lib/db/driver.js");
  ({ createQuotaRepository } = await import("@/lib/db/repos/quotaRepo.js"));
  ({ createQuotaReadApi } = await import("@/lib/quota/readApi.js"));
  ({ createQuotaReconciliationReadService: readService } = await import("@/lib/quota/reconciliationReadService.js"));
  ({ GET: readRoute } = await import("@/app/api/quota/organizations/[orgId]/groups/[groupId]/reconciliation/route.js"));
  ({ default: proxy } = await import("@/proxy.js"));
  const { createDashboardAuthToken } = await import("@/lib/auth/dashboardSession.js");

  const invalid = request({ cookie: null, headers: { cookie: "auth_token=invalid; 9r_mimo_login=invalid" } });
  const beforeRoute = await proxy(invalid);
  const beforeSigning = await readRoute(invalid, { params: { orgId: "alpha", groupId } });
  const authSecretCreatedByRead = fs.existsSync(path.join(temp, "jwt-secret"));
  operator = await createDashboardAuthToken();
  const signedProxy = await proxy(request());
  const beforeDatabase = await get();
  cold = {
    proxyAuthenticationStatus: beforeRoute.status,
    proxyCache: beforeRoute.headers.get("cache-control"),
    signedProxyPassedToHandler: signedProxy.headers.get("x-middleware-next") === "1",
    authenticationStatus: beforeSigning.status,
    authenticationCache: beforeSigning.headers.get("cache-control"),
    authSecretCreatedByRead,
    databaseCreatedByRead: fs.existsSync(path.join(temp, "db")),
    authenticatedStatus: beforeDatabase.status,
    authenticatedCache: beforeDatabase.headers.get("cache-control"),
  };

  db = await getAdapter();
  repo = createQuotaRepository(db);
  repo.putOrganization(organization("alpha", { oidcReaders: [{ issuer, subject: "fixture-reader" }] }));
  for (const id of ["empty", "stale", "revised", "zero", "broken"]) repo.putOrganization(organization(id));
  repo.putOrganization(organization("unsupported", { timeZone: "America/Sao_Paulo" }));
  db.run("UPDATE quotaOrganizations SET config = ? WHERE id = 'broken'", ['fixture-private-corrupt-config']);

  await collect(repo, "alpha");
  await collect(repo, "alpha", { resolution: "1m", amount: 1 });
  await collect(repo, "stale", { collectedAt: clock - 6 * minute });
  await collect(repo, "revised");
  await collect(repo, "revised", { amount: 100 });
  await collect(repo, "zero", { rows: [] });

  db.run(`INSERT INTO providerConnections(id, provider, authType, data, createdAt, updatedAt)
    VALUES ('fixture-connection', 'openai', 'apikey', ?, 'fixture', 'fixture')`,
  [JSON.stringify({ apiKey: "fixture-private-provider-credential" })]);
  repo.bindConnection({ organizationId: "alpha", connectionId: "fixture-connection",
    apiKeyId: usageRow.api_key_id, projectId: usageRow.project_id, validFrom: start });
  db.run(`INSERT INTO usageHistory(timestamp, provider, model, connectionId, apiKey, endpoint, tokens, meta)
    VALUES (?, 'openai', ?, 'fixture-connection', 'fixture-private-client-key', '/fixture-private-endpoint', ?, 'fixture-private-payload')`,
  [new Date(start + 1000).toISOString(), usageRow.model, JSON.stringify({ prompt_tokens: 19, completion_tokens: 144 })]);
  const { updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
  await updateSettings({ requireLogin: false });

  delegated = await createDashboardAuthToken({ oidc: true, oidcIssuer: issuer, oidcSub: "fixture-reader" });
  outsider = await createDashboardAuthToken({ oidc: true, oidcIssuer: "https://other.fixture.invalid", oidcSub: "fixture-reader" });
  oldOidc = await createDashboardAuthToken({ oidc: true, oidcSub: "fixture-reader" });
  saml = await createDashboardAuthToken({ saml: true });
});

afterAll(() => {
  db?.close();
  delete global._dbAdapter;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { force: true, recursive: true });
});

describe("administrative quota reconciliation route", () => {
  it("leaves authentication and the database untouched by a cold request", () => {
    expect(cold).toEqual({
      proxyAuthenticationStatus: 401,
      proxyCache: "private, no-store",
      signedProxyPassedToHandler: true,
      authenticationStatus: 401,
      authenticationCache: "private, no-store",
      authSecretCreatedByRead: false,
      databaseCreatedByRead: false,
      authenticatedStatus: 503,
      authenticatedCache: "private, no-store",
    });
  });

  it("requires an administrative session regardless of requireLogin or caller keys", async () => {
    expect((await get()).status).toBe(200);
    for (const options of [
      { cookie: null }, { cookie: "invalid" }, { cookie: oldOidc }, { cookie: saml },
      { cookie: null, headers: { authorization: "Bearer fixture-inference-key" } },
      { cookie: null, headers: { "x-api-key": "fixture-inference-key" } },
      { cookie: null, headers: { "x-9r-cli-token": "fixture-cli-key" } },
    ]) {
      const res = await get(options);
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    }
  });

  it("applies organization delegation and hides unauthorized or nonexistent scopes", async () => {
    expect((await get({ cookie: delegated })).status).toBe(200);
    for (const options of [
      { organization: "empty", cookie: delegated }, { organization: "missing", cookie: delegated }, { cookie: outsider },
      { organization: "missing" },
    ]) {
      const res = await get(options);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Organization not found" });
    }
    for (const query of ["", `evaluatedAt=${start - 1}`]) {
      const res = await get({ group: "missing", query, cookie: delegated });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Group not found" });
    }
  });

  it("validates identifiers, resolutions and millisecond cutoffs without reflecting input", async () => {
    for (const options of [
      { organization: "bad.id" }, { group: "bad.group" }, { query: "resolution=1h" },
      { query: "resolution=1d&resolution=1m" }, { query: "start=1" }, { query: "secret=fixture-private-request" },
      { query: "evaluatedAt=-1" }, { query: "evaluatedAt=1.5" }, { query: `evaluatedAt=${clock + 1}` },
      { query: `knowledgeAt=${clock}` }, { query: `evaluatedAt=${clock}&knowledgeAt=${clock - 1}` },
      { query: `evaluatedAt=${clock}&knowledgeAt=${clock + 1}` },
    ]) {
      const res = await get(options);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid quota query" });
    }
    expect(await get({ query: "resolution=1m" }).then(res => res.json()))
      .toMatchObject({ resolution: "1m", remote: { incentivized: "301" } });
  });

  it("returns the public diagnostic fields and preserves subtotals with an unknown balance", async () => {
    const res = await get({ cookie: delegated });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const raw = await res.text();
    expect(JSON.parse(raw)).toMatchObject({
      status: "available",
      scope: { organizationId: "alpha", groupId, unit: "tokens" },
      evaluation: { mode: "contemporaneous", evaluatedAt: clock, knowledgeAt: clock },
      quality: {
        temporal: { status: "full" }, population: "complete", collection: { status: "recent" },
        completeness: { status: "unknown" }, local: { status: "partial" },
        external: { status: "unreported_possible", attribution: "unknown", reported: null },
      },
      remote: { incentivized: "600" },
      local: { totals: { observed: "163", estimated: null }, limitations: expect.arrayContaining(["no_attempt_lifecycle"]) },
      observations: [{ dataAsOf: null }],
      indicative: { status: "unknown", amount: null, blockers: [{ code: "local_coverage_partial" }] },
    });
    for (const value of [
      usageRow.project_id, usageRow.api_key_id, usageRow.model, issuer, "fixture-connection", "fixture-private",
      "credentialRef", "revisionRef", "projectId", "apiKeyId", "policyRevision", "bindingAtRecordedTime",
      "staleObservationIds", "subject", '"rows"', '"events"', "operationalBalance", "guaranteedBalance",
    ]) expect(raw).not.toContain(value);
  });

  it("distinguishes absent, zero, stale and revised observations", async () => {
    expect(await get({ organization: "empty" }).then(res => res.json())).toMatchObject({
      remote: null, observations: [], quality: { temporal: { status: "missing" }, local: { status: "unknown" } },
      indicative: { amount: null, status: "unknown" },
    });
    expect(await get({ organization: "zero" }).then(res => res.json())).toMatchObject({
      remote: { incentivized: "0" }, indicative: { amount: null },
    });
    const stale = await get({ organization: "stale" }).then(res => res.json());
    expect(stale).toMatchObject({
      remote: { incentivized: "600" }, quality: { collection: { status: "stale" }, completeness: { status: "unknown" } },
      indicative: { amount: null, limitations: expect.arrayContaining(["remote_collection_stale"]) },
    });
    expect(JSON.stringify(stale)).not.toContain("staleObservationIds");
    const revised = await get({ organization: "revised" }).then(res => res.json());
    expect(revised.remote.incentivized).toBe("400");
    expect(revised.observations).toHaveLength(1);
  });

  it("reports unavailable history explicitly and uses safe error messages", async () => {
    for (const query of [
      `evaluatedAt=${start - 1}`,
      `evaluatedAt=${clock - 1}&knowledgeAt=${clock - 1}`,
    ]) {
      const res = await get({ query });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await res.json()).toMatchObject({ status: "unavailable", reason: "historical_state_unavailable", result: null });
    }
    const unsupported = await get({ organization: "unsupported" });
    expect(unsupported.status).toBe(422);
    expect(await unsupported.json()).toEqual({ status: "unavailable", reason: "unsupported_quota_scope", result: null });
    const broken = await get({ organization: "broken" });
    expect(broken.status).toBe(503);
    expect(broken.headers.get("cache-control")).toBe("private, no-store");
    expect(await broken.json()).toEqual({ error: "Quota data unavailable" });
  });

  it.each(["current", "historical"])("forwards the service's %s indication without recalculation", async status => {
    const api = createQuotaReadApi({
      openReconciliationDb: () => db,
      createReconciliationService: (adapter, options) => ({
        read(input) {
          const view = readService(adapter, options).read(input);
          view.result.indicative = {
            ...view.result.indicative,
            amount: "7", status, assumptions: ["external_usage_only_as_reported"],
            blockers: [],
          };
          view.result.quality.external.credentialRef = "unexpected-fixture-ref";
          view.provenance.local.totals.apiKey = "unexpected-fixture-key";
          view.provenance.remote.buckets[0].observedWindow.projectId = "unexpected-fixture-project";
          return view;
        },
      }),
    });
    const body = await api.reconciliation(request(), "alpha", groupId).then(res => res.json());
    expect(body.indicative).toMatchObject({ amount: "7", status, assumptions: ["external_usage_only_as_reported"] });
    expect(JSON.stringify(body)).not.toContain("unexpected-fixture-");
  });

  it("does not perform network calls or writes for an authenticated read", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    try {
      const before = db.get("SELECT total_changes() AS n").n;
      expect((await get()).status).toBe(200);
      expect(fetcher).not.toHaveBeenCalled();
      expect(db.get("SELECT total_changes() AS n").n).toBe(before);
    } finally {
      fetcher.mockRestore();
    }
  });

  it("does not schedule a file export on the sql.js fallback", async () => {
    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const { TABLES, buildCreateTableSql } = await import("@/lib/db/schema.js");
    const file = path.join(temp, "fallback-fixture.sqlite");
    const writer = await createSqlJsAdapter(file);
    try {
      for (const name of ["quotaOrganizations", "quotaConnectionBindings", "quotaBuckets", "quotaCollectionState", "usageHistory"]) {
        writer.exec(buildCreateTableSql(name, TABLES[name]));
      }
      const repository = createQuotaRepository(writer);
      repository.putOrganization(organization("alpha"));
      await collect(repository, "alpha");
    } finally {
      writer.close();
    }
    const reader = await createSqlJsAdapter(file);
    const write = vi.spyOn(fs, "writeFileSync");
    try {
      const api = createQuotaReadApi({ openReconciliationDb: () => reader });
      const response = await api.reconciliation(request(), "alpha", groupId);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ remote: { incentivized: "600" } });
    } finally {
      reader.close(); // A dirty adapter would export synchronously on close.
      try {
        expect(write).not.toHaveBeenCalled();
      } finally {
        write.mockRestore();
      }
    }
  });
});
