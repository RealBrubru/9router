import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const [base, screenshotDir] = process.argv.slice(2);
if (!base || new URL(base).hostname !== "127.0.0.1") throw new Error("Use an isolated local Next.js server");

const day = 86_400;
const start = Math.floor(Date.now() / 1000 / day) * day;
const window = { start, end: start + 3600 };
const period = { start: start * 1000, end: window.end * 1000 };
const standard = { id: "standard", limit: 1000000, unit: "tokens", models: ["synthetic-alpha", "synthetic-beta"], modelCount: 2 };
const empty = { id: "unclassified", limit: 250000, unit: "tokens", models: [], modelCount: 0 };
const trimmed = { ...standard, id: "trimmed", modelCount: 102 };
const organizations = [
  { id: "example-org", groupCount: 3, provider: "openai" },
  { id: "empty-org", groupCount: 0, provider: "openai" },
  { id: "denied-org", groupCount: 0, provider: "openai" },
];
const costs = [
  { lineItem: "Incentivized input", amount: { value: "0", currency: "usd" } },
  { lineItem: "Unpriced output", amount: null },
];
const snapshot = {
  window, status: "valid", coverage: "full", gaps: [],
  schedule: { enabled: true, nextAt: period.end + 60_000, consecutiveFailures: 0 },
  lastSuccess: { collectedAt: period.end, dataAsOf: null },
};

