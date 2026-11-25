// ⚠️ AGENT/DEV: Bump this by +1 EVERY TIME you change the schema below
// (add/remove/alter a table, column, or index in TABLES). It drives the
// pre-change safety backup in migrate.js: when the stored version is lower,
// one lightweight DB backup is taken before applying schema changes. Forgetting
// to bump only skips that backup — it does NOT break the additive auto-sync.
export const SCHEMA_VERSION = 4;

export const PRAGMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 30000000;
PRAGMA cache_size = -64000;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
`;

// Declarative current schema. Used by syncSchemaFromTables() to
// auto-add missing tables/columns/indexes after versioned migrations.
// For destructive changes (drop/rename/type-change), write a migration file.
export const TABLES = {
  _meta: {
    columns: {
      key: "TEXT PRIMARY KEY",
      value: "TEXT NOT NULL",
    },
  },
  settings: {
    columns: {
      id: "INTEGER PRIMARY KEY CHECK (id = 1)",
      data: "TEXT NOT NULL",
    },
  },
  providerConnections: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      authType: "TEXT NOT NULL",
      name: "TEXT",
      email: "TEXT",
      priority: "INTEGER",
      isActive: "INTEGER DEFAULT 1",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pc_provider ON providerConnections(provider)",
      "CREATE INDEX IF NOT EXISTS idx_pc_provider_active ON providerConnections(provider, isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pc_priority ON providerConnections(provider, priority)",
    ],
  },
  providerNodes: {
    columns: {
      id: "TEXT PRIMARY KEY",
      type: "TEXT",
      name: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_pn_type ON providerNodes(type)"],
  },
  proxyPools: {
    columns: {
      id: "TEXT PRIMARY KEY",
      isActive: "INTEGER DEFAULT 1",
      testStatus: "TEXT",
      data: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_pp_active ON proxyPools(isActive)",
      "CREATE INDEX IF NOT EXISTS idx_pp_status ON proxyPools(testStatus)",
    ],
  },
  apiKeys: {
    columns: {
      id: "TEXT PRIMARY KEY",
      key: "TEXT UNIQUE NOT NULL",
      name: "TEXT",
      machineId: "TEXT",
      isActive: "INTEGER DEFAULT 1",
      createdAt: "TEXT NOT NULL",
      // Per-key access control. Additive columns, picked up by
      // syncSchemaFromTables() on boot; existing rows read as unrestricted (0).
      accessRestricted: "INTEGER DEFAULT 0",
      accessAllow: "TEXT",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ak_key ON apiKeys(key)"],
  },
  combos: {
    columns: {
      id: "TEXT PRIMARY KEY",
      name: "TEXT UNIQUE NOT NULL",
      kind: "TEXT",
      models: "TEXT NOT NULL",
      createdAt: "TEXT NOT NULL",
      updatedAt: "TEXT NOT NULL",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_combo_name ON combos(name)"],
  },
  kv: {
    columns: {
      scope: "TEXT NOT NULL",
      key: "TEXT NOT NULL",
      value: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (scope, key)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_kv_scope ON kv(scope)"],
  },
  usageHistory: {
    columns: {
      id: "INTEGER PRIMARY KEY AUTOINCREMENT",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      apiKey: "TEXT",
      endpoint: "TEXT",
      promptTokens: "INTEGER DEFAULT 0",
      completionTokens: "INTEGER DEFAULT 0",
      cost: "REAL DEFAULT 0",
      status: "TEXT",
      tokens: "TEXT",
      meta: "TEXT",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_uh_ts ON usageHistory(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_uh_provider ON usageHistory(provider)",
      "CREATE INDEX IF NOT EXISTS idx_uh_model ON usageHistory(model)",
      "CREATE INDEX IF NOT EXISTS idx_uh_conn ON usageHistory(connectionId)",
    ],
  },
  usageDaily: {
    columns: {
      dateKey: "TEXT PRIMARY KEY",
      data: "TEXT NOT NULL",
    },
  },
  requestDetails: {
    columns: {
      id: "TEXT PRIMARY KEY",
      timestamp: "TEXT NOT NULL",
      provider: "TEXT",
      model: "TEXT",
      connectionId: "TEXT",
      status: "TEXT",
      data: "TEXT NOT NULL",
    },
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_rd_ts ON requestDetails(timestamp DESC)",
      "CREATE INDEX IF NOT EXISTS idx_rd_provider ON requestDetails(provider)",
      "CREATE INDEX IF NOT EXISTS idx_rd_model ON requestDetails(model)",
      "CREATE INDEX IF NOT EXISTS idx_rd_conn ON requestDetails(connectionId)",
    ],
  },
  quotaOrganizations: {
    columns: {
      id: "TEXT PRIMARY KEY",
      provider: "TEXT NOT NULL",
      externalId: "TEXT NOT NULL",
      credentialRef: "TEXT NOT NULL",
      enabled: "INTEGER NOT NULL",
      config: "TEXT NOT NULL",
    },
    indexes: ["CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_org_external ON quotaOrganizations(provider, externalId)"],
  },
  quotaConnectionBindings: {
    columns: {
      organizationId: "TEXT NOT NULL REFERENCES quotaOrganizations(id)",
      connectionId: "TEXT NOT NULL",
      apiKeyId: "TEXT NOT NULL",
      projectId: "TEXT",
      validFrom: "INTEGER NOT NULL",
      validTo: "INTEGER",
    },
    primaryKey: "PRIMARY KEY (connectionId, validFrom)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_quota_binding_org ON quotaConnectionBindings(organizationId, connectionId)"],
  },
  quotaBuckets: {
    columns: {
      organizationId: "TEXT NOT NULL REFERENCES quotaOrganizations(id)",
      source: "TEXT NOT NULL",
      scope: "TEXT NOT NULL",
      bucketStart: "INTEGER NOT NULL",
      bucketEnd: "INTEGER NOT NULL",
      collectionId: "TEXT NOT NULL",
      collectedAt: "INTEGER NOT NULL",
      data: "TEXT NOT NULL",
    },
    primaryKey: "PRIMARY KEY (organizationId, source, scope, bucketStart)",
    indexes: ["CREATE INDEX IF NOT EXISTS idx_quota_bucket_collection ON quotaBuckets(organizationId, source, scope, collectionId)"],
  },
  quotaCollectionState: {
    columns: {
      organizationId: "TEXT NOT NULL REFERENCES quotaOrganizations(id)",
      source: "TEXT NOT NULL",
      scope: "TEXT NOT NULL",
      lastAttempt: "TEXT NOT NULL",
      lastSuccess: "TEXT",
    },
    primaryKey: "PRIMARY KEY (organizationId, source, scope)",
  },
  inferenceRequests: {
    columns: {
      id: "TEXT PRIMARY KEY NOT NULL",
      route: "TEXT NOT NULL",
      requestedModel: "TEXT",
      receivedAt: "INTEGER NOT NULL CHECK (receivedAt >= 0)",
    },
    indexes: ["CREATE INDEX IF NOT EXISTS idx_ir_received ON inferenceRequests(receivedAt)"],
  },
  inferenceCoverageEpochs: {
    columns: {
      id: "TEXT PRIMARY KEY NOT NULL",
      instanceId: "TEXT NOT NULL",
      instrumentationVersion: "TEXT NOT NULL",
      route: "TEXT NOT NULL",
      operation: "TEXT NOT NULL",
      transport: "TEXT NOT NULL",
      barrierCertified: "INTEGER NOT NULL CHECK (barrierCertified IN (0, 1))",
      openedAt: "INTEGER NOT NULL CHECK (openedAt >= 0)",
      closedAt: "INTEGER CHECK (closedAt >= openedAt)",
      gapAt: "INTEGER CHECK (gapAt IS NULL OR (gapAt >= openedAt AND closedAt IS NOT NULL AND gapAt <= closedAt))",
      gapReason: "TEXT CHECK (gapReason IN ('storage_failure', 'uninstrumented_dispatch', 'owner_exit', 'unknown'))",
      ownerExitKnownAt: "INTEGER CHECK (ownerExitKnownAt >= openedAt)",
      ownerExitEvidenceId: "TEXT",
    },
    constraints: [
      "CHECK ((gapAt IS NULL) = (gapReason IS NULL))",
      "CHECK ((ownerExitKnownAt IS NULL) = (ownerExitEvidenceId IS NULL))",
    ],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ice_scope ON inferenceCoverageEpochs(instanceId, instrumentationVersion, route, operation, transport, openedAt)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ice_open ON inferenceCoverageEpochs(instanceId, instrumentationVersion, route, operation, transport) WHERE closedAt IS NULL",
    ],
  },
  inferenceAttempts: {
    columns: {
      id: "TEXT PRIMARY KEY NOT NULL",
      requestId: "TEXT NOT NULL REFERENCES inferenceRequests(id)",
      epochId: "TEXT NOT NULL REFERENCES inferenceCoverageEpochs(id)",
      previousAttemptId: "TEXT REFERENCES inferenceAttempts(id)",
      provider: "TEXT NOT NULL",
      connectionId: "TEXT",
      purpose: "TEXT NOT NULL CHECK (purpose IN ('primary', 'retry', 'fallback', 'panel', 'judge', 'classifier', 'continuation', 'probe'))",
      organizationId: "TEXT",
      dispatchAt: "INTEGER CHECK (dispatchAt >= 0)",
      state: "TEXT NOT NULL CHECK (state IN ('prepared', 'not_sent', 'dispatch_possible', 'response_observed', 'in_progress', 'closed', 'uncertain'))",
      outcome: "TEXT CHECK (outcome IN ('invalid_request', 'cancelled', 'timeout', 'internal_error', 'process_exit', 'completed', 'provider_error', 'provider_cancelled', 'transport_error'))",
      version: "INTEGER NOT NULL CHECK (version >= 1)",
    },
    constraints: [
      "CHECK (id <> requestId AND (previousAttemptId IS NULL OR previousAttemptId <> id))",
      "CHECK ((state IN ('not_sent', 'closed', 'uncertain')) = (outcome IS NOT NULL))",
      "CHECK (state = 'uncertain' OR ((state IN ('prepared', 'not_sent')) = (dispatchAt IS NULL)))",
      "CHECK (organizationId IS NULL OR dispatchAt IS NOT NULL)",
    ],
    indexes: [
      "CREATE INDEX IF NOT EXISTS idx_ia_request ON inferenceAttempts(requestId)",
      "CREATE INDEX IF NOT EXISTS idx_ia_org_dispatch ON inferenceAttempts(organizationId, dispatchAt)",
      "CREATE INDEX IF NOT EXISTS idx_ia_open_epoch ON inferenceAttempts(epochId) WHERE state IN ('prepared', 'dispatch_possible', 'response_observed', 'in_progress')",
    ],
  },
  inferenceAttemptEvents: {
    columns: {
      sequence: "INTEGER PRIMARY KEY AUTOINCREMENT",
      attemptId: "TEXT NOT NULL REFERENCES inferenceAttempts(id) ON DELETE CASCADE",
      eventId: "TEXT NOT NULL",
      version: "INTEGER NOT NULL CHECK (version >= 1)",
      kind: "TEXT NOT NULL CHECK (kind IN ('prepare', 'dispatch', 'acknowledge', 'in_progress', 'returned_model', 'usage', 'finish', 'recover'))",
      state: "TEXT NOT NULL CHECK (state IN ('prepared', 'not_sent', 'dispatch_possible', 'response_observed', 'in_progress', 'closed', 'uncertain'))",
      outcome: "TEXT",
      occurredAt: "INTEGER NOT NULL CHECK (occurredAt >= 0)",
      knownAt: "INTEGER NOT NULL CHECK (knownAt >= occurredAt)",
      recordedAt: "INTEGER NOT NULL CHECK (recordedAt >= knownAt)",
      details: "TEXT NOT NULL",
    },
    constraints: ["UNIQUE(attemptId, eventId)", "UNIQUE(attemptId, version)"],
    indexes: ["CREATE INDEX IF NOT EXISTS idx_iae_known ON inferenceAttemptEvents(attemptId, knownAt, sequence)"],
  },
  inferenceUsageLinks: {
    columns: {
      attemptId: "TEXT PRIMARY KEY NOT NULL REFERENCES inferenceAttempts(id) ON DELETE CASCADE",
      usageHistoryId: "INTEGER NOT NULL UNIQUE REFERENCES usageHistory(id) ON DELETE CASCADE",
      evidenceId: "TEXT NOT NULL",
    },
  },
};

export function buildCreateTableSql(name, def) {
  const cols = Object.entries(def.columns).map(([k, v]) => `${k} ${v}`);
  if (def.primaryKey) cols.push(def.primaryKey);
  if (def.constraints) cols.push(...def.constraints);
  return `CREATE TABLE IF NOT EXISTS ${name} (${cols.join(", ")})`;
}
