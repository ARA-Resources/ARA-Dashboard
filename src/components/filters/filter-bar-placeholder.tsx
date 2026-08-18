import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function FilterBarPlaceholder() {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 shadow-sm">
      <span className="text-sm font-medium text-primary">Filters</span>
      <Badge variant="secondary">All</Badge>
      <Badge variant="outline">Status</Badge>
      <Badge variant="outline">Location</Badge>
      <div className="ml-auto">
        <Button variant="secondary" size="sm" disabled>
          Clear
        </Button>
      </div>
    </div>
  );
}
