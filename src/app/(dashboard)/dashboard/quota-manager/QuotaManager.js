"use client";

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { getCurrentLocale, onLocaleChange } from "@/i18n/runtime";
import { DEFAULT_LOCALE } from "@/i18n/config";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import Select from "@/shared/components/Select";
import {
  quotaIndicators, quotaOrganizationsUrl, readQuotaDashboard, reconciliationUrl, snapshotUrl,
} from "./quotaDashboardData";

const stateLabels = {
  valid: "Available", complete: "Complete", full: "Complete", partial: "Partial",
  stale: "Out of date", recent: "Recent", missing: "Missing", unknown: "Unknown",
  unreported_possible: "Unreported usage possible", reported_through_reference: "Reported through the observed window",
};

const reasonLabels = {
  remote_coverage_missing: "Waiting for provider data",
  remote_coverage_partial: "Provider data is partially available",
  remote_model_unclassified: "Some models have no quota group",
  remote_tier_unclassified: "Some provider tiers are unclassified",
  local_coverage_partial: "Local coverage is partial",
  local_coverage_unknown: "Local coverage is unknown",
  remote_zero_without_completeness: "The provider has not confirmed data completeness",
  historical_state_unavailable: "Historical state is unavailable",
  unsupported_quota_scope: "Reconciliation is unavailable for this quota policy",
  unsupported_policy_precision: "Reconciliation is unavailable for this policy precision",
};

function useQuotaRead(url, refresh) {
  const [state, setState] = useState(null);
  const request = useMemo(() => ({ url, refresh }), [url, refresh]);
  useEffect(() => {
    if (!request.url) return;
    const controller = new AbortController();
    readQuotaDashboard(request.url, controller.signal).then(
      data => {
        if (!controller.signal.aborted) setState({ request, data });
      },
      error => {
        if (!controller.signal.aborted) setState({ request, error: error.status ?? 503 });
      },
    );
    return () => controller.abort();
  }, [request]);

  const current = url && state?.request.url === url ? state : null;
  const loading = Boolean(url && current?.request !== request);
  return { data: current?.data, error: loading ? undefined : current?.error, loading };
}

function ReadStatus({ request }) {
  if (request.loading && !request.data) return <p role="status" className="text-sm text-text-muted">Loading quota data…</p>;
  if (!request.error) return null;
  if (request.error === 401) return (
    <p role="alert" className="text-sm text-text-main">
      <Link href="/login" className="text-primary underline">Sign in with an administrative session</Link>
    </p>
  );
  return (
    <p role="alert" className="text-sm text-text-main">
      {request.error === 403 || request.error === 404
        ? "Quota data is unavailable or you do not have access"
        : "Could not load quota data. Use Refresh to try again."}
    </p>
  );
}

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-sm text-text-muted">{label}</dt>
      <dd className="mt-1 break-words text-sm text-text-main">{children}</dd>
    </div>
  );
}

function Metric({ title, value, unit, note }) {
  return (
    <Card title={title} padding="sm">
      <p className="break-words text-xl font-semibold tabular-nums text-text-main">{value ?? "Unknown"}</p>
      {value != null && unit && <p className="text-sm text-text-muted">{unit}</p>}
      {note && <p className="mt-2 text-sm text-text-muted">{note}</p>}
    </Card>
  );
}

