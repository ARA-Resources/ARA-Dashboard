/**
 * Pure, no-DB validation of the Accenture Final Report upload's two
 * smallest building blocks:
 *  - candidate-jml-format.ts (extractJmlNumber / formatJmlAsLegacy)
 *  - candidate-accenture-engine.ts's computeAccentureFieldChain (the
 *    repeated-CID step-chain algorithm)
 *
 * Run: npx tsx scripts/verify-candidate-accenture-chain.ts
 */
import { extractJmlNumber, formatJmlAsLegacy } from "../src/services/candidate-processing/candidate-jml-format";
import { computeAccentureFieldChain } from "../src/services/candidate-processing/candidate-accenture-engine";

interface TestResult {
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}
const results: TestResult[] = [];
function check(name: string, pass: boolean, detail?: string) {
  results.push({ name, status: pass ? "PASS" : "FAIL", detail });
}

// --- extractJmlNumber ---
check(
  '"9-Team Lead/Consultant" -> 9',
  extractJmlNumber("9-Team Lead/Consultant") === 9
);
check('"CL9" -> 9', extractJmlNumber("CL9") === 9);
check('"cl9" (lowercase) -> 9', extractJmlNumber("cl9") === 9);
check('"CL-9" (dash) -> 9', extractJmlNumber("CL-9") === 9);
check('"cl-9" (lowercase + dash) -> 9', extractJmlNumber("cl-9") === 9);
check('"12-Associate" -> 12', extractJmlNumber("12-Associate") === 12);
check('"-" (blank) -> null', extractJmlNumber("-") === null);
check('"" (empty) -> null', extractJmlNumber("") === null);
check('"Associate Manager" (no number) -> null', extractJmlNumber("Associate Manager") === null);

// --- formatJmlAsLegacy ---
check("formatJmlAsLegacy(9) -> CL9", formatJmlAsLegacy(9) === "CL9");
check("formatJmlAsLegacy(12) -> CL12", formatJmlAsLegacy(12) === "CL12");

// --- computeAccentureFieldChain ---
{
  const r = computeAccentureFieldChain("X", ["A", "B", "C"]);
  check(
    "stored X + file [A,B,C] -> 3 steps (X->A, A->B, B->C), final C, wouldWrite",
    r.wouldWrite &&
      r.finalValue === "C" &&
      r.steps.length === 3 &&
      r.steps[0].oldValue === "X" &&
      r.steps[0].newValue === "A" &&
      r.steps[1].oldValue === "A" &&
      r.steps[1].newValue === "B" &&
      r.steps[2].oldValue === "B" &&
      r.steps[2].newValue === "C",
    JSON.stringify(r)
  );
}
{
  // Re-upload of the same file after the above: stored is now "C".
  const r = computeAccentureFieldChain("C", ["A", "B", "C"]);
  check(
    "re-upload: stored C + file [A,B,C] again -> 0 steps, final C, no write (idempotent)",
    !r.wouldWrite && r.finalValue === "C" && r.steps.length === 0,
    JSON.stringify(r)
  );
}
{
  const r = computeAccentureFieldChain("X", ["A", "A", "B"]);
  check(
    "stored X + file [A,A,B] -> 2 steps (back-to-back A,A collapses to one step)",
    r.wouldWrite &&
      r.finalValue === "B" &&
      r.steps.length === 2 &&
      r.steps[0].oldValue === "X" &&
      r.steps[0].newValue === "A" &&
      r.steps[1].oldValue === "A" &&
      r.steps[1].newValue === "B",
    JSON.stringify(r)
  );
}
{
  const r = computeAccentureFieldChain("C", ["A", "C"]);
  check(
    'stored C + file [A,C] -> 0 steps (final===stored short-circuits even though A appeared mid-sequence)',
    !r.wouldWrite && r.finalValue === "C" && r.steps.length === 0,
    JSON.stringify(r)
  );
}
{
  const r = computeAccentureFieldChain("X", []);
  check(
    "stored X + no occurrences at all -> 0 steps, final stays X (field never mentioned this run)",
    !r.wouldWrite && r.finalValue === "X" && r.steps.length === 0,
    JSON.stringify(r)
  );
}
{
  const r = computeAccentureFieldChain("X", ["X"]);
  check(
    "stored X + file [X] (single occurrence, unchanged) -> 0 steps",
    !r.wouldWrite && r.finalValue === "X" && r.steps.length === 0,
    JSON.stringify(r)
  );
}
{
  const r = computeAccentureFieldChain("CL8", ["CL9"]);
  check(
    "level chain operates on pre-normalized CLn strings: stored CL8 + file [CL9] -> 1 step CL8->CL9",
    r.wouldWrite && r.finalValue === "CL9" && r.steps.length === 1,
    JSON.stringify(r)
  );
}

console.log("\n========== TEST RESULTS ==========");
let failures = 0;
for (const r of results) {
  console.log(`[${r.status}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  if (r.status === "FAIL") failures += 1;
}
console.log(`\n${results.length - failures}/${results.length} passed.`);
if (failures > 0) process.exitCode = 1;
