import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { repoDataDir } from "../../config/repo-root.js";

const execFileAsync = promisify(execFile);

function cachePathFor(xlsmPath: string) {
  const stem = path.basename(xlsmPath, path.extname(xlsmPath));
  const isServerlessRuntime =
    Boolean(process.env.VERCEL) ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    process.cwd().startsWith("/var/task");
  const cacheRoot = isServerlessRuntime
    ? path.join(os.tmpdir(), "ara-dashboard", "excel-cache")
    : path.join(repoDataDir(), "excel-cache");
  return path.join(cacheRoot, `${stem}.readable.xlsx`);
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

  await execFileAsync("python", ["-c", script, filePath, cachePath], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
  });

  await fs.access(cachePath);
  return cachePath;
}
