/**
 * Bootstrap the first super_admin account directly in PostgreSQL.
 *
 * Phase 1 (RBAC data layer). Does NOT touch auth/session/middleware/routes.
 *
 * Usage (inside the container):
 *   npx tsx scripts/create-admin.ts --email you@araresources.com --password '<password>'
 *   npx tsx scripts/create-admin.ts --email=you@araresources.com --password='<password>'
 *
 * Rules:
 *   - --email and --password are the ONLY inputs. There are no defaults for
 *     either value anywhere in this file.
 *   - The password is hashed with the app's existing scrypt logic
 *     (src/lib/auth/passwords.ts) before insert. It is never printed back.
 *   - Role is always 'super_admin'. There is no --role flag.
 *   - Fails clearly if the email already exists (no changes made).
 *
 * Requires POSTGRES_URL (present in the container environment) and migration 006
 * to have run first (node scripts/db-migrate.mjs).
 */

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { hashPassword } from "../src/lib/auth/passwords";

const MIN_PASSWORD_LENGTH = 8;

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

function parseArgs(argv: string[]): { email?: string; password?: string } {
  let email: string | undefined;
  let password: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--email") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        email = next;
        i += 1;
      }
    } else if (arg.startsWith("--email=")) {
      email = arg.slice("--email=".length);
    } else if (arg === "--password") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        password = next;
        i += 1;
      }
    } else if (arg.startsWith("--password=")) {
      password = arg.slice("--password=".length);
    }
  }
  return { email, password };
}

function usage(message?: string): void {
  if (message) console.error(`\nError: ${message}`);
  console.error(
    "\nUsage:\n" +
      "  npx tsx scripts/create-admin.ts --email <email> --password <password>\n"
  );
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

async function main(): Promise<void> {
  await loadEnvFiles();
  const { email: emailRaw, password } = parseArgs(process.argv.slice(2));

  if (!emailRaw || !emailRaw.trim()) {
    usage("--email is required.");
    process.exit(1);
  }
  if (password === undefined || password === "") {
    usage("--password is required.");
    process.exit(1);
  }

  const email = emailRaw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    usage(`"${email}" does not look like a valid email address.`);
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    usage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const sql = getDb();
  try {
    const tableCheck = await sql<{ exists: boolean }[]>`
      SELECT to_regclass('public.users') IS NOT NULL AS exists
    `;
    if (!tableCheck[0]?.exists) {
      console.error(
        "Table `users` does not exist. Run migration 006 first: node scripts/db-migrate.mjs"
      );
      process.exit(1);
    }

    const result = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role, active)
      VALUES (${email}, ${passwordHash}, 'super_admin', TRUE)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `;

    if (result.length === 0) {
      console.error(
        `\nFAILED: a user with email "${email}" already exists. No changes made.`
      );
      process.exit(1);
    }

    console.log(
      `\nSUCCESS: created super_admin "${email}" (id ${result[0]!.id}).`
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]).includes("create-admin");

if (isMain) {
  main().catch((err) => {
    console.error(
      "[create-admin] FAILED:",
      err instanceof Error ? err.message : err
    );
    process.exit(1);
  });
}
