/**
 * Editable Microsoft Word (.docx) build of the shared structured Job Description.
 *
 * Used by the LATERAL Master Sheet only. The Executive Master Sheet still
 * downloads the jsPDF version from `./download-job-description-pdf` — do not
 * wire this module into that path without a separate decision.
 *
 * The visual language mirrors the PDF (magenta / pink ARA branding) as closely
 * as Word formatting allows. Skill tags are inline shaded runs in a flowing
 * paragraph (the standard Word "tag list") — they wrap naturally and scale from
 * one to a hundred skills with no overlap or row-height artefacts (the bug the
 * PDF's manual chip layout, and an earlier table-grid attempt, could hit).
 *
 * Never uses raw Excel cell content / ORIGINAL JOB DESCRIPTION — consumes the
 * same structured object as the modal UI and Copy Description.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  convertInchesToTwip,
  convertMillimetersToTwip,
} from "docx";
import type {
  StructuredJdPdfInput,
} from "@/utils/download-job-description-pdf";
import { sanitizeJobDescriptionFilenameId } from "@/utils/download-job-description-pdf";
import type {
  FormattedBlock,
  JobDescriptionMetaField,
} from "@/utils/format-job-description";
import { ARA_LOGO_JPEG_DATA_URL } from "@/utils/ara-logo-data-url";

const COLOR = {
  primary: "8E24AA", // #8e24aa
  secondary: "C2185B", // #c2185b
  text: "111118",
  muted: "5C5C66",
  rule: "E8E8EE",
} as const;

type ChipVariant = "must" | "good" | "generic";

const CHIP: Record<ChipVariant, { fill: string; border: string; text: string }> = {
  must: { fill: "F6EDFA", border: COLOR.primary, text: COLOR.primary },
  good: { fill: "FCECF3", border: COLOR.secondary, text: COLOR.secondary },
  generic: { fill: "F7EEF9", border: COLOR.primary, text: COLOR.primary },
};

/** Point size → docx half-points. */
const hp = (pt: number) => Math.round(pt * 2);

const NONE = { style: BorderStyle.NONE, size: 0, color: "auto" } as const;

function borderlessTable() {
  return {
    top: NONE,
    bottom: NONE,
    left: NONE,
    right: NONE,
    insideHorizontal: NONE,
    insideVertical: NONE,
  };
}

/** All four cell edges = none (cells inherit the table's borders otherwise). */
function noCellBorders() {
  return { top: NONE, bottom: NONE, left: NONE, right: NONE };
}

export function buildJobDescriptionDocxFilename(jobReqId: string): string {
  const safeId = sanitizeJobDescriptionFilenameId(jobReqId);
  return safeId ? `Job_Description_${safeId}.docx` : "Job_Description.docx";
}

/** Decode the embedded ARA logo JPEG to bytes; null if anything is off. */
function decodeLogoBytes(): Uint8Array | null {
  try {
    const base64 = ARA_LOGO_JPEG_DATA_URL.split(",")[1] ?? "";
    if (!base64) return null;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

function orderedMetaFields(
  meta: JobDescriptionMetaField[]
): Array<{ label: string; value: string }> {
  const fields = meta
    .map((f) => ({
      label: f.label.trim(),
      value: String(f.value ?? "").trim(),
    }))
    .filter((f) => f.label && f.value);

  const preferredOrder = [
    /job\s*requisition\s*id/i,
    /^primary\s*skills?$/i,
    /job\s*management\s*level|management\s*level/i,
    /primary\s*location/i,
  ];

  const ordered: typeof fields = [];
  for (const re of preferredOrder) {
    const hit = fields.find((f) => re.test(f.label) && !ordered.includes(f));
    if (hit) ordered.push(hit);
  }
  for (const f of fields) {
    if (!ordered.includes(f)) ordered.push(f);
  }
  return ordered;
}

function headerBlock(): Table {
  const logoBytes = decodeLogoBytes();

  const brandCell = new TableCell({
    width: { size: 78, type: WidthType.PERCENTAGE },
    borders: noCellBorders(),
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        spacing: { after: 40 },
        children: [
          new TextRun({
            text: "ARA RESOURCES",
            bold: true,
            color: COLOR.secondary,
            size: hp(8),
          }),
        ],
      }),
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 0, after: 0 },
        children: [
          new TextRun({
            text: "Job Description",
            bold: true,
            color: COLOR.primary,
            size: hp(18),
          }),
        ],
      }),
    ],
  });

  const logoChildren = logoBytes
    ? [
        new ImageRun({
          type: "jpg",
          data: logoBytes,
          transformation: { width: 46, height: 46 },
        }),
      ]
    : [];

  const logoCell = new TableCell({
    width: { size: 22, type: WidthType.PERCENTAGE },
    borders: noCellBorders(),
    verticalAlign: VerticalAlign.CENTER,
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: logoChildren,
      }),
    ],
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      ...borderlessTable(),
      bottom: { style: BorderStyle.SINGLE, size: 12, color: COLOR.secondary },
    },
    rows: [new TableRow({ children: [brandCell, logoCell] })],
  });
}

