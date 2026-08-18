/**
 * Rebuild Drive XLSM P-Roles PivotTable to match the Excel reference layout.
 * Updates file 1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9 in place — never creates a new Master.
 *
 * Run: npx tsx scripts/rebuild-drive-p-roles-from-excel.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAuthorizedGmailClient } from "../src/services/gmail/oauth";
import { updateMasterInDestinationFolderWithoutCreating } from "../src/services/lateral-processing/lateral-master-drive-update";
import { XLSM_MIME } from "../src/services/lateral-processing/lateral-final-master-save";

const execFileAsync = promisify(execFile);

const DRIVE_ID = "1ztfWeVhDyzYOHlvA8ujzvtSapRDvvPw9";
const PYTHON_SCRIPT = path.join(
  process.cwd(),
  "scripts",
  "_rebuild-p-roles-pivot.py"
);

async function inspectPivotXml(xlsmPath: string) {
  const py = `
import json, zipfile
from xml.etree import ElementTree as ET
xlsm = r'''${xlsmPath.replace(/\\/g, "\\\\")}'''
ns = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with zipfile.ZipFile(xlsm, "r") as z:
    pt = ET.fromstring(z.read("xl/pivotTables/pivotTable1.xml"))
    cache = ET.fromstring(z.read("xl/pivotCache/pivotCacheDefinition1.xml"))
    names = [f.get("name") for f in cache.findall("main:cacheFields/main:cacheField", ns)]
    def field_names(idxs):
        return [names[i] for i in idxs if 0 <= i < len(names)]
    row_el = pt.find("main:rowFields", ns)
    col_el = pt.find("main:colFields", ns)
    page_el = pt.find("main:pageFields", ns)
    df = pt.find("main:dataFields/main:dataField", ns)
    row_idx = [int(x.get("x")) for x in (row_el.findall("main:field", ns) if row_el is not None else [])]
    col_idx = [int(x.get("x")) for x in (col_el.findall("main:field", ns) if col_el is not None else [])]
    page = [int(x.get("fld")) for x in (page_el.findall("main:pageField", ns) if page_el is not None else [])]
    loc = pt.find("main:location", ns)
    hidden = {}
    pfs = pt.findall("main:pivotFields/main:pivotField", ns)
    caches = cache.findall("main:cacheFields/main:cacheField", ns)
    for i, pf in enumerate(pfs):
        shared = caches[i].find("main:sharedItems", ns) if i < len(caches) else None
        vals = []
        if shared is not None:
            for it in list(shared):
                vals.append(it.get("v") or "")
        hidden_vals = []
        for it in pf.findall("main:items/main:item", ns):
            if it.get("h") == "1" and it.get("x") is not None:
                xi = int(it.get("x"))
                if 0 <= xi < len(vals):
                    hidden_vals.append(vals[xi])
        if hidden_vals:
            hidden[names[i] if i < len(names) else str(i)] = hidden_vals
    print(json.dumps({
      "location": loc.attrib if loc is not None else {},
      "rowFields": field_names(row_idx),
      "columnFields": field_names(col_idx),
      "filters": field_names(page),
      "valueField": names[int(df.get("fld"))] if df is not None else None,
      "aggregation": df.get("subtotal") if df is not None else None,
      "valueCaption": df.get("name") if df is not None else None,
      "compact": pt.get("compact"),
      "hiddenItems": hidden,
    }))
`;
  const { stdout } = await execFileAsync("python", ["-c", py], {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

async function main() {
  const { drive } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId: DRIVE_ID,
    fields: "id,name,mimeType,trashed,parents,modifiedTime",
    supportsAllDrives: true,
  });
  if (meta.data.trashed) {
    await drive.files.update({
      fileId: DRIVE_ID,
      requestBody: { trashed: false },
      supportsAllDrives: true,
    });
  }
  const mime = (meta.data.mimeType || "").toLowerCase();
  const name = meta.data.name || "";
  const isXlsm =
    mime === XLSM_MIME.toLowerCase() ||
    mime === "application/vnd.ms-excel.sheet.macroenabled.12" ||
    /\.xlsm$/i.test(name);
  if (!isXlsm) {
    throw new Error(
      `Expected XLSM Master. Found mimeType=${meta.data.mimeType}`
    );
  }

  const localPath = path.join(
    os.tmpdir(),
    `lateral-p-roles-rebuild-${Date.now()}.xlsm`
  );
  const res = await drive.files.get(
    { fileId: DRIVE_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(localPath, Buffer.from(res.data as ArrayBuffer));
  console.log("downloaded", meta.data.name, localPath);

  const rebuilt = await execFileAsync("python", [PYTHON_SCRIPT, localPath], {
    windowsHide: true,
    timeout: 12 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const rebuildJson = JSON.parse(
    (rebuilt.stdout || "").trim() || "{}"
  ) as {
    ok?: boolean;
    error?: string;
    [key: string]: unknown;
  };
  if (!rebuildJson.ok) {
    console.error(JSON.stringify(rebuildJson, null, 2));
    throw new Error(rebuildJson.error || "P-Roles rebuild failed.");
  }
  console.log("rebuild", JSON.stringify(rebuildJson, null, 2));

  const after = await inspectPivotXml(localPath);
  console.log("xml", JSON.stringify(after, null, 2));

  const expectedRows = ["Primary Skills", "Skill Categorization"];
  const expectedCols = ["Job Management Level"];
  const expectedFilters = ["Job Status", "Posted", "Market Map"];
  const rows = after.rowFields as string[];
  const cols = after.columnFields as string[];
  const filters = after.filters as string[];
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) {
    throw new Error(`Row fields mismatch: ${JSON.stringify(rows)}`);
  }
  if (JSON.stringify(cols) !== JSON.stringify(expectedCols)) {
    throw new Error(`Column fields mismatch: ${JSON.stringify(cols)}`);
  }
  if (JSON.stringify(filters) !== JSON.stringify(expectedFilters)) {
    throw new Error(`Filters mismatch: ${JSON.stringify(filters)}`);
  }
  if (after.aggregation !== "count") {
    throw new Error(`Aggregation mismatch: ${after.aggregation}`);
  }

  const folderId = meta.data.parents?.[0] || "";
  const uploaded = await updateMasterInDestinationFolderWithoutCreating({
    localWorkbookPath: localPath,
    fileName: meta.data.name || "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
    folderId,
    masterFileId: DRIVE_ID,
  });
  await fs.unlink(localPath).catch(() => undefined);
  if (!uploaded.ok) {
    throw new Error(uploaded.error);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        fileId: uploaded.fileId,
        fileName: uploaded.fileName,
        webViewLink: `https://drive.google.com/file/d/${DRIVE_ID}/view`,
        createdNewFile: uploaded.createdNewFile,
        pivot: after,
        rebuild: {
          hiddenClosed: rebuildJson.hiddenClosed,
          visibleJobStatus: rebuildJson.visibleJobStatus,
          jmlOrder: rebuildJson.jmlOrder,
          pivotLocation: rebuildJson.pivotLocation,
        },
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
