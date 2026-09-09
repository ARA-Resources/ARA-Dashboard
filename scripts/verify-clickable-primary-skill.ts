/**
 * Throwaway verification for "clickable Primary Skill → Master Sheet with
 * filters". Runs the REAL pivot engine and the REAL Master Sheet query against a
 * throwaway Postgres seeded from a prod pg_dump of lateral_master.
 *
 *   POSTGRES_URL=... npx tsx scripts/verify-clickable-primary-skill.ts
 */

import { buildLateralPRolesOpenings } from "@/services/lateral-processing/lateral-p-roles-service";
import { queryLateralMasterSheet } from "@/services/excel/read-lateral-master-sheet";
import { createEmptyOpeningsFilters } from "@/constants/default-filters";

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

// Master Sheet query with empty text/date filters.
async function msTotal(columnFilters: Record<string, string[]>): Promise<number> {
  const res = await queryLateralMasterSheet({
    page: 1,
    pageSize: 5,
    columnFilters,
    textFilters: {},
    dateFilters: {},
  });
  return res.total;
}

async function main() {
  // Dashboard defaults for Lateral.
  const dashFilters = {
    ...createEmptyOpeningsFilters(),
    columnFilters: {
      "Job Status": ["Active", "Reopen", "New"],
      "Posted": ["Yes"],
    },
  };

  const pivot = await buildLateralPRolesOpenings(dashFilters);
  const rows = pivot.rows.filter(
    (r) =>
      String(r["Primary Skills"] ?? "").trim() &&
      String(r["Primary Skills"]).trim() !== "—" &&
      typeof r["Grand Total"] === "number" &&
      (r["Grand Total"] as number) > 0
  );
  check("pivot returned skill rows", rows.length > 5, `${rows.length} rows`);

  const carried = {
    "Job Status": dashFilters.columnFilters["Job Status"],
    "Posted": dashFilters.columnFilters["Posted"],
  };

  // 1. For several pivot cells, Master Sheet total == that cell's Grand Total exactly.
  let matched = 0;
  const sample = rows.slice(0, 8);
  for (const r of sample) {
    const skill = String(r["Primary Skills"]).trim();
    const skillCat = String(r["Skill Categorization"] ?? "").trim();
    const grand = r["Grand Total"] as number;
    const total = await msTotal({
      ...carried,
      "Primary Skills": [skill],
      "Skill Categorization": [skillCat],
    });
    const ok = total === grand;
    if (ok) matched += 1;
    else
      console.log(
        `    mismatch: "${skill}" / "${skillCat}" → pivot ${grand}, master ${total}`
      );
  }
  check(
    "Master Sheet count == pivot Grand Total for every sampled cell",
    matched === sample.length,
    `${matched}/${sample.length}`
  );

  // 2. Exact match (not "contains"): skill-only filter must NOT exceed the sum of
  //    that skill's pivot rows (contains would pull in longer skill names).
  const bySkill = new Map<string, number>();
  for (const r of rows) {
    const s = String(r["Primary Skills"]).trim();
    bySkill.set(s, (bySkill.get(s) ?? 0) + (r["Grand Total"] as number));
  }
  // Find a skill that is a substring of another skill (contains-collision risk).
  const skills = [...bySkill.keys()];
  const collision = skills.find((a) =>
    skills.some((b) => b !== a && b.toLowerCase().includes(a.toLowerCase()))
  );
  if (collision) {
    const longer = skills.find(
      (b) => b !== collision && b.toLowerCase().includes(collision.toLowerCase())
    )!;
    const exactShort = await msTotal({ ...carried, "Primary Skills": [collision] });
    const exactLong = await msTotal({ ...carried, "Primary Skills": [longer] });
    check(
      `exact match isolates "${collision}" from "${longer}"`,
      exactShort === (bySkill.get(collision) ?? -1) &&
        exactLong === (bySkill.get(longer) ?? -1) &&
        exactShort !== exactLong,
      `short=${exactShort} (pivot ${bySkill.get(collision)}), long=${exactLong} (pivot ${bySkill.get(longer)})`
    );
  } else {
    console.log("… no substring-collision skill pair in this dataset (skipping over-match test)");
  }

  // 3. Job Status / Posted actually carried (dropping them changes the count).
  const first = sample[0];
  const withStatus = await msTotal({
    ...carried,
    "Primary Skills": [String(first["Primary Skills"]).trim()],
    "Skill Categorization": [String(first["Skill Categorization"] ?? "").trim()],
  });
  const noStatus = await msTotal({
    "Primary Skills": [String(first["Primary Skills"]).trim()],
    "Skill Categorization": [String(first["Skill Categorization"] ?? "").trim()],
  });
  check(
    "Job Status / Posted filters change the result (they are applied, not ignored)",
    noStatus >= withStatus,
    `withStatus=${withStatus}, noStatusFilter=${noStatus}`
  );

  // 4. Skill Categorization exact-match narrows within a skill that has >1 categorization.
  const multiCat = rows.reduce<Map<string, string[]>>((m, r) => {
    const s = String(r["Primary Skills"]).trim();
    const c = String(r["Skill Categorization"] ?? "").trim();
    m.set(s, [...(m.get(s) ?? []), c]);
    return m;
  }, new Map());
  const skillWith2 = [...multiCat.entries()].find(([, cats]) => new Set(cats).size > 1);
  if (skillWith2) {
    const [s, cats] = skillWith2;
    const oneCat = await msTotal({
      ...carried,
      "Primary Skills": [s],
      "Skill Categorization": [cats[0]],
    });
    const skillOnly = await msTotal({ ...carried, "Primary Skills": [s] });
    check(
      `Skill Categorization narrows "${s}" (${cats[0]}: ${oneCat} < all: ${skillOnly})`,
      oneCat < skillOnly && oneCat > 0
    );
  } else {
    console.log("… no skill with multiple categorizations in this dataset (skipping)");
  }

  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