function detailsSubLabel(): Paragraph {
  return new Paragraph({
    spacing: { before: 160, after: 100 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLOR.rule } },
    children: [
      new TextRun({
        text: "DETAILS",
        bold: true,
        color: COLOR.muted,
        size: hp(8),
      }),
    ],
  });
}

function metaBlock(meta: JobDescriptionMetaField[]): Table | Paragraph {
  const fields = orderedMetaFields(meta);
  if (fields.length === 0) {
    return new Paragraph({ spacing: { after: 0 }, children: [] });
  }

  const fieldCell = (
    field: { label: string; value: string } | undefined
  ): TableCell =>
    new TableCell({
      width: { size: 50, type: WidthType.PERCENTAGE },
      borders: noCellBorders(),
      margins: { top: 40, bottom: 100, left: 0, right: 160 },
      children: field
        ? [
            new Paragraph({
              spacing: { after: 20 },
              children: [
                new TextRun({
                  text: field.label.toUpperCase(),
                  bold: true,
                  color: COLOR.secondary,
                  size: hp(7.5),
                }),
              ],
            }),
            new Paragraph({
              spacing: { line: 264 },
              children: [
                new TextRun({
                  text: field.value,
                  color: COLOR.text,
                  size: hp(10),
                }),
              ],
            }),
          ]
        : [new Paragraph({ children: [] })],
    });

  const rows: TableRow[] = [];
  for (let i = 0; i < fields.length; i += 2) {
    rows.push(
      new TableRow({
        children: [fieldCell(fields[i]), fieldCell(fields[i + 1])],
      })
    );
  }

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: borderlessTable(),
    rows,
  });
}

function isProjectRoleHeading(heading: string | null | undefined): boolean {
  return Boolean(heading && /^PROJECT ROLE$/i.test(heading));
}

function sectionHeading(text: string): Paragraph {
  const projectRole = isProjectRoleHeading(text);
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: COLOR.secondary } },
    children: [
      new TextRun({
        text: text.toUpperCase(),
        bold: true,
        color: COLOR.primary,
        size: hp(projectRole ? 12 : 10.5),
      }),
    ],
  });
}

function proseParagraph(text: string, isProjectRole: boolean): Paragraph {
  return new Paragraph({
    spacing: { after: isProjectRole ? 160 : 120, line: 276 },
    children: [
      new TextRun({
        text,
        color: COLOR.text,
        bold: isProjectRole,
        size: hp(isProjectRole ? 11.5 : 10.5),
      }),
    ],
  });
}

function bulletParagraph(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 60, line: 276 },
    children: [new TextRun({ text, color: COLOR.text, size: hp(10.5) })],
  });
}

function numberParagraph(index: string, text: string): Paragraph {
  return new Paragraph({
    spacing: { after: 60, line: 276 },
    indent: { left: 360, hanging: 360 },
    children: [
      new TextRun({ text: `${index}. ${text}`, color: COLOR.text, size: hp(10.5) }),
    ],
  });
}

/**
 * Skill tags as inline shaded runs in one flowing paragraph — the standard Word
 * "tag list". Wraps naturally, scales from 1 to 100 skills, and has none of the
 * row-height / stretched-cell artefacts a table grid produces. Long fragments
 * (prose, not a skill name) fall back to bullets so a paragraph never becomes
 * one giant highlight.
 */
function skillTags(skills: string[], variant: ChipVariant): Paragraph[] {
  const palette = CHIP[variant];
  const tagRuns: TextRun[] = [];
  const longItems: Paragraph[] = [];

  for (const raw of skills) {
    const label = raw.trim();
    if (!label) continue;
    const words = label.split(/\s+/).length;
    if (label.length > 48 || words > 6) {
      longItems.push(bulletParagraph(label));
      continue;
    }
    if (tagRuns.length > 0) {
      // Unshaded gap so adjacent tags read as separate pills.
      tagRuns.push(new TextRun({ text: "  ", size: hp(9) }));
    }
    tagRuns.push(
      new TextRun({
        // Non-breaking spaces pad the label inside its shaded background.
        text: ` ${label} `,
        bold: true,
        color: palette.text,
        size: hp(9),
        shading: { type: ShadingType.CLEAR, color: "auto", fill: palette.fill },
        border: {
          style: BorderStyle.SINGLE,
          size: 2,
          color: palette.border,
          space: 0,
        },
      })
    );
  }

  const out: Paragraph[] = [];
  if (tagRuns.length > 0) {
    out.push(
      new Paragraph({
        // Generous line height so wrapped rows of tags don't touch.
        spacing: { after: 140, line: 360 },
        children: tagRuns,
      })
    );
  }
  out.push(...longItems);
  return out;
}

