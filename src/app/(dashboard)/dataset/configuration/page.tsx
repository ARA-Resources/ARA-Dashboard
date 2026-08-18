import { redirect } from "next/navigation";
import { ROUTES } from "@/constants/routes";

/** Legacy Configuration route → Common Connections */
export default function DatasetConfigurationRedirectPage() {
  redirect(ROUTES.datasetConnections);
}
