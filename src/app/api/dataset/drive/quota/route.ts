import { NextResponse } from "next/server";
import { fetchDriveQuota } from "@/services/drive/quota";

export const runtime = "nodejs";

export async function GET() {
  const quota = await fetchDriveQuota();
  return NextResponse.json(quota, {
    status: quota.available ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
