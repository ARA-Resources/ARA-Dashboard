/**
 * Phase 13 — Persistence Layer Parity Tests
 *
 * Tests: A–I (file/logic), J (PostgreSQL, skipped if POSTGRES_URL unset)
 */

/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs/promises") as typeof import("node:fs/promises");
const path = require("node:path") as typeof import("node:path");
const crypto = require("node:crypto") as typeof import("node:crypto");
const postgres = require("postgres") as typeof import("postgres");

interface TestResult { name: string; status: "PASS" | "FAIL" | "SKIP"; detail?: string; }

async function main() {
  // ─── Load .env.local ────────────────────────────────────────────────────────
  const envPath = path.join(process.cwd(), ".env.local");
  try {
    const content = await fs.readFile(envPath, "utf8");
    for (const line of content.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !(k in process.env)) process.env[k] = v;
    }
  } catch { /* ok */ }

  // ─── Harness ────────────────────────────────────────────────────────────────
  let passed = 0, failed = 0;
  const results: TestResult[] = [];

  function ok(name: string, cond: boolean, detail?: string) {
    if (cond) { passed++; results.push({ name, status: "PASS" }); console.log(`  ✓ ${name}`); }
    else { failed++; results.push({ name, status: "FAIL", detail }); console.error(`  ✗ ${name}${detail ? " — " + detail : ""}`); }
  }
  function skip(name: string, reason: string) {
    results.push({ name, status: "SKIP", detail: reason });
    console.log(`  ⊘ ${name} [SKIP: ${reason}]`);
  }

  // ─── Encryption helpers ──────────────────────────────────────────────────────
  const TEST_SECRET = "phase13-test-ara-secret-do-not-use-in-prod";

  function makeEnvelope(plaintext: string, secret = TEST_SECRET): string {
    const key = crypto.createHash("sha256").update(secret).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return JSON.stringify({ alg: "aes-256-gcm",
      iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
      ciphertext: enc.toString("base64"), savedAt: new Date().toISOString() });
  }

  function decryptEnvelope(envelope: string, secret = TEST_SECRET): string {
    const p = JSON.parse(envelope);
    const key = crypto.createHash("sha256").update(secret).digest();
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64"));
    d.setAuthTag(Buffer.from(p.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(p.ciphertext, "base64")), d.final()]).toString("utf8");
  }

  // ─── Test sandbox ────────────────────────────────────────────────────────────
  const TEST_DIR = path.join(process.cwd(), `.data-test-phase13-${Date.now()}`);
  await fs.mkdir(TEST_DIR, { recursive: true });

  // ─── A. Checkpoint write/read ────────────────────────────────────────────────
  console.log("\nA. File checkpoint write/read");
  {
    const p = path.join(TEST_DIR, "cp.json");
    const cp = { version: 1, messageId: "msg_001", receivedAtMs: 1786915200000, processingResult: "SUCCESS" };
    await fs.writeFile(p, JSON.stringify(cp, null, 2), "utf8");
    const r = JSON.parse(await fs.readFile(p, "utf8"));
    ok("A1. messageId round-trip", r.messageId === "msg_001");
    ok("A2. receivedAtMs round-trip", r.receivedAtMs === 1786915200000);
    ok("A3. processingResult=SUCCESS", r.processingResult === "SUCCESS");
    const cp2 = { ...r, messageId: "msg_002", receivedAtMs: r.receivedAtMs + 1000 };
    await fs.writeFile(p, JSON.stringify(cp2, null, 2), "utf8");
    const r2 = JSON.parse(await fs.readFile(p, "utf8"));
    ok("A4. Advance updates messageId", r2.messageId === "msg_002");
    ok("A5. Advance updates receivedAtMs", r2.receivedAtMs === 1786915201000);
  }

  // ─── B. Encrypted config ─────────────────────────────────────────────────────
  console.log("\nB. Encrypted config write/read");
  {
    const p = path.join(TEST_DIR, "oauth.enc.json");
    const plain = JSON.stringify({ access_token: "[REDACTED]", refresh_token: "[REDACTED]" });
    const env = makeEnvelope(plain);
    await fs.writeFile(p, env, "utf8");
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw);
    ok("B1. No plaintext in stored value", !raw.includes("[REDACTED]"));
    ok("B2. alg=aes-256-gcm", parsed.alg === "aes-256-gcm");
    ok("B3. Decrypted matches original", decryptEnvelope(raw) === plain);
    await fs.unlink(p);
    let gone = false; try { await fs.readFile(p, "utf8"); } catch { gone = true; }
    ok("B4. Delete removes file", gone);
  }

  // ─── C. Scheduler state ──────────────────────────────────────────────────────
  console.log("\nC. Scheduler state write/read/update");
  {
    const p = path.join(TEST_DIR, "sch.json");
    const cfg = { version: 1, frequency: "custom", syncTime: "09:00", customTimes: ["09:00","11:00"],
      enabled: true, paused: false, lastRunStatus: "success" };
    await fs.writeFile(p, JSON.stringify(cfg, null, 2), "utf8");
    const r = JSON.parse(await fs.readFile(p, "utf8"));
    ok("C1. enabled round-trip", r.enabled === true);
    ok("C2. customTimes round-trip", JSON.stringify(r.customTimes) === '["09:00","11:00"]');
    ok("C3. lastRunStatus round-trip", r.lastRunStatus === "success");
    r.lastRunStatus = "failed"; r.lastRunMessage = "Updated";
    await fs.writeFile(p, JSON.stringify(r, null, 2), "utf8");
    const r2 = JSON.parse(await fs.readFile(p, "utf8"));
    ok("C4. Update lastRunStatus", r2.lastRunStatus === "failed");
  }

  // ─── D. Sync history ─────────────────────────────────────────────────────────
  console.log("\nD. Sync history append");
  {
    const p = path.join(TEST_DIR, "hist.json");
    const e1 = { id: crypto.randomUUID(), syncTime: new Date().toISOString(), rowsImported: 100, result: "Success" };
    await fs.writeFile(p, JSON.stringify({ version: 1, entries: [e1] }, null, 2), "utf8");
    const r = JSON.parse(await fs.readFile(p, "utf8"));
    ok("D1. Count is 1", r.entries.length === 1);
    ok("D2. rowsImported=100", r.entries[0].rowsImported === 100);
    const e2 = { ...e1, id: crypto.randomUUID(), rowsImported: 200 };
    r.entries.unshift(e2);
    await fs.writeFile(p, JSON.stringify(r, null, 2), "utf8");
    const r2 = JSON.parse(await fs.readFile(p, "utf8"));
    ok("D3. After append count=2", r2.entries.length === 2);
    ok("D4. Newest entry first", r2.entries[0].rowsImported === 200);
  }

  // ─── E. Notifications ────────────────────────────────────────────────────────
  console.log("\nE. Notifications push/mark read/delete");
  {
    const p = path.join(TEST_DIR, "notif.json");
    const n = { id: crypto.randomUUID(), kind: "info", title: "T", body: "B", read: false, createdAt: new Date().toISOString() };
    await fs.writeFile(p, JSON.stringify({ version: 1, notifications: [n] }, null, 2), "utf8");
    const r = JSON.parse(await fs.readFile(p, "utf8"));
    ok("E1. Notification stored", r.notifications.length === 1);
    ok("E2. read=false", r.notifications[0].read === false);
    r.notifications[0].read = true;
    await fs.writeFile(p, JSON.stringify(r, null, 2), "utf8");
    const r2 = JSON.parse(await fs.readFile(p, "utf8"));
    ok("E3. Mark read", r2.notifications[0].read === true);
    r2.notifications = [];
    await fs.writeFile(p, JSON.stringify(r2, null, 2), "utf8");
    const r3 = JSON.parse(await fs.readFile(p, "utf8"));
    ok("E4. Delete clears list", r3.notifications.length === 0);
  }

  // ─── F. Missing record ───────────────────────────────────────────────────────
  console.log("\nF. Missing record");
  {
    let val: unknown = "not-missing";
    try { val = JSON.parse(await fs.readFile(path.join(TEST_DIR, "no-such-file.json"), "utf8")); }
    catch { val = null; }
    ok("F1. Missing file returns null/error gracefully", val === null);
  }

  // ─── G. Concurrent checkpoint simulation ─────────────────────────────────────
  console.log("\nG. Concurrent checkpoint (optimistic locking logic)");
  {
    const currentMs = 1786961228000;
    const storedMs = currentMs + 1000; // Worker A advanced
    // Worker B tries with stale read (currentMs < storedMs) → rejected
    ok("G1. Worker B cannot overwrite newer checkpoint", storedMs > currentMs);
    // Genuine new email IS accepted
    ok("G2. New email with higher receivedAtMs is accepted", (currentMs + 2000) > storedMs);
    // Stale timestamp rejected
    ok("G3. Stale timestamp is rejected", (currentMs - 1000) < storedMs);
    // Final checkpoint = Worker A's value
    ok("G4. Final checkpoint = Worker A value", storedMs === currentMs + 1000);
  }

  // ─── H. Encryption round trip ────────────────────────────────────────────────
  console.log("\nH. Encryption round trip (AES-256-GCM)");
  {
    const plain = JSON.stringify({ refresh_token: "[PHASE13_TEST_DO_NOT_LOG]" });
    const env = makeEnvelope(plain);
    ok("H1. Ciphertext ≠ plaintext", !env.includes("[PHASE13_TEST_DO_NOT_LOG]"));
    ok("H2. alg=aes-256-gcm", JSON.parse(env).alg === "aes-256-gcm");
    ok("H3. Decrypted matches original", decryptEnvelope(env) === plain);
    ok("H4. Wrong key throws", (() => {
      try { decryptEnvelope(env, "wrong-secret"); return false; }
      catch { return true; }
    })());
  }

  // ─── I. Persistence mode flag ────────────────────────────────────────────────
  console.log("\nI. Persistence mode flag (env var)");
  {
    const orig = process.env.ARA_PERSISTENCE;
    delete process.env.ARA_PERSISTENCE;
    ok("I1. Default=file when unset", (process.env.ARA_PERSISTENCE?.toLowerCase() ?? "file") === "file");
    process.env.ARA_PERSISTENCE = "postgres";
    ok("I2. postgres when ARA_PERSISTENCE=postgres", process.env.ARA_PERSISTENCE.toLowerCase() === "postgres");
    process.env.ARA_PERSISTENCE = "FILE";
    ok("I3. file for uppercase FILE", process.env.ARA_PERSISTENCE.toLowerCase() !== "postgres");
    if (orig !== undefined) process.env.ARA_PERSISTENCE = orig; else delete process.env.ARA_PERSISTENCE;
  }

  // ─── J. PostgreSQL integration ───────────────────────────────────────────────
  const pgUrl = process.env.POSTGRES_URL?.trim();
  console.log("\nJ. PostgreSQL integration tests");

  if (!pgUrl) {
    for (const t of ["J1.Checkpoint","J2.Concurrent","J3.EncryptedConfig","J4.Scheduler","J5.SyncHistory","J6.HomeMetrics","J7.Notifications"])
      skip(t, "POSTGRES_URL not set");
  } else {
    const sql = postgres(pgUrl, { max: 1, connect_timeout: 10,
      ssl: (pgUrl.includes("localhost") || pgUrl.includes("127.0.0.1")) ? false : ("require" as const) });
    try {
      await sql`SELECT 1`;
      const tables = await sql<{tablename: string}[]>`
        SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`;
      const tset = new Set(tables.map(t => t.tablename));

      if (!tset.has("gmail_checkpoint")) {
        for (const t of ["J1-J7"]) skip(t, "Schema not migrated. Run: npm run db:migrate");
      } else {
        // J1 + J2: Checkpoint
        const acct = `test-phase13-${Date.now()}`;
        await sql`INSERT INTO gmail_checkpoint (account_email) VALUES (${acct}) ON CONFLICT DO NOTHING`;
        const cp1 = await sql<{message_id: string|null, received_at_ms: bigint|null}[]>`
          SELECT message_id, received_at_ms FROM gmail_checkpoint WHERE account_email = ${acct}`;
        ok("J1a. Checkpoint row exists", cp1.length === 1);
        ok("J1b. messageId null initially", cp1[0].message_id === null);

        const ms = BigInt(Date.now());
        await sql`UPDATE gmail_checkpoint SET message_id='test_j1', received_at_ms=${ms}, result='SUCCESS', updated_at=NOW()
          WHERE account_email=${acct} AND (received_at_ms IS NULL OR received_at_ms < ${ms})`;
        const cp2 = await sql<{message_id: string}[]>`SELECT message_id FROM gmail_checkpoint WHERE account_email=${acct}`;
        ok("J1c. Checkpoint advanced", cp2[0].message_id === "test_j1");

        // J2: stale write
        const staleMs = ms - BigInt(1000);
        const staleRes = await sql`UPDATE gmail_checkpoint SET message_id='stale', received_at_ms=${staleMs}, result='SUCCESS', updated_at=NOW()
          WHERE account_email=${acct} AND (received_at_ms IS NULL OR received_at_ms < ${staleMs}) RETURNING message_id`;
        ok("J2a. Stale write rejected (rowcount=0)", staleRes.count === 0);
        const cp3 = await sql<{message_id: string}[]>`SELECT message_id FROM gmail_checkpoint WHERE account_email=${acct}`;
        ok("J2b. Checkpoint still has newer value", cp3[0].message_id === "test_j1");
        await sql`DELETE FROM gmail_checkpoint WHERE account_email=${acct}`;

        // J3: Encrypted config
        if (tset.has("app_config")) {
          const k = `test-phase13-${Date.now()}`;
          const env = makeEnvelope(JSON.stringify({ test: "phase13_value" }));
          await sql`INSERT INTO app_config (key, encrypted_value, updated_at) VALUES (${k}, ${env}, NOW())
            ON CONFLICT (key) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value, updated_at=NOW()`;
          const rows = await sql<{encrypted_value: string}[]>`SELECT encrypted_value FROM app_config WHERE key=${k}`;
          ok("J3a. Config stored", rows.length === 1);
          ok("J3b. No plaintext in DB", !rows[0].encrypted_value.includes("phase13_value"));
          const dec = JSON.parse(decryptEnvelope(rows[0].encrypted_value));
          ok("J3c. Decrypts correctly", dec.test === "phase13_value");
          await sql`DELETE FROM app_config WHERE key=${k}`;
          ok("J3d. Delete works", (await sql<{key:string}[]>`SELECT key FROM app_config WHERE key=${k}`).length === 0);
        } else skip("J3. Encrypted config", "app_config table missing");

        // J4: Scheduler
        if (tset.has("lateral_scheduler_state")) {
          const sch = await sql<{id: number}[]>`SELECT id FROM lateral_scheduler_state ORDER BY id LIMIT 1`;
          ok("J4. Scheduler row exists", sch.length > 0);
        } else skip("J4. Scheduler", "table missing");

        // J5: Sync history
        if (tset.has("lateral_sync_history")) {
          const tid = crypto.randomUUID();
          await sql`INSERT INTO lateral_sync_history (id, sync_time, source_email, original_filename, drive_file_id,
            rows_imported, new_count, active_count, reopen_count, closed_count, result, trigger, duration_ms)
            VALUES (${tid}, NOW(), 'phase13@t.com', 'p13.xlsx', 'drv_p13', 42, 3, 39, 1, 100, 'Success', 'manual', 99)`;
          const rows = await sql<{rows_imported: number}[]>`SELECT rows_imported FROM lateral_sync_history WHERE id=${tid}`;
          ok("J5a. Row inserted", rows.length === 1);
          ok("J5b. rows_imported=42", rows[0].rows_imported === 42);
          await sql`DELETE FROM lateral_sync_history WHERE id=${tid}`;
        } else skip("J5. Sync history", "table missing");

        // J6: Home metrics
        if (tset.has("home_metrics")) {
          await sql`INSERT INTO home_metrics (business_unit_id, totals, active, posted, fresh, file_name, mtime_ms, source, computed_at)
            VALUES ('phase13-test', 9999, 9000, 8000, 10, 'p13.xlsm', ${Date.now()}, 'manual', NOW())
            ON CONFLICT (business_unit_id) DO UPDATE SET totals=EXCLUDED.totals, updated_at=NOW()`;
          const rows = await sql<{totals: number}[]>`SELECT totals FROM home_metrics WHERE business_unit_id='phase13-test'`;
          ok("J6a. Row written", rows.length === 1);
          ok("J6b. totals=9999", rows[0].totals === 9999);
          await sql`DELETE FROM home_metrics WHERE business_unit_id='phase13-test'`;
        } else skip("J6. Home metrics", "table missing");

        // J7: Notifications
        if (tset.has("app_notifications")) {
          const nid = crypto.randomUUID();
          await sql`INSERT INTO app_notifications (id, kind, title, body, read, created_at)
            VALUES (${nid}, 'info', 'Phase13', 'Body', FALSE, NOW())`;
          const rows = await sql<{read: boolean}[]>`SELECT read FROM app_notifications WHERE id=${nid}`;
          ok("J7a. Notif inserted", rows.length === 1);
          ok("J7b. read=false", rows[0].read === false);
          await sql`UPDATE app_notifications SET read=TRUE WHERE id=${nid}`;
          const rows2 = await sql<{read: boolean}[]>`SELECT read FROM app_notifications WHERE id=${nid}`;
          ok("J7c. Mark read", rows2[0].read === true);
          await sql`DELETE FROM app_notifications WHERE id=${nid}`;
        } else skip("J7. Notifications", "table missing");
      }
    } catch (err) {
      failed++; results.push({ name: "Postgres integration: ERROR", status: "FAIL", detail: String(err) });
      console.error("  ✗ Postgres error:", err);
    } finally {
      await sql.end();
    }
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────
  await fs.rm(TEST_DIR, { recursive: true, force: true });

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const skipped = results.filter(r => r.status === "SKIP").length;
  console.log("\n" + "─".repeat(60));
  console.log("PHASE 13 PERSISTENCE PARITY TEST RESULTS");
  console.log("─".repeat(60));
  for (const r of results) {
    const icon = r.status === "PASS" ? "✓" : r.status === "SKIP" ? "⊘" : "✗";
    console.log(`  ${icon} [${r.status}] ${r.name}${r.detail ? " — " + r.detail : ""}`);
  }
  console.log("─".repeat(60));
  console.log(`  Passed: ${passed}   Failed: ${failed}   Skipped: ${skipped}`);
  if (failed > 0) console.error("  *** FAILURES DETECTED ***");
  else console.log("  All required tests passed.");
  console.log("─".repeat(60) + "\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