function renderBlock(
  block: FormattedBlock,
  isProjectRole: boolean
): Array<Paragraph | Table> {
  switch (block.type) {
    case "skillChips":
      return skillTags(block.skills, block.variant);
    case "bullet":
      return [bulletParagraph(block.text)];
    case "number":
      return [numberParagraph(block.index, block.text)];
    case "paragraph":
      return [proseParagraph(block.text, isProjectRole)];
    case "heading":
      // Headings are lifted into section.heading upstream; keep this safe.
      return [sectionHeading(block.text)];
    case "blank":
    default:
      return [];
  }
}

function footerBlock(jobReqId: string): Footer {
  const reqLabel = jobReqId.trim() || "—";

  const cell = (
    align: (typeof AlignmentType)[keyof typeof AlignmentType],
    runs: TextRun[],
    width: number
  ) =>
    new TableCell({
      width: { size: width, type: WidthType.PERCENTAGE },
      borders: noCellBorders(),
      verticalAlign: VerticalAlign.CENTER,
      children: [new Paragraph({ alignment: align, children: runs })],
    });

  return new Footer({
    children: [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          ...borderlessTable(),
          top: { style: BorderStyle.SINGLE, size: 8, color: COLOR.primary },
        },
        rows: [
          new TableRow({
            children: [
              cell(
                AlignmentType.LEFT,
                [
                  new TextRun({
                    text: "ARA Resources",
                    bold: true,
                    color: COLOR.primary,
                    size: hp(8),
                  }),
                ],
                34
              ),
              cell(
                AlignmentType.CENTER,
                [
                  new TextRun({
                    text: `Job Requisition ID: ${reqLabel}`,
                    color: COLOR.muted,
                    size: hp(7.5),
                  }),
                ],
                40
              ),
              cell(
                AlignmentType.RIGHT,
                [
                  new TextRun({
                    children: [
                      "Page ",
                      PageNumber.CURRENT,
                      " of ",
                      PageNumber.TOTAL_PAGES,
                    ],
                    bold: true,
                    color: COLOR.secondary,
                    size: hp(7.5),
                  }),
                ],
                26
              ),
            ],
          }),
        ],
      }),
    ],
  });
}

/**
 * Build the Word document from the structured Job Description object.
 * Does not save — use for tests or custom export.
 */
export function generateStructuredJobDescriptionDocxDocument(
  input: StructuredJdPdfInput
): Document {
  const children: Array<Paragraph | Table> = [];

  children.push(headerBlock());
  if (orderedMetaFields(input.meta).length > 0) {
    children.push(detailsSubLabel());
    children.push(metaBlock(input.meta));
  } else {
    // Breathing room under the header band when there is no meta grid.
    children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
  }

  for (const section of input.sections) {
    if (!section.blocks.length) continue;
    const projectRole = isProjectRoleHeading(section.heading);

    if (section.heading) {
      children.push(sectionHeading(section.heading));
    }
    for (const block of section.blocks) {
      for (const el of renderBlock(block, projectRole)) {
        children.push(el);
      }
    }
  }

  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: {
              width: convertMillimetersToTwip(210),
              height: convertMillimetersToTwip(297),
            },
            margin: {
              top: convertInchesToTwip(0.9),
              right: convertInchesToTwip(0.9),
              bottom: convertInchesToTwip(0.9),
              left: convertInchesToTwip(0.9),
            },
          },
        },
        footers: { default: footerBlock(input.jobReqId ?? "") },
        children,
      },
    ],
  });
}

/**
 * Generate and download a .docx from the structured Job Description object.
 * Client-side only (uses Blob + anchor download). No raw Excel content.
 */
export async function downloadStructuredJobDescriptionDocx(
  input: StructuredJdPdfInput
): Promise<void> {
  const doc = generateStructuredJobDescriptionDocxDocument(input);
  const blob = await Packer.toBlob(doc);
  const filename = buildJobDescriptionDocxFilename(input.jobReqId ?? "");

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