function result(status) {
  const indeterminate = status === "unknown";
  return {
    status: "available", scope: { unit: "tokens" }, window: { start: period.start, end: period.start + day * 1000 },
    observations: [{ status: status === "historical" ? "stale" : "observed", dataAsOf: null }],
    quality: {
      temporal: { status: indeterminate ? "partial" : "full", gaps: indeterminate ? [period] : [] },
      population: "complete",
      collection: { status: status === "historical" ? "stale" : "recent" },
      completeness: { status: "unknown" }, local: { status: indeterminate ? "partial" : "complete" },
      external: { status: "unreported_possible" },
    },
    remote: { incentivized: indeterminate ? "0" : "100000", unclassifiedModel: indeterminate ? "125" : "0" },
    indicative: {
      status, amount: indeterminate ? null : "900000", referenceWindow: period,
      blockers: indeterminate ? [{ code: "local_coverage_partial" }] : [],
    },
    local: {
      totals: { observed: "32", unknownEvents: 1 }, limitations: ["legacy_and_registry_non_additive"],
      truncated: status === "unknown",
      registry: { totals: { observed: "32" }, counts: { measured: 2, pending: 1, unknown: 1 }, gapEpochs: 1 },
    },
  };
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1140 }, colorScheme: "light" });
  const login = await context.request.post(base + "/api/auth/login", {
    data: { password: process.env.QUOTA_FIXTURE_PASSWORD ?? "123456" },
  });
  assert.equal(login.status(), 200, "Expected login to an isolated database with a fixture password");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const lookup = page.locator("main");
  let listStatus = 200, indicator = "current", noOrganizations = false, listCalls = 0;
  let waitForRefresh;
  await context.route("**/*", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(base).origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    assert.equal(request.method(), "GET");
    const respond = (json, status = 200) => route.fulfill({ json, status });
    const prefix = "/api/quota/organizations";
    if (url.pathname === prefix) {
      listCalls++;
      if (waitForRefresh) await waitForRefresh;
      if (listStatus !== 200) return respond({ error: "fixture private failure" }, listStatus);
      if (noOrganizations) return respond({ data: [], nextOffset: null });
      return url.searchParams.get("offset") === "0"
        ? respond({ data: organizations.slice(0, 2), nextOffset: 2 })
        : respond({ data: organizations.slice(2), nextOffset: null });
    }
    if (url.pathname.startsWith(prefix + "/")) {
      const [org, routeName] = url.pathname.slice(prefix.length + 1).split("/");
      if (org === "denied-org") return respond({ error: "fixture private denial" }, 404);
      if (routeName === "groups") return respond(result(indicator));
      if (url.searchParams.get("source") === "usage") {
        return respond({
          ...snapshot, groups: org === "empty-org" ? [] : [standard, empty, trimmed],
          renewal: { time: "00:00", timeZone: "UTC" }, records: { data: [], nextOffset: null },
        });
      }
      const historical = url.searchParams.has("start");
      const offset = Number(url.searchParams.get("offset"));
      return respond({
        ...snapshot,
        ...(historical ? { window: { start: start - day, end: start } } : { status: "unknown", coverage: "missing" }),
        records: {
          data: !historical ? [] : offset === 0 ? costs : [{ lineItem: "Next charge", amount: { value: "0.000000008", currency: "usd" } }],
          nextOffset: historical && offset === 0 ? 2 : null,
        },
      });
    }
    return respond(url.pathname === "/api/auth/status" ? { authenticated: true } : {});
  });

  await page.goto(base + "/dashboard/quota-manager");
  const see = (value, exact = true) => lookup.getByText(value, { exact }).first().waitFor();
  const button = (name) => lookup.getByRole("button", { name, exact: false }).first();
  const refresh = button("Refresh");
  await lookup.getByRole("heading", { name: "Quotas" }).waitFor();
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await see("Current estimate");
  await see("900,000");
  await see("100,000");
  await see("No administrative costs reported for this window.");
  assert.equal(await page.locator('a[href="/dashboard/quota-manager"][aria-current="page"]').count(), 2);
  assert.equal(await page.locator('a[href="/dashboard/quota"][aria-current="page"]').count(), 0);
  assert.equal(await lookup.getByText("Remote usage without model classification", { exact: true }).count(), 1);
  if (screenshotDir) await page.screenshot({ path: screenshotDir + "/quota-corrente.png" });

  await button("Previous UTC day").click();
  await see("0 USD");
  await see("Unpriced output");
  await button("Next page").click();
  await see("0.000000008 USD");
  await button("Previous page").click();
  await see("Incentivized input");

  indicator = "historical";
  await refresh.click();
  await see("Historical estimate");
  await see("Collection is out of date.");

  indicator = "unknown";
  await refresh.click();
  await see("Availability is indeterminate");
  await see("Local coverage is partial");
  await see("0");
  await see("125");
  await lookup.locator("summary").filter({ hasText: "Diagnostics" }).click();
  await see("Local results are truncated.");
  await see("legacy_and_registry_non_additive");
  const totals = await lookup.getByText("32", { exact: true }).allTextContents();
  assert.deepEqual(totals, ["32", "32"]);
  await see("Provider completeness");
  await see("Collection freshness");
  await lookup.locator("summary").filter({ hasText: "Diagnostics" }).click();
  await page.evaluate(() => document.querySelector("main .custom-scrollbar").scrollTo(0, 0));
  if (screenshotDir) await page.screenshot({ path: screenshotDir + "/quota-indeterminada.png" });

  await lookup.getByLabel("Quota group").selectOption("unclassified");
  await see("No models are classified in this group");
  await lookup.getByLabel("Quota group").selectOption("trimmed");
  await lookup.locator("summary").filter({ hasText: "Group models" }).click();
  await see("synthetic-alpha");
  await see("The model list reached the display limit.");
  await lookup.getByLabel("Organization", { exact: true }).selectOption("empty-org");
  await see("No quota groups are configured.");
  await lookup.getByLabel("Organization", { exact: true }).selectOption("denied-org");
  await see("Quota data is unavailable or you do not have access");
  assert.equal(await lookup.getByText("fixture private denial").count(), 0);

  listStatus = 503;
  await refresh.click();
  await see("Could not load quota data. Use Refresh to try again.");
  assert.equal(await lookup.getByText("fixture private failure").count(), 0);
  listStatus = 401;
  await refresh.click();
  await lookup.getByRole("link", { name: "Sign in with an administrative session" }).waitFor();
  listStatus = 200;
  noOrganizations = true;
  let release;
  waitForRefresh = new Promise(resolve => { release = resolve; });
  const before = listCalls;
  const started = page.waitForRequest(request => request.url().includes("/api/quota/organizations?") &&
    request.url().includes("offset=0"));
  await refresh.click();
  await see("Loading quota data…");
  assert.equal(await refresh.isDisabled(), true);
  await started;
  assert.equal(listCalls, before + 1);
  release();
  waitForRefresh = null;
  await see("No authorized quota organizations are configured.");

  noOrganizations = false;
  await context.addCookies([{ name: "locale", value: "pt-BR", url: base }]);
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.reload();
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await lookup.getByRole("heading", { name: "Franquias" }).waitFor();
  await see("Disponibilidade indeterminada");
  await see("Franquia diária configurada");
  assert.equal(await page.evaluate(() => {
    const main = document.querySelector("main .custom-scrollbar");
    return main.scrollWidth <= main.clientWidth;
  }), true);
  if (screenshotDir) await page.screenshot({ path: screenshotDir + "/quota-mobile-pt-br.png" });
  assert.deepEqual(errors, []);
  console.log("Quota dashboard browser scenarios passed");
} finally {
  await browser.close();
}
