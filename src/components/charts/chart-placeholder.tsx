import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function ChartPlaceholder({ title = "Chart" }: { title?: string }) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="text-base text-primary">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Skeleton className="h-56 w-full rounded-xl" />
      </CardContent>
    </Card>
  );
}
