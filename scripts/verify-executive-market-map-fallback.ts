/**
 * Verify the corrected Market Map 3-branch fallback (no network, no I/O).
 */
import {
  resolveExecutiveMarketMapColumn,
  resolveExecutiveBaseDsHeaderIndex,
  mapExecutiveBaseDsRow,
} from "../src/services/executive-processing/executive-base-ds-mapping";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const BASE_HEADERS = [
  "Job Requisition ID",
  "Primary Skills",
  "Job Management Level",
  "Skill Categorization",
  "Primary Location",
  "Mandatory skill",
  "Location Flex",
  "Job Description",
  "Priority given to agency",
];

// --- Both (Old) and (New) present -> New wins ---
{
  const headers = [
    ...BASE_HEADERS,
    "Final Market Map (Old)",
    "Final Market Map (New)",
  ];
  const res = resolveExecutiveMarketMapColumn(headers);
  assert(res.source === "new", "both present: must prefer (New)");
  assert(res.index === headers.indexOf("Final Market Map (New)"), "must point at (New) column");
  assert(res.oldColumnPresent === true, "must report (Old) presence even though unused");
}

// --- Only plain "Final Market Map" present -> use plain ---
{
  const headers = [...BASE_HEADERS, "Final Market Map"];
  const res = resolveExecutiveMarketMapColumn(headers);
  assert(res.source === "plain", "only plain present: must use plain");
  assert(res.index === headers.indexOf("Final Market Map"), "must point at plain column");
  assert(res.oldColumnPresent === false, "no (Old) column present");
}

// --- THE FIX: only "(Old)" present, no "(New)", no plain -> must use (Old), not "none" ---
{
  const headers = [...BASE_HEADERS, "Final Market Map (Old)"];
  const res = resolveExecutiveMarketMapColumn(headers);
  assert(res.source === "old", `only (Old) present: must resolve to "old", got "${res.source}"`);
  assert(res.index === headers.indexOf("Final Market Map (Old)"), "must point at (Old) column");
  assert(res.oldColumnPresent === true, "must report (Old) presence");
  assert(res.index >= 0, "must not be -1 — this was the original bug");
}

// --- Nothing present at all -> genuinely "none" ---
{
  const headers = [...BASE_HEADERS];
  const res = resolveExecutiveMarketMapColumn(headers);
  assert(res.source === "none", "nothing present: must be none");
  assert(res.index === -1, "index must be -1 when truly absent");
  assert(res.oldColumnPresent === false, "no (Old) column present");
}

// --- Case-insensitive / normalized matching still works for the (Old)-alone case ---
{
  const headers = [...BASE_HEADERS, "final market map (old)"];
  const res = resolveExecutiveMarketMapColumn(headers);
  assert(res.source === "old", "case-insensitive (Old)-alone must still resolve to old");
}

// --- End-to-end: mapExecutiveBaseDsRow actually reads the (Old)-alone column's value ---
{
  const headers = [...BASE_HEADERS, "Final Market Map (Old)"];
  const headerIndex = resolveExecutiveBaseDsHeaderIndex(headers);
  assert(headerIndex.marketMap.source === "old", "header index must resolve to old");
  assert(
    !headerIndex.missingHeaders.includes("Final Market Map (New) / Final Market Map"),
    "must NOT report Market Map as missing when (Old) alone is present"
  );

  const row = headers.map((h) =>
    h === "Job Requisition ID" ? "ATCI-1-S1" : h === "Final Market Map (Old)" ? "APAC" : "x"
  );
  const mapped = mapExecutiveBaseDsRow(headerIndex, row);
  assert(mapped !== null, "row must map");
  assert(mapped!.values.market_map === "APAC", `must read (Old) column's value, got ${mapped!.values.market_map}`);
}

// --- Excel error code in the (Old)-alone column is blanked and reported with the right label ---
{
  const headers = [...BASE_HEADERS, "Final Market Map (Old)"];
  const headerIndex = resolveExecutiveBaseDsHeaderIndex(headers);
  const row = headers.map((h) =>
    h === "Job Requisition ID" ? "ATCI-2-S2" : h === "Final Market Map (Old)" ? "#REF!" : "x"
  );
  const mapped = mapExecutiveBaseDsRow(headerIndex, row);
  assert(mapped !== null, "row must map");
  assert(mapped!.values.market_map === null, "error code must blank to null");
  const err = mapped!.errors.find((e) => e.column === "Final Market Map (Old)");
  assert(!!err, `error must be reported against the "Final Market Map (Old)" label, got: ${JSON.stringify(mapped!.errors)}`);
  assert(err!.errorType === "#REF!", "error type must be preserved");
}

console.log("verify-executive-market-map-fallback: OK");
