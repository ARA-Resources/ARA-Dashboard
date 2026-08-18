import { NextResponse } from "next/server";
import { readDriveMetaStore } from "@/services/drive/metadata-store";

export const runtime = "nodejs";

export async function GET() {
  const store = await readDriveMetaStore();
  return NextResponse.json(store);
}
