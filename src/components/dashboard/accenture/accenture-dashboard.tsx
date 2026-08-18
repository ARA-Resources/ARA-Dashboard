"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/layouts/page-header";
import { PageTransition } from "@/animations/page-transition";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BusinessUnitSelect } from "@/components/dashboard/accenture/business-unit-select";
import { OpeningsTableToolbar } from "@/components/dashboard/accenture/openings-table-toolbar";
import { OpeningsDataTable } from "@/components/dashboard/accenture/openings-data-table";
import { DEFAULT_DASHBOARD_BUSINESS_UNIT } from "@/constants/accenture-dashboard";
import { getBusinessUnitById } from "@/constants/business-units";
import {
  excelFiltersQueryKey,
  excelOpeningsQueryKey,
  fetchFilterSchema,
  fetchTopOpenings,
  useBusinessUnitFilterSchema,
  useBusinessUnitOpenings,
} from "@/hooks/use-business-unit-openings";
import { HOME_WIDGETS_QUERY_KEY } from "@/services/home/fetch-home-widgets";
import { useDashboardFilterStore } from "@/stores/dashboard-filter-store";
import { countActiveColumnFilters } from "@/services/excel/apply-filters";
import type { BusinessUnitId } from "@/types/business-unit";
import { FadeIn } from "@/animations/fade-in";
import { downloadCsv, toCsv } from "@/utils/csv";

