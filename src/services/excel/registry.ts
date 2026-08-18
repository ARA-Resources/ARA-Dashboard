import {
  BUSINESS_UNITS,
  getBusinessUnitById,
  getBusinessUnitBySlug,
} from "@/constants/business-units";
import { ensureCurrentDataset } from "@/services/dataset/seed-current";
import type { CurrentDatasetFile } from "@/services/dataset/resolve-current";
import type { BusinessUnitId, ExcelSourceConfig } from "@/types/business-unit";

/**
 * Sheet/layout config for a business unit (NOT a file path).
 * File bytes always come from Dataset Manager.
 */
export function getExcelSource(businessUnitId: BusinessUnitId) {
  const unit = getBusinessUnitById(businessUnitId);
  if (!unit) {
    throw new Error(`Unknown business unit: ${businessUnitId}`);
  }
  return unit.excel;
}

/**
 * Company / dashboard Excel resolution.
 * NEVER reads Dropbox or data/excel directly — only Dataset Manager current.
 *
 * Architecture:
 * Gmail → Download → Validate → Drive → Dataset Manager → Cache → Company Dashboard
 */
export async function resolveExcelFilePath(
  businessUnitId: BusinessUnitId
): Promise<string> {
  const current = await resolveDatasetExcel(businessUnitId);
  return current.filePath;
}

export async function resolveDatasetExcel(
  businessUnitId: BusinessUnitId
): Promise<CurrentDatasetFile> {
  return ensureCurrentDataset(businessUnitId);
}

/** @deprecated Display/layout only — do not use for file I/O */
export function getBundledExcelPath(source: ExcelSourceConfig) {
  return source.relativePath;
}

export function listExcelSources() {
  return BUSINESS_UNITS.map((unit) => ({
    businessUnitId: unit.id,
    ...unit.excel,
  }));
}

export { getBusinessUnitById, getBusinessUnitBySlug };
