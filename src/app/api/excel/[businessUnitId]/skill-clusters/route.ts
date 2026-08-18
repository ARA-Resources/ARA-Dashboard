import { NextResponse } from "next/server";
import { extractSkillClusters } from "@/services/excel/extract-skill-clusters";
import { getBusinessUnitById } from "@/constants/business-units";
import type { BusinessUnitId } from "@/types/business-unit";

export const runtime = "nodejs";
export const maxDuration = 120;

const VALID_UNITS: BusinessUnitId[] = ["lateral", "executive", "consulting"];

interface RouteContext {
  params: Promise<{ businessUnitId: string }>;
}

/**
 * GET /api/excel/:businessUnitId/skill-clusters
 * Builds semantic Skill Clusters per Primary Skill from Must/Good Have skills.
 *
 * Query:
 * - refresh=1
 * - primarySkill=Exact Name (optional filter)
 * - limitGroups=N (optional)
 */
export async function GET(request: Request, context: RouteContext) {
  const { businessUnitId: rawId } = await context.params;
  const businessUnitId = rawId as BusinessUnitId;

  if (!VALID_UNITS.includes(businessUnitId)) {
    return NextResponse.json(
      { error: `Unknown business unit: ${rawId}` },
      { status: 404 }
    );
  }

  if (!getBusinessUnitById(businessUnitId)) {
    return NextResponse.json(
      { error: `Business unit not registered: ${rawId}` },
      { status: 404 }
    );
  }

  const { searchParams } = new URL(request.url);
  const bypassCache = searchParams.get("refresh") === "1";
  const primarySkill = searchParams.get("primarySkill");
  const limitGroupsRaw = searchParams.get("limitGroups");
  const limitGroups =
    limitGroupsRaw && Number.isFinite(Number(limitGroupsRaw))
      ? Math.max(1, Math.min(Number(limitGroupsRaw), 5000))
      : null;

  try {
    const data = await extractSkillClusters(businessUnitId, {
      bypassCache,
      primarySkill: primarySkill || undefined,
      limitGroups: limitGroups ?? undefined,
    });

    return NextResponse.json(
      {
        ...data,
        returnedGroupCount: data.groups.length,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to build skill clusters";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
