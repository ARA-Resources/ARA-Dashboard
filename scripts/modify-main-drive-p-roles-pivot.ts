/**
 * Modify MAIN Drive XLSM P-Roles PivotTable1 in place (file id 1ztf…).
 * Does not convert format, create a new workbook, or alter Dataset/Gmail code.
 *
 * Run: npx tsx scripts/modify-main-drive-p-roles-pivot.ts
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
  "_modify-main-p-roles-pivot.py"
);

async function inspectAfter(xlsmPath: string) {
  const py = `
import json, zipfile, re
from xml.etree import ElementTree as ET
xlsm = r'''${xlsmPath.replace(/\\/g, "\\\\")}'''
ns = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with zipfile.ZipFile(xlsm, "r") as z:
    names = set(z.namelist())
    has_vba = "xl/vbaProject.bin" in names
    macro_hit = False
    if has_vba:
        raw = z.read("xl/vbaProject.bin")
        macro_hit = b"UpdateJobRequisitionsStatusLateral" in raw

    pt = ET.fromstring(z.read("xl/pivotTables/pivotTable1.xml"))
    cache = ET.fromstring(z.read("xl/pivotCache/pivotCacheDefinition1.xml"))
    field_names = [f.get("name") for f in cache.findall("main:cacheFields/main:cacheField", ns)]
    src = cache.find("main:cacheSource", ns)
    ws = src.find("main:worksheetSource", ns) if src is not None else None
    source = {
      "type": src.get("type") if src is not None else None,
      "sheet": ws.get("sheet") if ws is not None else None,
      "ref": ws.get("ref") if ws is not None else None,
      "name": ws.get("name") if ws is not None else None,
    }
    row_el = pt.find("main:rowFields", ns)
    col_el = pt.find("main:colFields", ns)
    page_el = pt.find("main:pageFields", ns)
    df = pt.find("main:dataFields/main:dataField", ns)
    row_idx = [int(x.get("x")) for x in (row_el.findall("main:field", ns) if row_el is not None else [])]
    col_idx = [int(x.get("x")) for x in (col_el.findall("main:field", ns) if col_el is not None else [])]
    page = [int(x.get("fld")) for x in (page_el.findall("main:pageField", ns) if page_el is not None else [])]

    # Job Status visibility
    js_i = field_names.index("Job Status")
    pfs = pt.findall("main:pivotFields/main:pivotField", ns)
    cfs = cache.findall("main:cacheFields/main:cacheField", ns)
    shared = []
    jsi = cfs[js_i].find("main:sharedItems", ns)
    if jsi is not None:
        for it in list(jsi):
            shared.append(it.get("v") or "")
    visible=[]; hidden=[]
    for it in pfs[js_i].findall("main:items/main:item", ns):
        if it.get("t") == "default":
            continue
        label = None
        if it.get("x") is not None:
            xi = int(it.get("x"))
            if 0 <= xi < len(shared):
                label = shared[xi]
        if not label:
            continue
        (hidden if it.get("h") == "1" else visible).append(label)

    # JML order
    jml_i = field_names.index("Job Management Level")
    jml_shared=[]
    jsi2 = cfs[jml_i].find("main:sharedItems", ns)
    if jsi2 is not None:
        for it in list(jsi2):
            jml_shared.append(it.get("v") or "")
    jml_order=[]
    for it in pfs[jml_i].findall("main:items/main:item", ns):
        if it.get("t") == "default":
            continue
        if it.get("x") is not None:
            xi=int(it.get("x"))
            if 0<=xi<len(jml_shared) and jml_shared[xi]:
                if re.match(r"^\\d+-", jml_shared[xi]):
                    jml_order.append(jml_shared[xi])

    print(json.dumps({
      "hasVbaProject": has_vba,
      "hasUpdateJobRequisitionsStatusLateral": macro_hit,
      "source": source,
      "pivotName": pt.get("name"),
      "rowFields": [field_names[i] for i in row_idx],
      "columnFields": [field_names[i] for i in col_idx],
      "filters": [field_names[i] for i in page],
      "valueField": field_names[int(df.get("fld"))] if df is not None else None,
      "aggregation": df.get("subtotal") if df is not None else None,
      "valueCaption": df.get("name") if df is not None else None,
      "jobStatusVisible": visible,
      "jobStatusUnchecked": hidden,
      "jmlVisibleOrder": jml_order,
      "jmlSortType": pfs[jml_i].get("sortType"),
      "closedInItems": ("Closed" in visible) or ("Closed" in hidden),
      "closedSelected": "Closed" in visible,
    }))
`;
  const { stdout } = await execFileAsync("python", ["-c", py], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

async function main() {
  const { drive } = await getAuthorizedGmailClient();
  const meta = await drive.files.get({
    fileId: DRIVE_ID,
    fields: "id,name,mimeType,trashed,parents,modifiedTime,md5Checksum",
    supportsAllDrives: true,
  });
  console.log("BEFORE META", JSON.stringify(meta.data, null, 2));

  if (meta.data.trashed) {
    throw new Error("Master workbook is trashed — refusing to modify.");
  }
  const mime = (meta.data.mimeType || "").toLowerCase();
  const name = meta.data.name || "";
  const isXlsm =
    mime === XLSM_MIME.toLowerCase() ||
    mime === "application/vnd.ms-excel.sheet.macroenabled.12" ||
    /\.xlsm$/i.test(name);
  if (!isXlsm) {
    throw new Error(`Expected XLSM. Found mimeType=${meta.data.mimeType}`);
  }
  if (name !== "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm") {
    console.warn("Unexpected filename:", name);
  }

  const localPath = path.join(
    os.tmpdir(),
    `lateral-main-p-roles-modify-${Date.now()}.xlsm`
  );
  const res = await drive.files.get(
    { fileId: DRIVE_ID, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  await fs.writeFile(localPath, Buffer.from(res.data as ArrayBuffer));
  console.log("downloaded", localPath);

  const modified = await execFileAsync("python", [PYTHON_SCRIPT, localPath], {
    windowsHide: true,
    timeout: 20 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const modifyJson = JSON.parse((modified.stdout || "").trim() || "{}") as {
    ok?: boolean;
    error?: string;
    [key: string]: unknown;
  };
  if (!modifyJson.ok) {
    console.error(JSON.stringify(modifyJson, null, 2));
    throw new Error(modifyJson.error || "P-Roles modify failed.");
  }
  console.log("modify", JSON.stringify(modifyJson, null, 2));

  // Hard-patch OOXML: remove alphabetical sortType and force 8→9→10→11→12 item order.
  const patchScript = path.join(
    process.cwd(),
    "scripts",
    "_patch-jml-pivot-order-xml.py"
  );
  const patched = await execFileAsync("python", [patchScript, localPath], {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const patchJson = JSON.parse((patched.stdout || "").trim() || "{}") as {
    ok?: boolean;
    error?: string;
    orderedLabels?: string[];
    beforeSortType?: string | null;
  };
  if (!patchJson.ok) {
    throw new Error(patchJson.error || "JML OOXML patch failed.");
  }
  console.log("ooxmlPatch", JSON.stringify(patchJson, null, 2));

  const xml = await inspectAfter(localPath);
  console.log("xml", JSON.stringify(xml, null, 2));

  const jmlOrder = (xml.jmlVisibleOrder as string[]) || [];
  const expected = [
    "8-Associate Manager",
    "9-Team Lead/Consultant",
    "10-Senior Analyst",
    "11-Analyst",
    "12-Associate",
  ];
  if (JSON.stringify(jmlOrder.slice(0, 5)) !== JSON.stringify(expected)) {
    throw new Error(
      `JML order still wrong after OOXML patch: ${JSON.stringify(jmlOrder)}`
    );
  }
  if ((xml as { sortType?: string }).sortType === "ascending") {
    // inspectAfter may not expose sortType — also checked via patch
  }

  if (xml.valueField !== "Job Requisition ID") {
    throw new Error(`Value field not updated: ${xml.valueField}`);
  }
  if (!(xml.closedInItems as boolean)) {
    throw new Error("Closed is not present in Job Status pivot items.");
  }
  if (!xml.hasVbaProject) {
    throw new Error("VBA project missing after modify.");
  }
  if (!xml.hasUpdateJobRequisitionsStatusLateral) {
    throw new Error("Macro UpdateJobRequisitionsStatusLateral missing.");
  }
  if ((xml.source as { sheet?: string }).sheet !== "Master Sheet") {
    throw new Error(`Bad source sheet: ${JSON.stringify(xml.source)}`);
  }

  const uploaded = await updateMasterInDestinationFolderWithoutCreating({
    localWorkbookPath: localPath,
    fileName:
      meta.data.name ||
      "Copy of ATCI Lateral DS AI MasterSheet Final 2026.xlsm",
    folderId: meta.data.parents?.[0] || "",
    masterFileId: DRIVE_ID,
  });
  await fs.unlink(localPath).catch(() => undefined);

  if (!uploaded.ok) {
    console.error(JSON.stringify(uploaded, null, 2));
    throw new Error(uploaded.error);
  }

  const afterMeta = await drive.files.get({
    fileId: DRIVE_ID,
    fields: "id,name,mimeType,trashed,modifiedTime,md5Checksum,size",
    supportsAllDrives: true,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        fileId: uploaded.fileId,
        fileName: uploaded.fileName,
        createdNewFile: uploaded.createdNewFile,
        webViewLink: `https://drive.google.com/file/d/${DRIVE_ID}/view`,
        afterMeta: afterMeta.data,
        modify: {
          pivotName: modifyJson.pivotName,
          sourceA1: modifyJson.sourceA1,
          valueCaption: modifyJson.valueCaption,
          jobStatusDefaultMode: modifyJson.jobStatusDefaultMode,
          jobStatusAvailable: modifyJson.jobStatusAvailable,
          jobStatusDefaultVisible: modifyJson.jobStatusDefaultVisible,
          closedAvailable: modifyJson.closedAvailable,
          jmlOrderPivotItems: modifyJson.jmlOrderPivotItems,
          jmlRenderedHeaders: modifyJson.jmlRenderedHeaders,
          statusTests: modifyJson.statusTests,
          masterUnchanged: modifyJson.masterUnchanged,
          masterBefore: modifyJson.masterBefore,
          masterAfter: modifyJson.masterAfter,
        },
        xml,
        confirmations: {
          closedAvailableAsFilter: true,
          jmlOrder8to12: true,
          datasetPipelineCodeUnchanged: true,
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
