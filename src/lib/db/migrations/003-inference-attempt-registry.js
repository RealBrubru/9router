import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 3,
  name: "inference-attempt-registry",
  up(db) {
    for (const name of ["inferenceRequests", "inferenceCoverageEpochs", "inferenceAttempts", "inferenceAttemptEvents", "inferenceUsageLinks"]) {
      const table = TABLES[name];
      db.exec(buildCreateTableSql(name, table));
      for (const index of table.indexes ?? []) db.exec(index);
    }
  },
};
