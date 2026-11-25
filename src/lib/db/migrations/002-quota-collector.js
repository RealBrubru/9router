import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 2,
  name: "quota-collector",
  up(db) {
    for (const name of ["quotaOrganizations", "quotaConnectionBindings", "quotaBuckets", "quotaCollectionState"]) {
      const table = TABLES[name];
      db.exec(buildCreateTableSql(name, table));
      for (const index of table.indexes || []) db.exec(index);
    }
  },
};
