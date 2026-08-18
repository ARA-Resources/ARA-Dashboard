import { redirect } from "next/navigation";

/** Legacy route — redirects into company module paths */
export default function OverviewRedirectPage() {
  redirect("/company");
}
