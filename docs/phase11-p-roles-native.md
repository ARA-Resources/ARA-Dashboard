# Phase 11 Native P-Roles

## 1) Current Excel implementation
- Windows/Excel COM refresh remains in place:
  - `src/services/lateral-processing/lateral-p-roles-pivot-refresh.ts`
  - `scripts/_refresh-p-roles-pivot.py`
  - `src/services/lateral-processing/run-vba-macro.ts`
- This path is retained and not deleted.

## 2) New native implementation
- Engine abstraction introduced:
  - `src/services/lateral-processing/lateral-p-roles-engine.ts`
  - `PRolesEngine` with `excel` and `native` implementations.
- Native engine:
  - `src/services/lateral-processing/lateral-p-roles-native.ts`
  - deterministic JSON aggregation, no Excel/Python/COM dependencies.
- Default-preserving excel adapter:
  - `src/services/lateral-processing/lateral-p-roles-excel.ts`

## 3) Data source
- Master data is read through existing service:
  - `src/services/excel/read-lateral-master-from-drive-xlsm.ts`
- Mapping is strict to required columns:
  - Job Requisition ID, Primary Skills, Skill Categorization, Job Management Level, Job Status, Posted, Market Map.

## 4) Aggregation logic
- Grouping:
  - `Primary Skills` → `Skill Categorization` → `Job Management Level`.
- Value:
  - `COUNT(Job Requisition ID)` only.
- Duplicates:
  - counted (Excel-like count behavior).
- Blank Job Requisition ID:
  - excluded from counts.

## 5) Filters
- Applied before aggregation.
- Supported filters:
  - Job Status
  - Posted
  - Market Map
- Supports:
  - all values (empty selection)
  - selected values
  - multiple selected values

## 6) JML ordering
- Canonical order enforced:
  - 8-Associate Manager
  - 9-Team Lead/Consultant
  - 10-Senior Analyst
  - 11-Analyst
  - 12-Associate
- Unknown JML values:
  - appended after canonical order and returned in metadata.

## 7) COUNT(Job Requisition ID)
- Explicitly implemented as non-empty `jobRequisitionId` count.
- Not `COUNT(*)` and not generic `COUNTA` of row fields.

## 8) Column M behavior
- `Posted` is read from Master `Posted` column mapping.
- Native path does not derive Posted from Posted Sheet; it uses mapped Master field.

## 9) Feature flag
- `ARA_P_ROLES_ENGINE`:
  - `excel` (default)
  - `native`
- Resolver:
  - `resolvePRolesEngineKind()` in `lateral-p-roles-engine.ts`.

## 10) Validation
- Script:
  - `scripts/verify-lateral-p-roles-native-step11.ts`
- Includes:
  - 12 required tests
  - PASS/FAIL output
  - comparison summary
  - performance runs

## 11) Performance
- Measured with verification script for 10k/20k/50k synthetic rows.
- Uses one filter pass + one aggregation pass + deterministic sort.

## 12) Vercel compatibility
- Native path does not import:
  - `win32com`
  - `pywin32`
  - `child_process`
  - Excel COM APIs
- Native aggregation result is JSON-serializable and in-memory.

## 13) Remaining Windows dependencies
- Remaining by design in excel path:
  - COM-based refresh + VBA runtime for legacy workflow.
- Not removed in Phase 11.