function formatters(locale) {
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 20 });
  const dates = new Intl.DateTimeFormat(locale, {
    timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
  const date = time => time == null ? "Unknown" : dates.format(time);
  return {
    date,
    number: value => value == null ? null : numbers.format(value),
    window: (range, multiplier = 1) => range
      ? `${date(range.start * multiplier)} – ${date(range.end * multiplier)}` : "Unknown",
  };
}

function CollectorStatus({ title, snapshot, fmt }) {
  const schedule = snapshot?.schedule;
  return (
    <Card.Section>
      <h3 className="mb-3 font-medium text-text-main">{title}</h3>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Fact label="Collector">{!schedule ? "Unknown" : !schedule.enabled ? "Disabled" : schedule.runningSince != null ? "Collecting" : "Scheduled"}</Fact>
        <Fact label="Snapshot status">{stateLabels[snapshot?.status] ?? "Unknown"}</Fact>
        <Fact label="Last successful collection">{fmt.date(snapshot?.lastSuccess?.collectedAt)}</Fact>
        <Fact label="Next scheduled collection">{fmt.date(schedule?.nextAt)}</Fact>
        <Fact label="Consecutive failures">{fmt.number(schedule?.enabled ? schedule.consecutiveFailures : null) ?? "Unknown"}</Fact>
        <Fact label="Snapshot window">{fmt.window(snapshot?.window, 1000)}</Fact>
        <Fact label="Temporal coverage">{stateLabels[snapshot?.coverage] ?? "Unknown"}</Fact>
        <Fact label="Coverage gaps">{fmt.number(snapshot?.gaps?.length) ?? "Unknown"}</Fact>
      </dl>
    </Card.Section>
  );
}

function Diagnostics({ usage, costs, result, legacy, fmt }) {
  const quality = result?.quality;
  const registry = result?.local?.registry;
  const reasons = [...new Set([
    result?.reason, result?.remoteIssue,
    ...(result?.indicative?.blockers ?? []).map(({ code }) => code),
    ...(result?.indicative?.assumptions ?? []),
    ...(result?.indicative?.limitations ?? []),
    ...(result?.local?.limitations ?? []),
  ].filter(Boolean))];
  const dated = result?.observations?.filter(row => ["observed", "stale"].includes(row.status)) ?? [];
  const dataAsOf = dated.length && dated.every(row => row.dataAsOf != null)
    ? Math.min(...dated.map(row => row.dataAsOf)) : null;
  const gaps = quality?.temporal?.gaps;
  return (
    <Card>
      <details>
        <summary className="cursor-pointer font-semibold text-text-main">Diagnostics</summary>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <CollectorStatus title="Usage collector" snapshot={usage} fmt={fmt} />
          <CollectorStatus title="Costs collector" snapshot={costs} fmt={fmt} />
          <Card.Section className="md:col-span-2">
            <h3 className="mb-3 font-medium text-text-main">Reconciliation quality</h3>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <Fact label="Temporal coverage">{stateLabels[quality?.temporal.status] ?? "Unknown"}</Fact>
              <Fact label="Population coverage">{stateLabels[quality?.population] ?? "Unknown"}</Fact>
              <Fact label="Collection freshness">{stateLabels[quality?.collection.status] ?? "Unknown"}</Fact>
              <Fact label="Provider completeness">{stateLabels[quality?.completeness.status] ?? "Unknown"}</Fact>
              <Fact label="Provider data as of">{fmt.date(dataAsOf)}</Fact>
              <Fact label="Local coverage">{stateLabels[quality?.local.status] ?? "Unknown"}</Fact>
              <Fact label="External consumption">{stateLabels[quality?.external.status] ?? "Unknown"}</Fact>
              <Fact label="Reconciliation gaps">{fmt.number(gaps?.length) ?? "Unknown"}</Fact>
              <Fact label="Known Registry gaps">{fmt.number(registry?.gapEpochs) ?? "Unknown"}</Fact>
              <Fact label="Legacy observed usage">{fmt.number(legacy) ?? "Unknown"}</Fact>
              <Fact label="Legacy events with unknown usage">{fmt.number(result?.local?.totals.unknownEvents) ?? "Unknown"}</Fact>
            </dl>
            {(result?.local?.truncated || registry?.truncated) && (
              <p className="mt-3 text-sm text-text-muted">Local results are truncated.</p>
            )}
            {reasons.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-text-muted">
                {reasons.map(reason => (
                  <li key={reason} className="break-all">
                    {reasonLabels[reason] && <span>{reasonLabels[reason]} </span>}
                    <code className="text-xs">{reason}</code>
                  </li>
                ))}
              </ul>
            )}
          </Card.Section>
        </div>
      </details>
    </Card>
  );
}

