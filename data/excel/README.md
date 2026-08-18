# Excel master data sources for ARA Dashboard

| Business unit | Source | Primary sheet |
|---------------|--------|---------------|
| Lateral | Google Drive XLSM (`ARA_LATERAL_MASTER_DRIVE_FILE_ID`) plus optional local workbook (`ARA_LATERAL_EXCEL_PATH` or bundled `lateral-mastersheet.xlsm`) | `P-Roles` |
| Executive | `executive-mastersheet.xlsm` | `P - Dashboard` |
| Consulting | `consulting-demand.xlsx` | `Sheet1` |

**Lateral local workbook:** set `ARA_LATERAL_EXCEL_PATH` in `.env.local` for this machine. Production must not depend on a personal Windows/Dropbox path in source. If the env path is unset, the app uses `data/excel/lateral-mastersheet.xlsm` when present.

For Executive / Consulting, replace the file under `data/excel` (same stable filename). Do not rename keys in `src/constants/business-units.ts` unless intentionally remapping.

The API reads these via ExcelJS. File mtime busts the in-memory cache automatically.
