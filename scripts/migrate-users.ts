/**
 * ONE-TIME migration: JSON dashboard user store -> PostgreSQL `users` table.
 *
 * Phase 1 (RBAC data layer). Does NOT touch auth/session/middleware/routes.
 *
 * Usage (inside the container):
 *   npx tsx scripts/migrate-users.ts
 *   npx tsx scripts/migrate-users.ts --file /app/.data/dashboard-users.json
 *   npx tsx scripts/migrate-users.ts --dry-run
 *
 * Behaviour:
 *   - Reads the existing JSON user store
 *     (default: <cwd>/.data/dashboard-users.json).
 *   - Inserts each user into `users`, preserving the existing scrypt
 *     password hash EXACTLY as stored (no rehashing).
 *   - Role assignment during migration:
 *       username on ARA_OPERATOR_ALLOWLIST  ->  'admin'
 *       everyone else                       ->  'viewer'
 *   - Idempotent: ON CONFLICT (email) DO NOTHING (safe to re-run).
 *   - Never deletes or modifies the original JSON file.
 *   - Exits 0 with a clear message when the file is missing or empty.
 *   - Prints a summary (counts + role breakdown) when done.
 *
 * Requires POSTGRES_URL (present in the container environment) and migration 006
 * to have run first (node scripts/db-migrate.mjs).
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

type JsonUser = {
  id?: string;
  username?: string;
  passwordHash?: string;
  createdAt?: string;
};

type JsonStore = { version?: number; users?: JsonUser[] };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadEnvFiles(): Promise<void> {
  for (const name of [".env.local", ".env"]) {
    const envPath = path.join(process.cwd(), name);
    if (!existsSync(envPath)) continue;
    const content = await fs.readFile(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

function parseArgs(argv: string[]): { file?: string; dryRun: boolean } {
  let file: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--file") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        file = next;
        i += 1;
      }
    } else if (arg.startsWith("--file=")) {
      file = arg.slice("--file=".length);
    }
  }
  return { file, dryRun };
}

function operatorAllowlist(): string[] {
  return (process.env.ARA_OPERATOR_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function getDb(): ReturnType<typeof postgres> {
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    throw new Error(
      "POSTGRES_URL is not set. Run this inside the ara-dashboard-prod container, " +
        "or set POSTGRES_URL in the environment / .env."
    );
  }
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    idle_timeout: 20,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

type PlannedUser = {
  email: string;
  role: "admin" | "viewer";
  passwordHash: string;
  id: string | null;
  createdAt: string | null;
};

async function main(): Promise<void> {
  await loadEnvFiles();
  const { file, dryRun } = parseArgs(process.argv.slice(2));

  const storePath = path.resolve(
    file?.trim() || path.join(process.cwd(), ".data", "dashboard-users.json")
  );

  console.log("========== migrate-users: JSON -> PostgreSQL `users` ==========");
  console.log(`Store path: ${storePath}`);
  console.log(`Mode:       ${dryRun ? "DRY RUN (no writes)" : "WRITE"}`);

  if (!existsSync(storePath)) {
    console.log(
      `\nNo JSON user store found at ${storePath}.\nNothing to migrate — exiting cleanly.`
    );
    return;
  }

  let store: JsonStore;
  try {
    const raw = (await fs.readFile(storePath, "utf8")).replace(/^\uFEFF/, "");
    store = JSON.parse(raw) as JsonStore;
  } catch (err) {
    console.log(
      `\nCould not read/parse ${storePath} ` +
        `(${err instanceof Error ? err.message : String(err)}).\n` +
        "Nothing migrated — exiting cleanly."
    );
    return;
  }

  const jsonUsers = Array.isArray(store.users) ? store.users : [];
  if (jsonUsers.length === 0) {
    console.log(
      "\nJSON user store contains no users.\nNothing to migrate — exiting cleanly."
    );
    return;
  }

  const allowlist = operatorAllowlist();
  console.log(
    `Operator allowlist (${allowlist.length}): ${allowlist.join(", ") || "(empty)"}`
  );

  const planned: PlannedUser[] = [];
  const skippedInvalid: string[] = [];

  for (const user of jsonUsers) {
    const email = (user.username ?? "").trim().toLowerCase();
    const passwordHash = (user.passwordHash ?? "").trim();
    if (!email || !passwordHash) {
      skippedInvalid.push(user.username ?? "(no username)");
      continue;
    }
    planned.push({
      email,
      role: allowlist.includes(email) ? "admin" : "viewer",
      passwordHash,
      id: user.id && UUID_RE.test(user.id) ? user.id : null,
      createdAt:
        typeof user.createdAt === "string" && user.createdAt
          ? user.createdAt
          : null,
    });
  }

  console.log(`\nUsers in JSON:       ${jsonUsers.length}`);
  console.log(`Valid to migrate:    ${planned.length}`);
  if (skippedInvalid.length > 0) {
    console.log(
      `Skipped (missing email/hash): ${skippedInvalid.length} — ${skippedInvalid.join(", ")}`
    );
  }
  console.log(
    `Planned roles:       admin=${planned.filter((p) => p.role === "admin").length}, ` +
      `viewer=${planned.filter((p) => p.role === "viewer").length}`
  );
  for (const plan of planned) {
    console.log(`  ${plan.email}  ->  ${plan.role}`);
  }

  if (dryRun) {
    console.log("\nDry run complete — no database writes performed.");
    return;
  }

  const sql = getDb();
  let inserted = 0;
  let skippedExisting = 0;
  const insertedByRole: Record<string, number> = { admin: 0, viewer: 0 };

  try {
    const tableCheck = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.users') IS NOT NULL AS exists
    `;
    if (!tableCheck[0]?.exists) {
      throw new Error(
        "Table `users` does not exist. Run migration 006 first: node scripts/db-migrate.mjs"
      );
    }

    for (const plan of planned) {
      const row: Record<string, unknown> = {
        email: plan.email,
        password_hash: plan.passwordHash,
        role: plan.role,
        active: true,
      };
      if (plan.id) row.id = plan.id;
      if (plan.createdAt) row.created_at = plan.createdAt;

      const cols = Object.keys(row);
      const result = await sql`
        INSERT INTO users ${sql(row, ...cols)}
        ON CONFLICT (email) DO NOTHING
        RETURNING id
      `;
      if (result.length > 0) {
        inserted += 1;
        insertedByRole[plan.role] = (insertedByRole[plan.role] ?? 0) + 1;
      } else {
        skippedExisting += 1;
      }
    }

    const totalRows = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM users
    `;

    console.log("\n---------------- SUMMARY ----------------");
    console.log(`Inserted:                 ${inserted}`);
    console.log(`  as admin:               ${insertedByRole.admin ?? 0}`);
    console.log(`  as viewer:              ${insertedByRole.viewer ?? 0}`);
    console.log(`Skipped (already in DB):  ${skippedExisting}`);
    console.log(`Skipped (invalid JSON):   ${skippedInvalid.length}`);
    console.log(`users table total now:    ${totalRows[0]?.c ?? "?"}`);
    console.log(`JSON file left untouched: ${storePath}`);
    console.log("----------------------------------------");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]).includes("migrate-users");

if (isMain) {
  main().catch((err) => {
    console.error("[migrate-users] FAILED:", err);
    process.exit(1);
  });
}
