# Phase 11 P-Roles Audit

## Scope
- Audit target: current P-Roles implementation and dependencies before native migration.
- Constraints followed: read-only audit, no production syncs, no production workbook mutation, no Excel COM execution.

## Findings

### 1) Where Master Sheet data is read
- `src/services/excel/read-lateral-master-from-drive-xlsm.ts` reads `Master Sheet` from Google Drive XLSM (header row 1) into JSON rows.
- `src/services/excel/reader.ts` routes Lateral `Master Sheet` reads to that service when `businessUnitId === "lateral"`.
- `src/services/excel/read-lateral-p-roles-from-workbook.ts` also reads `Master Sheet` from the local reference workbook for legacy/reference flows.

### 2) Where P-Roles aggregation is currently performed
- Dashboard path: `src/services/excel/aggregate-openings.ts` groups rows by `Primary Skills` and `Skill Categorization`, columns by dynamic JML labels, and computes `Grand Total`.
- Google Sheets pivot path: `src/services/lateral-processing/lateral-p-roles-sheets-pivot.ts` builds/refreshes a Google Sheets PivotTable from `Master Sheet`.
- Google-compatible XLSM display path: `src/services/lateral-processing/lateral-google-p-roles-native.ts` generates formula-based counts in a P-Roles sheet.

### 3) Where filters are applied
- Dashboard path: `src/services/excel/apply-filters.ts` applies column filters (AND across columns, OR within column) before aggregation.
- Lateral defaults: `src/constants/default-filters.ts` derives default `Job Status` behavior aligned with P-Roles expectations.
- Google pivot path: `src/services/lateral-processing/lateral-p-roles-sheets-pivot.ts` applies PivotTable filter specs for `Job Status`, `Posted`, and `Market Map`.

### 4) Where JML ordering is applied
- Dashboard path: `src/services/excel/aggregate-openings.ts` sorts JML labels by leading numeric prefix (8,9,10,11,12...).
- Google pivot path: `src/services/lateral-processing/lateral-p-roles-sheets-pivot.ts` has numeric-prefix JML sort logic and canonical ordering guards.
- Native Google formula path: `src/services/lateral-processing/lateral-google-p-roles-native.ts` defines `JML_ORDER` constant with canonical 8→12 ordering.

### 5) Where Excel COM is called
- `src/services/lateral-processing/lateral-p-roles-pivot-refresh.ts` executes Python with `win32com` for PivotTable refresh.
- `scripts/_refresh-p-roles-pivot.py` directly uses `pythoncom` and `win32com.client` to refresh Excel PivotTable.
- `src/services/lateral-processing/run-vba-macro.ts` executes Windows Excel COM via Python for VBA macro invocation.

### 6) API/UI components consuming P-Roles data
- API data path used by dashboard: `src/app/api/excel/[businessUnitId]/route.ts` for `lateral`, with data produced by `readTopOpenings()` (Master Sheet + aggregation).
- UI path: `src/components/dashboard/accenture/accenture-dashboard.tsx` and `src/components/dashboard/accenture/openings-data-table.tsx`.
- Client hook: `src/hooks/use-business-unit-openings.ts` fetches Lateral openings (currently P-Roles-style output).

### 7) P-Roles state in `.data`
- `.data/lateral-p-roles-google-sheet.json` is used in:
  - `src/services/lateral-processing/lateral-p-roles-sheets-pivot.ts`
  - `src/services/excel/read-lateral-p-roles-from-google.ts`
- `.data/lateral-native-p-roles-google-sheet.json` is used in:
  - `src/services/lateral-processing/lateral-google-p-roles-native.ts`
- Existing state files indicate prior Google-sheet-based P-Roles orchestration, not a pure stateless web-native aggregation contract.

### 8) Existing Google Sheets compatible P-Roles functionality
- Yes, partially:
  - `src/services/lateral-processing/lateral-p-roles-sheets-pivot.ts` creates/refreshes a Google Sheets native pivot host.
  - `src/services/lateral-processing/lateral-google-compatible-p-roles.ts` + `lateral-google-p-roles-native.ts` produce Google-compatible display/formula outputs.
- However, current web dashboard path is not explicitly exposed as a dedicated protected `/api/dataset/lateral/p-roles` contract with feature-flagged engine selection.

## Audit conclusion
- P-Roles logic already exists in multiple forms (dashboard aggregation, Google pivot, Excel COM refresh), but responsibilities are split and not isolated behind a single engine interface.
- A dedicated web-native engine can be introduced cleanly using existing Master Sheet reader infrastructure, while keeping Excel/COM implementation intact behind a feature flag boundary.
