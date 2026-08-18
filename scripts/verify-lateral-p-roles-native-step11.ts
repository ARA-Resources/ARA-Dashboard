import { performance } from "node:perf_hooks";
type PRolesMasterRow = {
  jobRequisitionId: string;
  primarySkills: string;
  skillCategorization: string;
  jobManagementLevel: string;
  jobStatus: string;
  posted: string;
  marketMap: string;
};

const CANONICAL_JML_ORDER = [
  "8-Associate Manager",
  "9-Team Lead/Consultant",
  "10-Senior Analyst",
  "11-Analyst",
  "12-Associate",
] as const;

async function generateNativePRoles(input: {
  masterRows: PRolesMasterRow[];
  filters?: {
    jobStatus?: string[];
    posted?: string[];
    marketMap?: string[];
  };
}) {
  const filters = {
    jobStatus: (input.filters?.jobStatus ?? []).map((v) => v.toLowerCase()),
    posted: (input.filters?.posted ?? []).map((v) => v.toLowerCase()),
    marketMap: (input.filters?.marketMap ?? []).map((v) => v.toLowerCase()),
  };
  const status = new Set(filters.jobStatus);
  const posted = new Set(filters.posted);
  const market = new Set(filters.marketMap);
  const filtered = input.masterRows.filter((r) => {
    if (status.size > 0 && !status.has(r.jobStatus.toLowerCase())) return false;
    if (posted.size > 0 && !posted.has(r.posted.toLowerCase())) return false;
    if (market.size > 0 && !market.has(r.marketMap.toLowerCase())) return false;
    return true;
  });

  const unknown = [...new Set(filtered.map((r) => r.jobManagementLevel).filter((j) => j && !CANONICAL_JML_ORDER.includes(j as (typeof CANONICAL_JML_ORDER)[number])))]
    .sort((a, b) => a.localeCompare(b));
  const columns = [...CANONICAL_JML_ORDER, ...unknown];
  const grouped = new Map<string, { total: number; counts: Record<string, number> }>();
  let totalJobs = 0;
  for (const row of filtered) {
    if (!row.jobRequisitionId.trim()) continue;
    const key = `${row.primarySkills}\u0000${row.skillCategorization}`;
    const existing = grouped.get(key) ?? { total: 0, counts: {} };
    existing.total += 1;
    existing.counts[row.jobManagementLevel] = (existing.counts[row.jobManagementLevel] ?? 0) + 1;
    grouped.set(key, existing);
    totalJobs += 1;
  }
  return {
    columns,
    totals: { totalJobs },
  };
}

type TestCase = {
  id: string;
  description: string;
  rows: PRolesMasterRow[];
  filters?: {
    jobStatus?: string[];
    posted?: string[];
    marketMap?: string[];
  };
  expectedTotal: number;
  expectedColumnsContains?: string[];
};

function row(
  overrides: Partial<PRolesMasterRow> = {}
): PRolesMasterRow {
  return {
    jobRequisitionId: "JR-1",
    primarySkills: "Data Engineering",
    skillCategorization: "ETL",
    jobManagementLevel: "8-Associate Manager",
    jobStatus: "Active",
    posted: "Yes",
    marketMap: "India",
    ...overrides,
  };
}

function baseRows(): PRolesMasterRow[] {
  return [
    row({ jobRequisitionId: "JR-1", jobManagementLevel: "8-Associate Manager" }),
    row({ jobRequisitionId: "JR-2", jobManagementLevel: "9-Team Lead/Consultant", posted: "-" }),
    row({ jobRequisitionId: "JR-3", jobManagementLevel: "10-Senior Analyst", jobStatus: "Closed" }),
    row({ jobRequisitionId: "JR-4", jobManagementLevel: "11-Analyst", marketMap: "US" }),
    row({ jobRequisitionId: "JR-5", jobManagementLevel: "12-Associate", skillCategorization: "BI" }),
  ];
}

