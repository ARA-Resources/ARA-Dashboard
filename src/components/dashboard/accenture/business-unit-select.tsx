"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getAccentureDashboardBusinessUnits,
  type DashboardBusinessUnitOption,
} from "@/constants/accenture-dashboard";
import type { BusinessUnitId } from "@/types/business-unit";

interface BusinessUnitSelectProps {
  value: BusinessUnitId;
  onChange: (value: BusinessUnitId) => void;
  options?: DashboardBusinessUnitOption[];
}

export function BusinessUnitSelect({
  value,
  onChange,
  options = getAccentureDashboardBusinessUnits(),
}: BusinessUnitSelectProps) {
  return (
    <div className="flex w-full flex-col gap-2 sm:max-w-xs">
      <label
        htmlFor="business-unit-select"
        className="text-sm font-medium text-primary"
      >
        Business Unit
      </label>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next) onChange(next as BusinessUnitId);
        }}
      >
        <SelectTrigger
          id="business-unit-select"
          className="h-10 w-full min-w-[12rem] rounded-xl"
        >
          <SelectValue placeholder="Select business unit" />
        </SelectTrigger>
        <SelectContent align="start" className="rounded-xl">
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