export function AccentureDashboard() {
  const queryClient = useQueryClient();
  const [businessUnit, setBusinessUnit] = React.useState<BusinessUnitId>(
    DEFAULT_DASHBOARD_BUSINESS_UNIT
  );
  const [search, setSearch] = React.useState("");
  const [refreshing, setRefreshing] = React.useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = React.useState<Date | null>(
    null
  );
  const [refreshMessage, setRefreshMessage] = React.useState<string | null>(
    null
  );

  const ensureUserFilters = useDashboardFilterStore((s) => s.ensureUserFilters);
  const getUserFilters = useDashboardFilterStore((s) => s.getUserFilters);
  const getDefaultFilters = useDashboardFilterStore((s) => s.getDefaultFilters);
  const isUsingDefaults = useDashboardFilterStore((s) => s.isUsingDefaults);
  const hydrateFromSchema = useDashboardFilterStore((s) => s.hydrateFromSchema);
  const syncSortFromHeaders = useDashboardFilterStore(
    (s) => s.syncSortFromHeaders
  );
  const toggleColumnFilterValue = useDashboardFilterStore(
    (s) => s.toggleColumnFilterValue
  );
  const clearColumnFilter = useDashboardFilterStore((s) => s.clearColumnFilter);
  const setSortBy = useDashboardFilterStore((s) => s.setSortBy);
  const setSortDirection = useDashboardFilterStore((s) => s.setSortDirection);
  const setTopN = useDashboardFilterStore((s) => s.setTopN);
  const resetToDefaults = useDashboardFilterStore((s) => s.resetToDefaults);
  const clearFilters = useDashboardFilterStore((s) => s.clearFilters);
  const userFiltersByUnit = useDashboardFilterStore((s) => s.userFiltersByUnit);
  const resolvedDefaultsByUnit = useDashboardFilterStore(
    (s) => s.resolvedDefaultsByUnit
  );

  React.useEffect(() => {
    ensureUserFilters(businessUnit);
  }, [businessUnit, ensureUserFilters]);

  const {
    data: schema,
    isLoading: schemaLoading,
    error: schemaError,
  } = useBusinessUnitFilterSchema(businessUnit);

  React.useEffect(() => {
    if (schema) hydrateFromSchema(businessUnit, schema);
  }, [schema, businessUnit, hydrateFromSchema]);

  const filters = userFiltersByUnit[businessUnit] ?? getUserFilters(businessUnit);
  const defaultFilters =
    resolvedDefaultsByUnit[businessUnit] ?? getDefaultFilters(businessUnit);
  const usingDefaults = isUsingDefaults(businessUnit);

  const { data, isLoading, isFetching, error } = useBusinessUnitOpenings(
    businessUnit,
    filters
  );

  React.useEffect(() => {
    if (data?.headers?.length) {
      syncSortFromHeaders(businessUnit, data.headers);
    }
  }, [data?.headers, businessUnit, syncSortFromHeaders]);

  const unit = getBusinessUnitById(businessUnit);

  function handleBusinessUnitChange(next: BusinessUnitId) {
    ensureUserFilters(next);
    setBusinessUnit(next);
    setSearch("");
  }

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      // 1) Bypass Excel cache and reload filter schema
      const nextSchema = await fetchFilterSchema(businessUnit, {
        refresh: true,
      });
      queryClient.setQueryData(excelFiltersQueryKey(businessUnit), nextSchema);
      hydrateFromSchema(businessUnit, nextSchema);

      // 2) Use filters after hydrate so cache key matches active useQuery
      const settledFilters =
        useDashboardFilterStore.getState().getUserFilters(businessUnit);

      const nextOpenings = await fetchTopOpenings(
        businessUnit,
        settledFilters,
        { refresh: true }
      );

      queryClient.setQueryData(
        excelOpeningsQueryKey(businessUnit, settledFilters),
        nextOpenings
      );

      // Drop older openings keys for this BU (pre-hydrate filter shapes)
      queryClient.removeQueries({
        queryKey: ["excel-openings", businessUnit],
        predicate: (query) =>
          JSON.stringify(query.queryKey) !==
          JSON.stringify(excelOpeningsQueryKey(businessUnit, settledFilters)),
      });
      queryClient.setQueryData(
        excelOpeningsQueryKey(businessUnit, settledFilters),
        nextOpenings
      );

      void queryClient.invalidateQueries({ queryKey: HOME_WIDGETS_QUERY_KEY });

      setLastRefreshedAt(new Date());
      const openingsTotal =
        nextOpenings.meta.filteredDetailCount ?? nextOpenings.rows.length;
      setRefreshMessage(
        `Excel reloaded · ${openingsTotal.toLocaleString()} openings · ${
          nextOpenings.rows.length
        } row${nextOpenings.rows.length === 1 ? "" : "s"} shown`
      );
    } catch (refreshError) {
      setRefreshMessage(
        refreshError instanceof Error
          ? refreshError.message
          : "Refresh failed. Try again."
      );
    } finally {
      setRefreshing(false);
    }
  }

  function handleExport() {
    if (!data?.headers?.length) return;
    const csv = toCsv(data.headers, data.rows);
    downloadCsv(`${businessUnit}-openings.csv`, csv);
  }

  const title =
    filters.topN === null ? "Openings" : `Top ${filters.topN} Openings`;

  const description = unit
    ? `${unit.name} · Dataset Manager · Filters from: ${
        unit.excel.detailSheet ?? unit.excel.primarySheet
      }`
    : "Select a business unit to load Excel openings.";

  const activeFilterChips = Object.entries(filters.columnFilters).flatMap(
    ([column, values]) => {
      const seen = new Set<string>();
      const chips: Array<{ key: string; label: string }> = [];
      values.forEach((value, index) => {
        const normalized = `${column}:${String(value).toLowerCase()}`;
        if (seen.has(normalized)) return;
        seen.add(normalized);
        chips.push({
          key: `${normalized}:${index}`,
          label: `${column}: ${value}`,
        });
      });
      return chips;
    }
  );

  return (
    <PageTransition>
      <PageHeader title="Dashboard" description={description} />

      <FadeIn>
        <Card className="mb-4 rounded-2xl shadow-sm">
          <CardContent className="pt-1">
            <BusinessUnitSelect
              value={businessUnit}
              onChange={handleBusinessUnitChange}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {activeFilterChips.slice(0, 6).map((chip) => (
                <Badge key={chip.key} variant="secondary" className="rounded-lg">
                  {chip.label}
                </Badge>
              ))}
              {activeFilterChips.length > 6 ? (
                <Badge variant="outline" className="rounded-lg">
                  +{activeFilterChips.length - 6} more
                </Badge>
              ) : null}
              {filters.sortBy ? (
                <Badge variant="outline" className="rounded-lg">
                  {filters.sortBy} · {filters.sortDirection}
                </Badge>
              ) : null}
              <Badge variant="outline" className="rounded-lg">
                {filters.topN === null ? "All rows" : `Top ${filters.topN}`}
              </Badge>
              {!usingDefaults ? (
                <Badge className="rounded-lg bg-ara-highlight text-white">
                  Modified
                </Badge>
              ) : (
                <Badge variant="outline" className="rounded-lg">
                  Defaults
                </Badge>
              )}
            </div>
            {data ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {data.meta.filteredDetailCount !== undefined ? (
                  <>
                    <span className="font-medium text-foreground">
                      {data.meta.filteredDetailCount.toLocaleString()} openings
                    </span>
                    {" · "}
                  </>
                ) : null}
                {countActiveColumnFilters(filters.columnFilters)} column filters
                · showing {data.rows.length}
                {" · "}
                <span className="font-medium text-foreground">
                  {data.sourceLabel || data.sourceFile}
                </span>
                {data.meta.filePath?.includes("datasets") &&
                data.meta.filePath.includes("current") ? (
                  <> · Dataset Manager</>
                ) : null}
                {data.meta.mtimeMs ? (
                  <>
                    {" · "}
                    Sheet{" "}
                    <span className="font-medium text-foreground">
                      {new Date(data.meta.mtimeMs).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </>
                ) : null}
                {lastRefreshedAt ? (
                  <>
                    {" "}
                    · Last refreshed{" "}
                    <span className="font-medium text-foreground">
                      {lastRefreshedAt.toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                  </>
                ) : null}
              </p>
            ) : null}
            {refreshMessage ? (
              <p
                className={
                  refreshMessage.toLowerCase().includes("fail")
                    ? "mt-2 text-xs text-destructive"
                    : "mt-2 text-xs text-primary"
                }
              >
                {refreshMessage}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </FadeIn>

      <FadeIn delay={0.05}>
        <Card className="rounded-2xl shadow-sm">
          <CardHeader className="gap-0 border-b border-border [.border-b]:pb-4">
            <OpeningsTableToolbar
              title={title}
              search={search}
              onSearchChange={setSearch}
              onRefresh={handleRefresh}
              onExport={handleExport}
              refreshing={refreshing || isFetching}
              schema={schema}
              schemaLoading={schemaLoading}
              schemaError={
                schemaError instanceof Error ? schemaError.message : null
              }
              filters={filters}
              defaultFilters={defaultFilters}
              usingDefaults={usingDefaults}
              availableSortColumns={data?.headers ?? []}
              onToggleColumnValue={(column, value) =>
                toggleColumnFilterValue(businessUnit, column, value)
              }
              onClearColumn={(column) =>
                clearColumnFilter(businessUnit, column)
              }
              onSortByChange={(sortBy) => setSortBy(businessUnit, sortBy)}
              onSortDirectionChange={(direction) =>
                setSortDirection(businessUnit, direction)
              }
              onTopNChange={(topN) => setTopN(businessUnit, topN)}
              onResetDefaults={() => resetToDefaults(businessUnit)}
              onClearFilters={() => clearFilters(businessUnit)}
            />
          </CardHeader>
          <CardContent className="pt-4">
            <OpeningsDataTable
              key={`${businessUnit}-${JSON.stringify(filters)}`}
              headers={data?.headers ?? []}
              data={data?.rows ?? []}
              globalFilter={search}
              isLoading={isLoading}
              errorMessage={error instanceof Error ? error.message : null}
            />
          </CardContent>
        </Card>
      </FadeIn>
    </PageTransition>
  );
}
