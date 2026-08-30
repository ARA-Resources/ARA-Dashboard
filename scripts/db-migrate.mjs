/**
 * ARA Dashboard — Database Migration Runner (Node ESM, no tsx).
 *
 * Usage: npm run db:migrate
 * Requires: POSTGRES_URL in environment or .env.local
 *
 * Plain .mjs so Docker/CJS tsx transforms are never involved.
 */

import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

async function loadEnvLocal() {
  const envLocalPath = path.join(process.cwd(), ".env.local");
  try {
    const envContent = await fs.readFile(envLocalPath, "utf8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env.local not present
  }
}

async function main() {
  await loadEnvLocal();

  const POSTGRES_URL = process.env.POSTGRES_URL?.trim();
  if (!POSTGRES_URL) {
    console.error(
      "\n[db:migrate] ERROR: POSTGRES_URL is not set.\n" +
        "Set POSTGRES_URL in your environment or .env.local before running migrations.\n" +
        "Example: POSTGRES_URL=postgresql://user:pass@localhost:5432/ara_dev\n"
    );
    process.exit(1);
  }

  console.log("[db:migrate] Connecting to database...");

  const sql = postgres(POSTGRES_URL, {
    max: 1,
    connect_timeout: 10,
    ssl:
      POSTGRES_URL.includes("localhost") ||
      POSTGRES_URL.includes("127.0.0.1")
        ? false
        : "require",
  });

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        description TEXT
      )
    `;

    const appliedRows = await sql`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const applied = new Set(appliedRows.map((r) => r.version));

    const migrationsDir = path.join(process.cwd(), "db", "migrations");
    const files = (await fs.readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      console.log("[db:migrate] No migration files found in db/migrations/");
      return;
    }

    let ranCount = 0;
    for (const file of files) {
      const version = file.replace(/[^0-9]/g, "").slice(0, 3).padStart(3, "0");
      if (applied.has(version)) {
        console.log(`  [skip] ${file} (already applied)`);
        continue;
      }
      const sqlText = await fs.readFile(path.join(migrationsDir, file), "utf8");
      console.log(`  [run ] ${file}...`);
      try {
        await sql.unsafe(sqlText);
        console.log(`  [done] ${file}`);
        ranCount++;
      } catch (err) {
        console.error(`\n[db:migrate] FAILED on ${file}:`);
        console.error(err);
        process.exitCode = 1;
        return;
      }
    }

    const applied2 = await sql`
      SELECT version, applied_at, description FROM schema_migrations ORDER BY version
    `;
    console.log("\n[db:migrate] Migration status:");
    for (const row of applied2) {
      console.log(
        `  v${row.version}  ${row.description ?? ""}  (applied ${row.applied_at.toISOString()})`
      );
    }
    console.log(`\n[db:migrate] Done. ${ranCount} migration(s) applied.\n`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("[db:migrate] Unexpected error:", err);
  process.exit(1);
});