function Costs({ request, previous, onDayChange, offsets, onPage, fmt }) {
  const data = request.data;
  const records = data?.records;
  return (
    <Card title="Reported administrative costs" subtitle="Organization-wide · UTC">
      <div className="mb-3 flex flex-wrap gap-2">
        <Button size="sm" variant={previous ? "outline" : "secondary"} aria-pressed={!previous}
          disabled={request.loading} onClick={() => onDayChange(false)}>Today</Button>
        <Button size="sm" variant={previous ? "secondary" : "outline"} aria-pressed={previous}
          disabled={request.loading} onClick={() => onDayChange(true)}>Previous UTC day</Button>
      </div>
      <ReadStatus request={request} />
      {data && <p className="mb-2 text-xs text-text-muted">{fmt.window(data.window, 1000)}</p>}
      {records?.data.length === 0 && <p className="text-sm text-text-muted">No administrative costs reported for this window.</p>}
      {data?.status === "stale" && <p className="mb-2 text-sm text-text-muted">Collection is out of date.</p>}
      {records?.data.length > 0 && (
        <ul className="divide-y divide-border-subtle text-sm">
          {records.data.map((row, index) => (
            <li key={index} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
              <span className="min-w-0 break-words text-text-muted">{row.lineItem ?? "Unspecified charge"}</span>
              <span className="break-all tabular-nums text-text-main">
                {row.amount == null ? "Unknown" : `${row.amount.value} ${row.amount.currency.toUpperCase()}`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(offsets.length > 1 || records?.nextOffset != null) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={request.loading || offsets.length === 1}
            onClick={() => onPage(offsets.slice(0, -1))}>Previous page</Button>
          <Button size="sm" variant="outline" disabled={request.loading || records?.nextOffset == null}
            onClick={() => onPage([...offsets, records.nextOffset])}>Next page</Button>
          {records?.nextOffset != null && <span className="text-xs text-text-muted">More cost records are available.</span>}
        </div>
      )}
    </Card>
  );
}

export default function QuotaManager() {
  const locale = useSyncExternalStore(onLocaleChange, getCurrentLocale, () => DEFAULT_LOCALE);
  const [refresh, setRefresh] = useState(0);
  const [orgId, setOrgId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [previousCosts, setPreviousCosts] = useState(false);
  const [costOffsets, setCostOffsets] = useState([0]);
  const organizationLabel = useId();
  const groupLabel = useId();
  const organizations = useQuotaRead(quotaOrganizationsUrl, refresh);
  const orgOptions = organizations.data?.organizations ?? [];
  const org = orgOptions.find(item => item.id === orgId) ?? orgOptions[0];
  const usage = useQuotaRead(org ? snapshotUrl(org.id, "usage") : null, refresh);
  const groups = usage.data?.groups ?? [];
  const group = groups.find(item => item.id === groupId) ?? groups[0];
  const costs = useQuotaRead(usage.data ? snapshotUrl(org.id, "costs", {
    previousDayStart: previousCosts ? usage.data.window.start : null,
    offset: costOffsets.at(-1),
  }) : null, refresh);
  const reconciliation = useQuotaRead(group ? reconciliationUrl(org.id, group.id) : null, refresh);
  const result = reconciliation.data;
  const indicators = quotaIndicators(result, group);
  const fmt = formatters(locale);
  const busy = [organizations, usage, costs, reconciliation].some(request => request.loading);
  const groupMissing = result?.status === "unavailable" ? reasonLabels[result.reason] : null;
  const usageNote = !group?.modelCount ? "No models are classified in this group"
    : result?.quality?.collection.status === "stale" ? "Collection is out of date."
    : groupMissing ?? (indicators.incentivized == null ? "Waiting for provider data"
      : result?.quality?.temporal.status === "partial" ? "Provider data is partially available" : null);

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-4">
      <div className="flex justify-end">
        <Button icon="refresh" variant="outline" loading={busy} onClick={() => {
          setCostOffsets([0]);
          setRefresh(value => value + 1);
        }}>Refresh</Button>
      </div>
      <ReadStatus request={organizations} />
      {organizations.data && !org && <Card>No authorized quota organizations are configured.</Card>}
      {org && (
        <Card>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="min-w-0">
              <label htmlFor={organizationLabel} className="mb-1 block text-sm font-medium text-text-main">Organization</label>
              <Select id={organizationLabel} value={org.id} options={orgOptions.map(item => ({ value: item.id, label: item.id }))}
                onChange={event => {
                  setOrgId(event.target.value);
                  setGroupId("");
                  setPreviousCosts(false);
                  setCostOffsets([0]);
                }} />
            </div>
            <div className="min-w-0">
              <label htmlFor={groupLabel} className="mb-1 block text-sm font-medium text-text-main">Quota group</label>
              <Select id={groupLabel} value={group?.id ?? ""} placeholder="Select a quota group" disabled={!groups.length}
                options={groups.map(item => ({ value: item.id, label: item.id }))}
                onChange={event => setGroupId(event.target.value)} />
            </div>
          </div>
          {organizations.data.truncated && <p className="mt-3 text-sm text-text-muted">The organization list reached the display limit.</p>}
          <div className="mt-3"><ReadStatus request={usage} /></div>
          {usage.data && groups.length === 0 && <p className="text-sm text-text-muted">No quota groups are configured.</p>}
          {usage.data && org.groupCount > groups.length && <p className="text-sm text-text-muted">The group list reached the display limit.</p>}
          {usage.data?.renewal && (
            <dl className="mt-3 grid gap-3 sm:grid-cols-2">
              <Fact label="Configured daily renewal">{usage.data.renewal.time} {usage.data.renewal.timeZone}</Fact>
              {result?.window
                ? <Fact label="Quota window">{fmt.window(result.window)}</Fact>
                : <Fact label="Usage snapshot window">{fmt.window(usage.data.window, 1000)}</Fact>}
            </dl>
          )}
        </Card>
      )}
      {group && (
        <>
          <ReadStatus request={reconciliation} />
          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric title="Configured daily allowance" value={fmt.number(group.limit)} unit={group.unit} />
            <Metric title="Reported incentivized usage" value={fmt.number(indicators.incentivized)} unit={group.unit}
              note={usageNote} />
            <Metric title="Indicative availability" value={fmt.number(indicators.indicative?.amount)} unit={group.unit}
              note={indicators.indicative ? (
                <>
                  <span>{indicators.indicative.status === "historical" ? "Historical estimate" : "Current estimate"}</span>
                  <span className="block">{fmt.window(indicators.indicative.referenceWindow)}</span>
                  <span className="block">For reference only.</span>
                </>
              ) : "Availability is indeterminate"} />
            <Metric title="Locally observed usage" value={fmt.number(indicators.observed)} unit={group.unit}
              note="Attempt Registry · may include attempts without a classified model" />
          </div>
          <Card>
            <details>
              <summary className="cursor-pointer font-semibold text-text-main">Group models</summary>
              {!group.modelCount ? <p className="mt-3 text-sm text-text-muted">No models are classified in this group</p> : (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {group.models.map((model, index) => (
                    <li key={index} data-i18n-skip className="max-w-full break-all rounded-lg bg-surface-2 px-3 py-1 text-sm">{model}</li>
                  ))}
                </ul>
              )}
              {group.modelCount > group.models.length && <p className="mt-3 text-sm text-text-muted">The model list reached the display limit.</p>}
            </details>
            {indicators.counts && (
              <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Fact label="Measured attempts">{fmt.number(indicators.counts.measured) ?? "Unknown"}</Fact>
                <Fact label="Pending attempts">{fmt.number(indicators.counts.pending) ?? "Unknown"}</Fact>
                <Fact label="Attempts with unknown usage">{fmt.number(indicators.counts.unknown) ?? "Unknown"}</Fact>
              </dl>
            )}
            {result?.quality?.local.status === "partial" && <p className="mt-3 text-sm text-text-muted">Local coverage is partial</p>}
            <p className="mt-3 text-sm text-text-muted">Usage sources may overlap. Compare the subtotals separately.</p>
          </Card>
        </>
      )}
      {usage.data && (
        <>
          <Metric title="Remote usage without model classification" value={fmt.number(indicators.unclassified)}
            unit={result?.scope?.unit} note="Organization-wide · excludes usage identified as non-incentivized" />
          <Costs request={costs} previous={previousCosts} offsets={costOffsets} onPage={setCostOffsets}
            onDayChange={previous => { setPreviousCosts(previous); setCostOffsets([0]); }} fmt={fmt} />
          <Diagnostics usage={usage.data} costs={costs.data} result={result} legacy={indicators.legacy} fmt={fmt} />
        </>
      )}
    </div>
  );
}
