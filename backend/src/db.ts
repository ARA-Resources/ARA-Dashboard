import { Pool, type PoolConfig } from "pg";

let pool: Pool | null = null;

function readPoolConfig(): PoolConfig {
  const host = process.env.PGHOST?.trim();
  const portRaw = process.env.PGPORT?.trim();
  const database = process.env.PGDATABASE?.trim();
  const user = process.env.PGUSER?.trim();
  const password = process.env.PGPASSWORD;

  const port = Number(portRaw);

  if (!host || !database || !user || !portRaw || !Number.isInteger(port) || port <= 0) {
    throw new Error("PostgreSQL configuration is incomplete");
  }

  const config: PoolConfig = {
    host,
    port,
    database,
    user,
    max: 1,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
  };

  if (password !== undefined && password.length > 0) {
    config.password = password;
  }

  return config;
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool(readPoolConfig());
    pool.on("error", () => {
      // Keep the HTTP process alive; /api/db-health reports failure.
    });
  }
  return pool;
}

export async function selectOne(): Promise<void> {
  const result = await getPool().query("SELECT 1");
  if (result.rowCount !== 1) {
    throw new Error("PostgreSQL SELECT 1 did not return a row");
  }
}

export async function readDatabaseIdentity(): Promise<{
  currentDatabase: string;
  currentUser: string;
}> {
  const result = await getPool().query<{
    current_database: string;
    current_user: string;
  }>("SELECT current_database(), current_user");
  const row = result.rows[0];
  if (!row?.current_database || !row.current_user) {
    throw new Error("PostgreSQL identity query returned no row");
  }
  return {
    currentDatabase: row.current_database,
    currentUser: row.current_user,
  };
}