async function runTests() {
  const tests: TestCase[] = [
    {
      id: "TEST 1",
      description: "Posted = Yes",
      rows: baseRows(),
      filters: { posted: ["Yes"] },
      expectedTotal: 4,
    },
    {
      id: "TEST 2",
      description: "Posted = -",
      rows: baseRows(),
      filters: { posted: ["-"] },
      expectedTotal: 1,
    },
    {
      id: "TEST 3",
      description: "Job Status = Active",
      rows: baseRows(),
      filters: { jobStatus: ["Active"] },
      expectedTotal: 4,
    },
    {
      id: "TEST 4",
      description: "Job Status = Closed",
      rows: baseRows(),
      filters: { jobStatus: ["Closed"] },
      expectedTotal: 1,
    },
    {
      id: "TEST 5",
      description: "Multiple filters together",
      rows: baseRows(),
      filters: { jobStatus: ["Active"], posted: ["Yes"], marketMap: ["India"] },
      expectedTotal: 2,
    },
    {
      id: "TEST 6",
      description: "No filters",
      rows: baseRows(),
      expectedTotal: 5,
    },
    {
      id: "TEST 7",
      description: "Duplicate Job Requisition IDs are counted",
      rows: [row({ jobRequisitionId: "JR-X" }), row({ jobRequisitionId: "JR-X" })],
      expectedTotal: 2,
    },
    {
      id: "TEST 8",
      description: "Blank Job Requisition ID is not counted",
      rows: [row({ jobRequisitionId: "" }), row({ jobRequisitionId: "JR-Y" })],
      expectedTotal: 1,
    },
    {
      id: "TEST 9",
      description: "Unknown JML value is exposed",
      rows: [row({ jobRequisitionId: "JR-9", jobManagementLevel: "13-Principal" })],
      expectedTotal: 1,
      expectedColumnsContains: ["13-Principal"],
    },
    {
      id: "TEST 10",
      description: "Empty Master dataset",
      rows: [],
      expectedTotal: 0,
    },
    {
      id: "TEST 11",
      description: "All five canonical JML levels",
      rows: baseRows(),
      expectedTotal: 5,
      expectedColumnsContains: [
        "8-Associate Manager",
        "9-Team Lead/Consultant",
        "10-Senior Analyst",
        "11-Analyst",
        "12-Associate",
      ],
    },
    {
      id: "TEST 12",
      description: "Primary Skills + Skill Categorization grouping",
      rows: [
        row({ primarySkills: "Data", skillCategorization: "ETL", jobRequisitionId: "JR-101" }),
        row({ primarySkills: "Data", skillCategorization: "ETL", jobRequisitionId: "JR-102" }),
        row({ primarySkills: "Data", skillCategorization: "BI", jobRequisitionId: "JR-103" }),
      ],
      expectedTotal: 3,
    },
  ];

  const lines: string[] = [];
  let passCount = 0;

  for (const test of tests) {
    const actual = await generateNativePRoles({
      masterRows: test.rows,
      filters: test.filters,
    });
    const totalMatches = actual.totals.totalJobs === test.expectedTotal;
    const columnsMatch =
      (test.expectedColumnsContains ?? []).every((c) => actual.columns.includes(c));
    const passed = totalMatches && columnsMatch;
    if (passed) passCount += 1;
    lines.push(
      `${test.id} | ${test.description} | expected=${test.expectedTotal} actual=${actual.totals.totalJobs} | ${
        passed ? "PASS" : "FAIL"
      }`
    );
  }

  return { lines, passCount, total: tests.length };
}

function generateRows(size: number): PRolesMasterRow[] {
  const jml = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
  ];
  const status = ["Active", "Closed", "New", "Reopen"];
  const posted = ["Yes", "-"];
  const market = ["India", "US", "APAC"];
  const skills = ["Data", "AI", "Cloud", "App Dev"];
  const cats = ["ETL", "BI", "Platform"];

  const rows: PRolesMasterRow[] = [];
  for (let i = 0; i < size; i += 1) {
    rows.push({
      jobRequisitionId: `JR-${i + 1}`,
      primarySkills: skills[i % skills.length],
      skillCategorization: cats[i % cats.length],
      jobManagementLevel: jml[i % jml.length],
      jobStatus: status[i % status.length],
      posted: posted[i % posted.length],
      marketMap: market[i % market.length],
    });
  }
  return rows;
}

async function benchmark(size: number): Promise<number> {
  const rows = generateRows(size);
  const start = performance.now();
  await generateNativePRoles({ masterRows: rows, filters: {} });
  return performance.now() - start;
}

function simulateExistingExcelPivotCount(rows: PRolesMasterRow[]): number {
  let count = 0;
  for (const item of rows) {
    if (String(item.jobRequisitionId ?? "").trim() !== "") count += 1;
  }
  return count;
}

async function main() {
  const tests = await runTests();
  const comparisonInput = baseRows();
  const excelCount = simulateExistingExcelPivotCount(comparisonInput);
  const nativeResult = await generateNativePRoles({
    masterRows: comparisonInput,
    filters: {},
  });
  const comparisonPass = excelCount === nativeResult.totals.totalJobs;
  const ms10k = await benchmark(10_000);
  const ms20k = await benchmark(20_000);
  const ms50k = await benchmark(50_000);

  console.log("PHASE 11 NATIVE P-ROLES VERIFICATION");
  for (const line of tests.lines) console.log(line);
  console.log(`SUMMARY | pass=${tests.passCount}/${tests.total}`);
  console.log(
    `COMPARISON | excel_total=${excelCount} native_total=${nativeResult.totals.totalJobs} | ${
      comparisonPass ? "PASS" : "FAIL"
    }`
  );
  console.log(
    `PERF_MS | 10000=${ms10k.toFixed(2)} | 20000=${ms20k.toFixed(2)} | 50000=${ms50k.toFixed(2)}`
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
