/**
 * CLI for the first prod run of the Accenture Final Report upload.
 *
 * No flag = dry run: parses the file and runs the real engine with
 * dryRun=true, printing the full counts. Allowed against ANY database,
 * including prod — it is PROVABLY read-only, not just "structurally no
 * write statements in the dry-run code path" (candidate-accenture-engine.ts's
 * own doc comment): this script opens its own dedicated, single-connection
 * (`max: 1`) client and runs `SET default_transaction_read_only = on` on it
 * before the dry run — so even a latent bug that tried to write would be
 * rejected by Postgres itself ("cannot execute ... in a read-only
 * transaction"), not merely avoided by careful code review. `max: 1`
 * matters: a pooled client could otherwise run the SET on one physical
 * connection while a later query lands on a different, unrestricted one.
 *
 * --apply writes for real, and ONLY when --confirm-matched=<N> is also
 * given and N exactly equals this run's LIVE recomputed matched-CID count —
 * not a cached/prior number — same confirm-count convention as
 * scripts/lateral-master-additive-import.ts's --confirm-insert. If the
 * target database's name is literally "ara_db" (the real prod database's
 * name), --apply ADDITIONALLY requires --allow-prod; without it, --apply is
 * refused with a clear message before any write-capable code runs. This
 * script itself never passes --allow-prod to itself under any code path —
 * only a human invoking it from the command line can supply that flag.
 *
 * Always goes through invokeCandidateAccentureSync (the same job the HTTP
 * route calls) for both the preview and the real run — never a second copy
 * of the engine logic.
 *
 * Prints the target database's host and name (never the password) before
 * doing anything else.
 *
 * Usage:
 *   npx tsx scripts/candidate-accenture-upload.ts --file <path.xlsx>
 *   npx tsx scripts/candidate-accenture-upload.ts --file <path.xlsx> --apply --confirm-matched=<N>
 *   npx tsx scripts/candidate-accenture-upload.ts --file <path.xlsx> --apply --confirm-matched=<N> --allow-prod   (only when the target db is named "ara_db")
 */
import fs from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";
import { invokeCandidateAccentureSync } from "../src/services/candidate-processing/candidate-accenture-sync-job";

const PROD_DB_NAME = "ara_db";

function parseTarget(url: string): { host: string; dbName: string } {
  const afterAt = url.split("@")[1] ?? url;
  const host = afterAt.split("/")[0] ?? "(unknown)";
  const dbNameMatch = url.match(/\/([^/?]+)(\?|$)/);
  const dbName = dbNameMatch ? dbNameMatch[1] : "(unknown)";
  return { host, dbName };
}

/**
 * This script's OWN connection, deliberately separate from the shared
 * src/lib/persistence/db-client.ts singleton (which may pool several
 * connections) — `max: 1` is what makes the read-only SET below apply to
 * every single query this process ever runs, with no possibility of a
 * second, unrestricted pooled connection slipping in.
 */
