/**
 * Structured Job Description view model for the modal / copy / PDF.
 *
 * Original Excel JD → parser → this object (once per selection)
 *   → Modal UI
 *   → Copy Description
 *   → Download PDF
 *
 * Presentation only — does not mutate Excel data.
 */

import {
  formatJobDescriptionBlocks,
  type FormattedBlock,
  type JobDescriptionMetaField,
} from "@/utils/format-job-description";

export type StructuredJdSection = {
  heading: string | null;
  blocks: FormattedBlock[];
};

/**
 * Single shared structured Job Description for a selected Master Sheet row.
 */
export type StructuredJobDescription = {
  /** Stable id for the currently selected row (prevents stale UI/PDF). */
  selectionKey: string;
  /** Exact Master Sheet cell (source of truth for ORIGINAL accordion only). */
  originalRaw: string;
  /** Header meta fields shown above the structured body. */
  meta: JobDescriptionMetaField[];
  /** Visible structured sections (after presentation transforms). */
  sections: StructuredJdSection[];
};

function groupFormattedSections(blocks: FormattedBlock[]): StructuredJdSection[] {
  const groups: StructuredJdSection[] = [];
  let current: StructuredJdSection = { heading: null, blocks: [] };

  for (const block of blocks) {
    if (block.type === "blank") continue;
    if (block.type === "heading") {
      if (current.heading !== null || current.blocks.length > 0) {
        groups.push(current);
      }
      current = { heading: block.text, blocks: [] };
      continue;
    }
    current.blocks.push(block);
  }

  if (current.heading !== null || current.blocks.length > 0) {
    groups.push(current);
  }

  return groups.filter((group) => group.blocks.length > 0);
}

function isProjectRoleNameHeading(heading: string | null): boolean {
  return Boolean(heading && /^PROJECT ROLE$/i.test(heading));
}

/**
 * Presentation-only: [Project Role Name] - [Primary Skill]
 */
export function formatProjectRoleDisplay(
  roleName: string,
  primarySkill: string
): string | null {
  const role = roleName.replace(/\s+/g, " ").trim();
  const skill = primarySkill.replace(/\s+/g, " ").trim();

  if (role && skill) {
    const suffix = ` - ${skill}`;
    if (role.toLowerCase().endsWith(suffix.toLowerCase())) {
      return role;
    }
    if (role.toLowerCase() === skill.toLowerCase()) {
      return role;
    }
    return `${role} - ${skill}`;
  }
  if (role) return role;
  if (skill) return skill;
  return null;
}

function extractProjectRoleName(blocks: FormattedBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<FormattedBlock, { type: "paragraph" }> =>
        b.type === "paragraph"
    )
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function applyProjectRolePrimarySkill(
  sections: StructuredJdSection[],
  primarySkill: string
): StructuredJdSection[] {
  const skill = primarySkill.replace(/\s+/g, " ").trim();
  let sawProjectRoleName = false;

  const mapped = sections.map((section) => {
    if (!isProjectRoleNameHeading(section.heading)) {
      return section;
    }
    sawProjectRoleName = true;
    const roleName = extractProjectRoleName(section.blocks);
    const display = formatProjectRoleDisplay(roleName, skill);
    if (!display) {
      return { ...section, blocks: [] };
    }
    return {
      ...section,
      blocks: [{ type: "paragraph" as const, text: display }],
    };
  });

  if (!sawProjectRoleName && skill) {
    return [
      {
        heading: "PROJECT ROLE",
        blocks: [{ type: "paragraph" as const, text: skill }],
      },
      ...mapped,
    ];
  }

  return mapped.filter(
    (section) =>
      !isProjectRoleNameHeading(section.heading) || section.blocks.length > 0
  );
}

export function metaValue(
  meta: JobDescriptionMetaField[],
  labelPattern: RegExp
): string {
  return meta.find((field) => labelPattern.test(field.label))?.value ?? "";
}

export function jobReqIdFromMeta(meta: JobDescriptionMetaField[]): string {
  return metaValue(meta, /job\s*requisition\s*id/i).trim();
}

export function primarySkillFromMeta(meta: JobDescriptionMetaField[]): string {
  return metaValue(meta, /^primary\s*skills?$/i).trim();
}

/**
 * Build a selection key that uniquely identifies the open Master Sheet row.
 */
export function buildJobDescriptionSelectionKey(
  description: string,
  meta: JobDescriptionMetaField[]
): string {
  const reqId = jobReqIdFromMeta(meta);
  if (reqId) return `req:${reqId}`;
  // Fallback when Job Req ID is missing — bind to exact cell contents
  const len = description.length;
  const head = description.slice(0, 64);
  const skill = primarySkillFromMeta(meta);
  return `cell:${len}:${skill}:${head}`;
}

/**
 * Build the ONE structured Job Description object for the current selection.
 * Call once per open row; UI, Copy, and PDF must all consume this object.
 */
export function buildStructuredJobDescription(input: {
  selectionKey: string;
  originalRaw: string;
  meta: JobDescriptionMetaField[];
}): StructuredJobDescription {
  const primarySkill = primarySkillFromMeta(input.meta);
  const sections = input.originalRaw.trim()
    ? applyProjectRolePrimarySkill(
        groupFormattedSections(formatJobDescriptionBlocks(input.originalRaw)),
        primarySkill
      )
    : [];

  return {
    selectionKey: input.selectionKey,
    originalRaw: input.originalRaw,
    meta: input.meta,
    sections,
  };
}

/**
 * Serialize the shared structured object to clipboard plain text.
 * Does not re-parse.
 */
export function structuredJobDescriptionToPlainText(
  structured: StructuredJobDescription
): string {
  const parts: string[] = ["JOB DESCRIPTION", ""];

  for (const field of structured.meta) {
    const label = field.label.trim();
    const value = String(field.value ?? "").trim();
    if (!label || !value) continue;
    parts.push(`${label}:`);
    parts.push(value);
    parts.push("");
  }

  for (const section of structured.sections) {
    if (section.blocks.length === 0) continue;
    if (section.heading) {
      parts.push(section.heading);
      parts.push("");
    }

    for (const block of section.blocks) {
      if (block.type === "skillChips") {
        for (const skill of block.skills) {
          const item = skill.trim();
          if (item) parts.push(`• ${item}`);
        }
        continue;
      }
      if (block.type === "bullet") {
        parts.push(`• ${block.text}`);
        continue;
      }
      if (block.type === "number") {
        parts.push(`${block.index}. ${block.text}`);
        continue;
      }
      if (block.type === "paragraph") {
        parts.push(block.text);
      }
    }
    parts.push("");
  }

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** Snapshot used by Download — must match the currently displayed structured object. */
export function structuredJobDescriptionToPdfInput(
  structured: StructuredJobDescription
) {
  return {
    meta: structured.meta,
    sections: structured.sections,
    jobReqId: jobReqIdFromMeta(structured.meta),
  };
}

export function sectionBody(
  structured: StructuredJobDescription,
  heading: RegExp
): string {
  return structured.sections
    .filter((s) => s.heading && heading.test(s.heading))
    .map((s) =>
      s.blocks
        .map((b) => {
          if (b.type === "paragraph" || b.type === "bullet") return b.text;
          if (b.type === "number") return b.text;
          if (b.type === "skillChips") return b.skills.join(" | ");
          return "";
        })
        .filter(Boolean)
        .join("\n")
    )
    .join("\n");
}
