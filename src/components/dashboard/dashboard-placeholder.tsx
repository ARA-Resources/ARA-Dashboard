import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

interface DashboardPlaceholderProps {
  businessUnit?: string;
  sheetName?: string;
}

export function DashboardPlaceholder({
  businessUnit,
  sheetName,
}: DashboardPlaceholderProps) {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="shadow-sm">
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="text-primary">Architecture ready</CardTitle>
          <CardDescription>
            {businessUnit
              ? `${businessUnit} dashboard shell is prepared. Excel integration and widgets will be connected next.`
              : "Dashboard modules will be connected in the next phase."}
            {sheetName ? ` Primary sheet: ${sheetName}.` : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-40 w-full rounded-xl" />
          <div className="grid gap-3 md:grid-cols-2">
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-28 w-full rounded-xl" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