function makeSqlClient(url: string): ReturnType<typeof postgres> {
  return postgres(url, {
    max: 1,
    connect_timeout: 15,
    prepare: false,
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
}

function printCounts(label: string, result: Awaited<ReturnType<typeof invokeCandidateAccentureSync>>) {
  console.log(`\n${label}`);
  console.log(`  result: ${result.result}${result.dryRun ? " (dry run — zero writes)" : ""}`);
  if (result.failureReason) {
    console.log(`  failureReason: ${result.failureReason}`);
    return;
  }
  const c = result.counts;
  console.log(`  rowsInSheet: ${c.rowsInSheet}`);
  console.log(`  matchedCidCount: ${c.matchedCidCount} (${c.matchedRowCount} live rows)`);
  console.log(`  insertedCount: ${c.insertedCount}`);
  console.log(`  skippedBlankCidCount: ${c.skippedBlankCidCount}`);
  console.log(`  invalidCidCount: ${c.invalidCidCount}`);
  console.log(`  reviewFlagCount: ${c.reviewFlagCount}`);
  console.log(`  fieldChangeCounts: ${JSON.stringify(c.fieldChangeCounts)}`);
  console.log(`  levelFormatOnlyNoOpCount: ${c.levelFormatOnlyNoOpCount}`);
  console.log(`  nameMismatchNotesCount: ${c.nameMismatchNotesCount}`);
  console.log(`  blankCellsKeptCount: ${c.blankCellsKeptCount}`);
  console.log(`  newlyLockedCount: ${JSON.stringify(c.newlyLockedCount)}`);
}

async function main() {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => a.startsWith("--file="))?.slice("--file=".length)
    ?? (args.includes("--file") ? args[args.indexOf("--file") + 1] : null);
  if (!fileArg) {
    console.error(
      "Usage: npx tsx scripts/candidate-accenture-upload.ts --file <path.xlsx> [--apply --confirm-matched=<N> [--allow-prod]]"
    );
    process.exitCode = 1;
    return;
  }

  const execute = args.includes("--apply");
  const allowProd = args.includes("--allow-prod");
  const confirmArg = args.find((a) => a.startsWith("--confirm-matched="));
  const confirmMatched = confirmArg ? Number(confirmArg.slice("--confirm-matched=".length)) : null;

  const url = process.env.POSTGRES_URL?.trim();
  if (!url) {
    console.error("POSTGRES_URL is not set.");
    process.exitCode = 1;
    return;
  }
  const { host, dbName } = parseTarget(url);
  console.log(`Target database host: ${host}`);
  console.log(`Target database name: ${dbName}`);

  if (execute && dbName === PROD_DB_NAME && !allowProd) {
    console.error(
      `\nRefusing --apply against a database named "${PROD_DB_NAME}" without --allow-prod. ` +
        "This is the real prod database's name — pass --allow-prod explicitly if you really mean to write to it, " +
        "after reviewing the dry-run counts above. Omit --apply for a (fully read-only) dry run."
    );
    process.exitCode = 1;
    return;
  }

  const absolutePath = path.resolve(fileArg);
  const buffer = await fs.readFile(absolutePath);
  const filename = path.basename(absolutePath);
  const sql = makeSqlClient(url);

  try {
    // Provably read-only: this connection (the only one this process ever
    // opens, max: 1) cannot execute a write statement while this is set —
    // Postgres itself enforces it, not just the dry-run code path's own
    // restraint. See the "proof" test in
    // verify-candidate-accenture-cli.ts, which asserts a direct UPDATE on
    // this same connection throws while this is on.
    await sql.unsafe("SET default_transaction_read_only = on");
    const dryRunResult = await invokeCandidateAccentureSync(buffer, filename, "cli-dry-run", sql, true);
    printCounts("Dry run (zero writes, provably read-only):", dryRunResult);

    if (!execute) {
      console.log("\nNo --apply given — this was a dry run only. Nothing was written.");
      return;
    }

    if (dryRunResult.failureReason) {
      console.error("\nRefusing --apply: the dry run itself failed to parse the file. Fix the file first.");
      process.exitCode = 1;
      return;
    }

    const liveMatchedCidCount = dryRunResult.counts.matchedCidCount;
    if (confirmMatched === null || Number.isNaN(confirmMatched)) {
      console.error(
        `\n--apply requires --confirm-matched=<N>. This run computed ${liveMatchedCidCount} matched CID(s) — ` +
          `re-run with --confirm-matched=${liveMatchedCidCount} to proceed, or omit --apply for a dry run.`
      );
      process.exitCode = 1;
      return;
    }
    if (confirmMatched !== liveMatchedCidCount) {
      console.error(
        `\n--confirm-matched=${confirmMatched} does not match this run's live computed count of ${liveMatchedCidCount}. ` +
          `Refusing to write. Re-run with --confirm-matched=${liveMatchedCidCount} if that count is correct.`
      );
      process.exitCode = 1;
      return;
    }

    // Writes are now intended and authorized (confirm-count matched, and
    // --allow-prod was already checked above if this is the prod-named db)
    // — lift the read-only guard on this same single connection.
    await sql.unsafe("SET default_transaction_read_only = off");
    console.log(`\n--confirm-matched=${confirmMatched} matches the live computed count. Applying for real...`);
    const applyResult = await invokeCandidateAccentureSync(buffer, filename, "cli-apply", sql, false);
    printCounts("Applied (real writes):", applyResult);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
