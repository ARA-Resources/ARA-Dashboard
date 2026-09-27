/**
 * Isolated, read-only diagnostic for the Executive "Run All" Gmail
 * discovery bug: messages.list() returns resultSizeEstimate 0 for a query
 * confirmed to match via Gmail's own web search UI.
 *
 * Answers the 6 open questions directly, bypassing all pipeline code except
 * the shared auth/query-building helpers (reused as-is, not reimplemented):
 *   1. account identity   2. full request params   3. raw string integrity
 *   4. isolated API test per clause   5. token/scope   6. pagination/category
 *
 * Read-only: messages.list() and users.getProfile() make no mutations.
 * No checkpoint, DB, or Drive writes.
 *
 * Run inside the live prod container (needs the real encrypted Gmail token
 * + Postgres-backed dataset setup):
 *   npx tsx scripts/debug-executive-gmail-query.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { readDatasetSetup } from "../src/services/dataset/secure-store";
import { readExecutiveGmailCheckpoint } from "../src/services/executive-processing/executive-gmail-checkpoint-store";
import { buildExecutiveExcelDiscoveryQuery } from "../src/services/executive-processing/executive-excel-discovery";
import { EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS } from "../src/services/executive-processing/executive-gmail-incremental-sync";
import { isExecutiveDsAttachmentName } from "../src/services/dataset/executive-dataset-mapping";
import type { gmail_v1 } from "googleapis";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
  "openid",
  "email",
  "profile",
];

function section(title: string) {
  console.log(`\n${"=".repeat(8)} ${title} ${"=".repeat(8)}`);
}

async function main() {
  const { gmail, auth } = await getAuthorizedGmailClient();
  const setup = await readDatasetSetup();
  if (!setup) throw new Error("Dataset setup not found.");
  const executive = setup.datasets?.Executive;
  if (!executive) throw new Error("Executive dataset not configured.");

  // ---- 1. ACCOUNT IDENTITY CHECK ----
  section("1. ACCOUNT IDENTITY CHECK");
  const profile = await gmail.users.getProfile({ userId: "me" });
  console.log("Live gmail.users.getProfile().emailAddress:", profile.data.emailAddress);
  console.log("Stored auth.email (captured at OAuth connect):", auth.email);
  console.log("Stored auth.expectedEmail:", auth.expectedEmail);
  console.log("Dataset setup.gmailAddress:", setup.gmailAddress);
  const expected = "mis@araresources.com";
  const allMatch = [profile.data.emailAddress, auth.email, setup.gmailAddress]
    .filter(Boolean)
    .every((e) => e!.toLowerCase() === expected);
  console.log(
    allMatch
      ? `MATCH: all identities equal ${expected}`
      : `MISMATCH DETECTED against expected ${expected} — see values above`
  );

  // ---- reconstruct the exact production query ----
  const checkpointBefore = await readExecutiveGmailCheckpoint();
  const afterMs = checkpointBefore.receivedAtMs ?? EXECUTIVE_CHECKPOINT_BOOTSTRAP_MS;
  const queryAfterMs = Math.max(0, afterMs - 2000);
  const prodQuery = buildExecutiveExcelDiscoveryQuery({
    afterMs: queryAfterMs,
    keywords: executive.keywords,
  });
  console.log("\nReconstructed checkpoint state:");
  console.log("  checkpointBefore:", JSON.stringify(checkpointBefore));
  console.log("  afterMs:", afterMs, new Date(afterMs).toISOString());
  console.log("  queryAfterMs:", queryAfterMs, new Date(queryAfterMs).toISOString());
  console.log("  Reconstructed production query:", JSON.stringify(prodQuery));

  // ---- 2. FULL REQUEST PARAMETERS DUMP ----
  section("2. FULL REQUEST PARAMETERS DUMP");
  const paramsSent = { userId: "me", q: prodQuery, maxResults: 100 };
  console.log("Params actually sent to messages.list() by the pipeline:");
  console.log(JSON.stringify(paramsSent, null, 2));
  console.log(
    "NOT set (client-library defaults apply): labelIds (none — inbox scoping " +
      "comes only from `in:inbox` inside q), includeSpamTrash (default false), " +
      "pageToken (none — first page only)."
  );

  // ---- 3. RAW STRING INTEGRITY CHECK ----
  section("3. RAW STRING INTEGRITY CHECK");
  console.log("query.length (UTF-16 code units):", prodQuery.length);
  console.log("Buffer.byteLength(query, 'utf8'):", Buffer.byteLength(prodQuery, "utf8"));
  const codePoints = Array.from(prodQuery).map((c) => c.codePointAt(0));
  console.log("Code point count:", codePoints.length);
  console.log("Code points:", JSON.stringify(codePoints));
  const nonAscii = Array.from(prodQuery)
    .map((c, i) => ({ c, code: c.codePointAt(0)!, i }))
    .filter((x) => x.code > 127);
  console.log(
    nonAscii.length === 0
      ? "No non-ASCII / hidden characters found."
      : `NON-ASCII CHARACTERS FOUND: ${JSON.stringify(nonAscii)}`
  );

  // ---- 5. TOKEN / SCOPE CHECK ----
  section("5. TOKEN / SCOPE CHECK");
  const grantedScopes = (auth.tokens.scope ?? "").split(/\s+/).filter(Boolean);
  console.log("Granted scopes (from stored token):", grantedScopes);
  const missingScopes = GMAIL_SCOPES.filter((s) => !grantedScopes.includes(s));
  console.log(
    missingScopes.length === 0
      ? "All required scopes present."
      : `MISSING SCOPES: ${JSON.stringify(missingScopes)}`
  );
  const expiryMs = auth.tokens.expiry_date ?? null;
  console.log(
    "Token expiry_date:",
    expiryMs,
    expiryMs ? new Date(expiryMs).toISOString() : "(none)"
  );
  if (expiryMs) {
    const minsRemaining = Math.round((expiryMs - Date.now()) / 60000);
    console.log(
      minsRemaining > 0
        ? `Token valid, ${minsRemaining} minutes remaining (client auto-refreshes as needed).`
        : `Token expired ${-minsRemaining} minutes ago (client should auto-refresh on next call).`
    );
  }

  // ---- 4 & 6. DIRECT, ISOLATED API TEST (progressive queries) ----
  section("4 & 6. DIRECT ISOLATED API TEST (progressive queries)");
  const testQueries: Array<{ label: string; q: string }> = [
    { label: "(a) filename only", q: "filename:ATCI Exec DS_" },
    { label: "(b) filename + bareword keyword", q: "filename:ATCI Exec DS_ Exec" },
    {
      label: "(c) filename + keyword OR-group",
      q: 'filename:ATCI Exec DS_ (Exec OR "ATCI Exec DS")',
    },
    {
      label: "(d) + in:inbox",
      q: 'in:inbox filename:ATCI Exec DS_ (Exec OR "ATCI Exec DS")',
    },
    { label: "(e) full production query (+ after:)", q: prodQuery },
    {
      label: "(f) has:attachment instead of filename: (no filename: clause at all)",
      q: `in:inbox after:${prodQuery.match(/after:(\S+)/)![1]} has:attachment (Exec OR "ATCI Exec DS")`,
    },
  ];

  const messageIdsByLabel = new Map<string, string[]>();
  for (const { label, q } of testQueries) {
    console.log(`\n--- ${label} ---`);
    console.log("q:", JSON.stringify(q));
    const list = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 100,
    });
    const messages = list.data.messages ?? [];
    console.log("httpStatus:", list.status);
    console.log("resultSizeEstimate:", list.data.resultSizeEstimate ?? null);
    console.log("messagesArrayLength:", messages.length);
    console.log("hasNextPageToken:", Boolean(list.data.nextPageToken));
    const ids = messages.map((m) => m.id!).filter(Boolean);
    messageIdsByLabel.set(label, ids);
    if (ids.length > 0) {
      console.log("Message IDs found:", ids.slice(0, 5));
    }
  }

  // ---- 7. KNOWN-TARGET VERIFICATION (subject + attachment name check) ----
  // For each message from query (f), fetch full detail (format="full" is
  // required to see attachment parts — "metadata"/"minimal" only return
  // headers, no MIME parts), check whether its subject matches one of the two
  // known target emails, and if so run every real attachment filename found
  // through the pipeline's own isExecutiveDsAttachmentName() (imported
  // unmodified — not reimplemented).
  section("7. KNOWN-TARGET VERIFICATION (subject + attachment name check)");
  const attachmentQueryLabel =
    "(f) has:attachment instead of filename: (no filename: clause at all)";
  const attachmentMessageIds = messageIdsByLabel.get(attachmentQueryLabel) ?? [];
  console.log(
    `Fetching full detail for all ${attachmentMessageIds.length} messages from query (f)...`
  );

  function collectAttachmentFilenames(
    part: gmail_v1.Schema$MessagePart | undefined,
    out: string[]
  ) {
    if (!part) return;
    if (part.filename) out.push(part.filename);
    if (part.parts) for (const p of part.parts) collectAttachmentFilenames(p, out);
  }

  const TARGET_PATTERNS = [
    { label: "Sep 11 target", re: /11th\s+September\s+2026/i },
    { label: "Sep 16 target", re: /16th\s+September\s+2026/i },
  ];

  const summaries: Array<{ id: string; subject: string; target: string | null }> = [];
  for (const id of attachmentMessageIds) {
    const msg = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const headers = msg.data.payload?.headers ?? [];
    const subject =
      headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "(no subject)";
    const receivedAtMs = Number(msg.data.internalDate ?? 0);
    const match = TARGET_PATTERNS.find((t) => t.re.test(subject));
    summaries.push({ id, subject, target: match?.label ?? null });

    if (match) {
      const filenames: string[] = [];
      collectAttachmentFilenames(msg.data.payload, filenames);
      console.log(`\n>>> ${match.label} FOUND — message ${id}`);
      console.log("  Subject:", subject);
      console.log(
        "  receivedAt:",
        receivedAtMs ? new Date(receivedAtMs).toISOString() : "(unknown)"
      );
      console.log("  Attachment filenames + isExecutiveDsAttachmentName():");
      if (filenames.length === 0) {
        console.log("    (no attachment filenames found in this message's MIME parts)");
      }
      for (const fn of filenames) {
        console.log(`    ${JSON.stringify(fn)} -> ${isExecutiveDsAttachmentName(fn)}`);
      }
    }
  }

  const targetsFound = summaries.filter((s) => s.target).length;
  console.log(
    `\nSummary: ${targetsFound} of ${attachmentMessageIds.length} messages matched a known-target subject pattern (expected 2).`
  );
  console.log("\nAll subjects from query (f), for manual inspection:");
  for (const s of summaries) {
    console.log(`  [target=${s.target ?? "no"}] ${s.id}  ${s.subject}`);
  }

  console.log("\nDone. No mutations were made (read-only calls only).");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
