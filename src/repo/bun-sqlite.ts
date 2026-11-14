import type { Database, SQLQueryBindings } from "bun:sqlite";
import { SqlIndicatorRepo } from "./sql.ts";
import type { SqlExecutor } from "./types.ts";

export function bunSqliteRepo(db: Database): SqlIndicatorRepo {
  const exec: SqlExecutor = {
    async all<T>(sql: string, args: unknown[]): Promise<T[]> {
      return db.query(sql).all(...(args as SQLQueryBindings[])) as T[];
    },
  };
  return new SqlIndicatorRepo(exec);
}
