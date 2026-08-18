import { redirect } from "next/navigation";
import { ROUTES } from "@/constants/routes";

export default async function DatasetIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const target = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") target.set(key, value);
    else if (Array.isArray(value) && value[0]) target.set(key, value[0]);
  }
  const qs = target.toString();
  redirect(
    qs ? `${ROUTES.datasetLateral}?${qs}` : ROUTES.datasetLateral
  );
}
