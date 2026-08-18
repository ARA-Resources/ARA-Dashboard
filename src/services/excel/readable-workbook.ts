import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function cachePathFor(xlsmPath: string) {
  const stem = path.basename(xlsmPath, path.extname(xlsmPath));
  return path.join(
    process.cwd(),
    ".data",
    "excel-cache",
    `${stem}.readable.xlsx`
  );
}

/**
 * ExcelJS cannot reliably open macro-enabled .xlsm workbooks.
 * Convert (or reuse a mtime-matched cache) to a plain .xlsx for reading.
 */
export async function resolveReadableExcelPath(
  filePath: string
): Promise<string> {
  if (!/\.xlsm$/i.test(filePath)) return filePath;

  const cachePath = cachePathFor(filePath);
  const srcStat = await fs.stat(filePath);
  try {
    const cacheStat = await fs.stat(cachePath);
    if (cacheStat.mtimeMs >= srcStat.mtimeMs && cacheStat.size > 0) {
      return cachePath;
    }
  } catch {
    // rebuild below
  }

  await fs.mkdir(path.dirname(cachePath), { recursive: true });

  const script = `
from openpyxl import load_workbook, Workbook
import sys
src, dest = sys.argv[1], sys.argv[2]
wb = load_workbook(src, read_only=True, data_only=True)
out = Workbook()
out.remove(out.active)
# Prefer dashboard sheets first, then the rest
preferred = ["P-Roles", "Master Sheet", "New Sheet", "Posted Sheet", "Allocation Sheet"]
names = [n for n in preferred if n in wb.sheetnames] + [
    n for n in wb.sheetnames if n not in preferred
]
for name in names:
    ws = wb[name]
    nws = out.create_sheet(title=name[:31])
    for row in ws.iter_rows(values_only=True):
        nws.append(list(row))
wb.close()
out.save(dest)
print(dest)
`;

  const result = await execFileAsync(
    "python",
    ["-c", script, filePath, cachePath],
    {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    }
  );

  if (result.stderr?.toString().trim()) {
    // openpyxl warnings are ok; only fail if cache missing
  }
  await fs.access(cachePath);
  return cachePath;
}
