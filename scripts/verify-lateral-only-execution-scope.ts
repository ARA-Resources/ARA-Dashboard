/**
 * Verify Lateral-only execution scope.
 * Run: npx tsx scripts/verify-lateral-only-execution-scope.ts
 */
import {
  EXECUTABLE_DATASET_TYPES,
  FUTURE_DATASET_TYPES,
  LATERAL_ONLY_EXECUTION_MESSAGE,
  assertExecutableDatasetType,
  filterExecutableDatasetNames,
  isExecutableDatasetType,
  isFutureDatasetType,
  resolveExecutableDatasetNamesForRun,
} from "../src/types/dataset-execution";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

assert(
  EXECUTABLE_DATASET_TYPES.length === 1 &&
    EXECUTABLE_DATASET_TYPES[0] === "Lateral",
  "only Lateral executable"
);
assert(
  FUTURE_DATASET_TYPES.includes("Executive") &&
    FUTURE_DATASET_TYPES.includes("Consulting"),
  "future types retained"
);
assert(isExecutableDatasetType("Lateral"), "Lateral executable");
assert(!isExecutableDatasetType("Executive"), "Executive not executable");
assert(isFutureDatasetType("Consulting"), "Consulting is future");

assert(
  filterExecutableDatasetNames(["Lateral", "Executive", "Consulting"]).join() ===
    "Lateral",
  "filter drops future"
);
assert(
  filterExecutableDatasetNames(["Executive"]).length === 0,
  "filter empty for future-only"
);

const resolved = resolveExecutableDatasetNamesForRun([
  "Lateral",
  "Executive",
]);
assert(resolved.executable.join() === "Lateral", "resolve keeps Lateral");
assert(resolved.skippedFuture.join() === "Executive", "resolve skips Exec");

let threw = false;
try {
  resolveExecutableDatasetNamesForRun(["Executive", "Consulting"]);
} catch (err) {
  threw = err instanceof Error && err.message.includes("Only Lateral");
}
assert(threw, "future-only resolve throws");

threw = false;
try {
  assertExecutableDatasetType("Consulting");
} catch (err) {
  threw =
    err instanceof Error &&
    err.message.includes(LATERAL_ONLY_EXECUTION_MESSAGE.slice(0, 20));
}
assert(threw, "assert blocks Consulting");

assertExecutableDatasetType("Lateral");

console.log("verify-lateral-only-execution-scope: OK");
console.log(
  JSON.stringify(
    {
      executable: EXECUTABLE_DATASET_TYPES,
      future: FUTURE_DATASET_TYPES,
      sharedArchitecture: [
        "Common Gmail Connection",
        "Common Google Drive Connection",
        "Independent schedule (later)",
        "Independent keywords (later)",
        "Independent checkpoint (later)",
        "Independent Drive folder (later)",
        "Independent Master Workbook (later)",
        "Independent processing logic (later)",
      ],
      currentRule: "Only Lateral executes",
    },
    null,
    2
  )
);
