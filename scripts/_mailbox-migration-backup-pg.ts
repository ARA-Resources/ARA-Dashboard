/**
 * Secure backup of Postgres Gmail/setup/checkpoint for mailbox migration.
 * Writes encrypted envelopes to disk; prints only non-secret metadata.
 */
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

async function loadEnvLocal() {
  const content = await fs.readFile(
    path.join(process.cwd(), ".env.local"),
    "utf8"
  );
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (k && !(k in process.env)) process.env[k] = v;
  }
}

async function main() {
  await loadEnvLocal();
  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    console.error("STOP: POSTGRES_URL missing — cannot backup production state.");
    process.exit(1);
  }

  const backupRoot = process.argv[2];
  if (!backupRoot) {
    console.error("Usage: tsx scripts/... <backupDir>");
    process.exit(1);
  }

  const sql = postgres(url, {
    max: 1,
    connect_timeout: 15,
    ssl:
      url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });

  try {
    const keys = ["gmail-oauth.enc.json", "dataset-setup.enc.json"];
    const pgDir = path.join(backupRoot, "postgres");
    await fs.mkdir(pgDir, { recursive: true });

    const found: string[] = [];
    const missing: string[] = [];

    for (const key of keys) {
      const rows = await sql<{ encrypted_value: string; updated_at: Date }[]>`
        SELECT encrypted_value, updated_at FROM app_config WHERE key = ${key} LIMIT 1
      `;
      if (!rows[0]) {
        missing.push(key);
        continue;
      }
      await fs.writeFile(
        path.join(pgDir, key),
        rows[0].encrypted_value,
        "utf8"
      );
      found.push(key);
    }

    const cp = await sql<Record<string, unknown>[]>`
      SELECT
        account_email,
        message_id IS NOT NULL AS has_message_id,
        attachment_id IS NOT NULL AS has_attachment_id,
        received_at,
        received_at_ms,
        attachment_file,
        drive_file_id IS NOT NULL AS has_drive_file_id,
        processed_at,
        result,
        updated_at
      FROM gmail_checkpoint
      WHERE account_email = 'default'
      LIMIT 1
    `;

    // Full checkpoint row for restore (message IDs are not OAuth secrets)
    const cpFull = await sql<Record<string, unknown>[]>`
      SELECT * FROM gmail_checkpoint WHERE account_email = 'default' LIMIT 1
    `;
    await fs.writeFile(
      path.join(pgDir, "gmail_checkpoint.default.json"),
      JSON.stringify(cpFull[0] ?? null, null, 2),
      "utf8"
    );

    const master = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_master
    `;
    const staging = await sql<{ c: string }[]>`
      SELECT COUNT(*)::text AS c FROM lateral_staging
    `;

    const meta = {
      createdAt: new Date().toISOString(),
      appConfigFound: found,
      appConfigMissing: missing,
      checkpointSummary: cp[0] ?? null,
      masterCount: Number(master[0].c),
      stagingCount: Number(staging[0].c),
    };
    await fs.writeFile(
      path.join(pgDir, "BACKUP_META.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );

    console.log(
      JSON.stringify(
        {
          ok: missing.length === 0 || found.length > 0,
          appConfigFound: found,
          appConfigMissing: missing,
          checkpointPresent: Boolean(cpFull[0]),
          masterCount: meta.masterCount,
          stagingCount: meta.stagingCount,
          note:
            missing.length > 0
              ? "Some app_config keys missing in Postgres (may live only in local .data)."
              : "All requested app_config keys backed up.",
        },
        null,
        2
      )
    );

    // For local-first migration, missing PG oauth is OK if local file backup exists.
    // Hard-stop only if we couldn't write anything useful.
    if (found.length === 0 && !cpFull[0]) {
      console.error("STOP: No Postgres Gmail/setup/checkpoint state found.");
      process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error("STOP: Postgres backup failed.", e instanceof Error ? e.message : e);
  process.exit(1);
});
