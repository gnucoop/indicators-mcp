import { SqlIndicatorRepo } from "./sql.ts";
import type { SqlExecutor } from "./types.ts";

export function d1Repo(db: D1Database): SqlIndicatorRepo {
  const exec: SqlExecutor = {
    async all<T>(sql: string, args: unknown[]): Promise<T[]> {
      const { results } = await db.prepare(sql).bind(...args).all<T>();
      return results;
    },
  };
  return new SqlIndicatorRepo(exec);
}
