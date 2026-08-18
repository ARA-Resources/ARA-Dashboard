/**
 * Professionally formatted PDF from the shared structured Job Description.
 * Visual language matches the ARA Dashboard JD popup (magenta / pink).
 * Never uses raw Excel cell content or ORIGINAL JOB DESCRIPTION.
 */

import { jsPDF } from "jspdf";
import type {
  FormattedBlock,
  JobDescriptionMetaField,
} from "@/utils/format-job-description";
import { ARA_LOGO_JPEG_DATA_URL } from "@/utils/ara-logo-data-url";

export type StructuredJdPdfSection = {
  heading: string | null;
  blocks: FormattedBlock[];
};

export type StructuredJdPdfInput = {
  meta: JobDescriptionMetaField[];
  sections: StructuredJdPdfSection[];
  jobReqId?: string;
};

type Rgb = [number, number, number];

const COLORS = {
  primary: [142, 36, 170] as Rgb, // #8e24aa
  secondary: [194, 24, 91] as Rgb, // #c2185b
  highlight: [233, 30, 99] as Rgb, // #e91e63
  text: [17, 17, 24] as Rgb,
  muted: [92, 92, 102] as Rgb,
  rule: [232, 232, 238] as Rgb,
  card: [255, 255, 255] as Rgb,
  accentFill: [247, 238, 249] as Rgb, // #f7eef9
  mustFill: [246, 237, 250] as Rgb,
  goodFill: [252, 236, 243] as Rgb,
  footer: [245, 245, 247] as Rgb,
};

const PAGE = {
  marginX: 16,
  marginTop: 16,
  /** Leave room for footer band */
  marginBottom: 22,
  footerHeight: 14,
};

/** Sanitize Job Requisition ID for a valid download filename. */
export function sanitizeJobDescriptionFilenameId(jobReqId: string): string {
  return String(jobReqId ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "");
}

export function buildJobDescriptionPdfFilename(jobReqId: string): string {
  const safeId = sanitizeJobDescriptionFilenameId(jobReqId);
  return safeId ? `Job_Description_${safeId}.pdf` : "Job_Description.pdf";
}

function contentBottom(pageHeight: number): number {
  return pageHeight - PAGE.marginBottom;
}

function ensureSpace(doc: jsPDF, y: number, needed: number, pageHeight: number): number {
  if (y + needed <= contentBottom(pageHeight)) return y;
  doc.addPage();
  return PAGE.marginTop;
}

function setFill(doc: jsPDF, color: Rgb) {
  doc.setFillColor(color[0], color[1], color[2]);
}

function setStroke(doc: jsPDF, color: Rgb, width = 0.35) {
  doc.setDrawColor(color[0], color[1], color[2]);
  doc.setLineWidth(width);
}

function setText(doc: jsPDF, color: Rgb, size: number, style: "normal" | "bold" = "normal") {
  doc.setFont("helvetica", style);
  doc.setFontSize(size);
  doc.setTextColor(color[0], color[1], color[2]);
}

function writeWrapped(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  pageHeight: number,
  options?: {
    fontSize?: number;
    fontStyle?: "normal" | "bold";
    color?: Rgb;
    lineGap?: number;
  }
): number {
  const fontSize = options?.fontSize ?? 10;
  const fontStyle = options?.fontStyle ?? "normal";
  const color = options?.color ?? COLORS.text;
  const lineGap = options?.lineGap ?? fontSize * 0.45;

  setText(doc, color, fontSize, fontStyle);
  const lines = doc.splitTextToSize(String(text ?? ""), maxWidth) as string[];

  for (const line of lines) {
    y = ensureSpace(doc, y, lineGap + 1, pageHeight);
    doc.text(line, x, y);
    y += lineGap;
  }
  return y;
}

function estimateWrappedHeight(
  doc: jsPDF,
  text: string,
  maxWidth: number,
  fontSize: number
): number {
  setText(doc, COLORS.text, fontSize, "normal");
  const lines = doc.splitTextToSize(String(text ?? ""), maxWidth) as string[];
  return Math.max(1, lines.length) * fontSize * 0.45;
}

function drawBulletItem(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  pageHeight: number
): number {
  const bulletR = 0.85;
  const textX = x + 4.5;
  const textWidth = maxWidth - 4.5;
  const firstLineH = estimateWrappedHeight(doc, text, textWidth, 10);

  y = ensureSpace(doc, y, Math.min(firstLineH, 8) + 2, pageHeight);

  // Pink bullet dot
  setFill(doc, COLORS.secondary);
  doc.circle(x + 1.2, y - 1.1, bulletR, "F");

  y = writeWrapped(doc, text, textX, y, textWidth, pageHeight, {
    fontSize: 10,
    color: COLORS.text,
    lineGap: 4.6,
  });
  return y + 2.2;
}

type ChipVariant = "must" | "good" | "generic";

function chipPalette(variant: ChipVariant): { fill: Rgb; border: Rgb; text: Rgb } {
  if (variant === "must") {
    return {
      fill: COLORS.mustFill,
      border: COLORS.primary,
      text: COLORS.primary,
    };
  }
  if (variant === "good") {
    return {
      fill: COLORS.goodFill,
      border: COLORS.secondary,
      text: COLORS.secondary,
    };
  }
  return {
    fill: COLORS.accentFill,
    border: COLORS.primary,
    text: COLORS.primary,
  };
}

/**
 * Draw skill chips as bordered rounded pills that wrap across lines.
 * Long labels fall back to bullets so prose never becomes overlapping pills.
 */
function drawSkillChips(
  doc: jsPDF,
  skills: string[],
  variant: ChipVariant,
  x: number,
  y: number,
  maxWidth: number,
  pageHeight: number
): number {
  const shortSkills: string[] = [];
  for (const raw of skills) {
    const label = raw.trim();
    if (!label) continue;
    const words = label.split(/\s+/).length;
    // Prose / long fragments are not chips — keep readable as bullets
    if (label.length > 48 || words > 6) {
      y = drawBulletItem(doc, label, x, y, maxWidth, pageHeight);
      continue;
    }
    shortSkills.push(label);
  }

  if (shortSkills.length === 0) return y;

  const palette = chipPalette(variant);
  const fontSize = 8.5;
  const padX = 2.4;
  const padY = 1.6;
  const gapX = 2.2;
  const gapY = 2.4;
  const chipH = fontSize * 0.4 + padY * 2;
  const radius = 1.6;

  let cursorX = x;
  let cursorY = y;
  let rowTop = y;

  setText(doc, palette.text, fontSize, "bold");

  for (const label of shortSkills) {
    const textW = doc.getTextWidth(label);
    const chipW = Math.min(maxWidth, textW + padX * 2);

    // Wrap to next row within the page
    if (cursorX > x && cursorX + chipW > x + maxWidth) {
      cursorX = x;
      cursorY = rowTop + chipH + gapY;
      rowTop = cursorY;
    }

    // Page break: move entire chip to next page (never clip / overlap)
    const chipTop = cursorY - padY - fontSize * 0.28;
    if (chipTop + chipH > contentBottom(pageHeight)) {
      doc.addPage();
      cursorX = x;
      cursorY = PAGE.marginTop + padY + fontSize * 0.28;
      rowTop = cursorY;
    }

    const drawTop = cursorY - padY - fontSize * 0.28;
    setFill(doc, palette.fill);
    setStroke(doc, palette.border, 0.35);
    doc.roundedRect(cursorX, drawTop, chipW, chipH, radius, radius, "FD");

    setText(doc, palette.text, fontSize, "bold");
    doc.text(label, cursorX + padX, cursorY);

    cursorX += chipW + gapX;
  }

  return rowTop + chipH + 2.5;
}

function drawHeaderBand(
  doc: jsPDF,
  pageWidth: number,
  y: number
): number {
  // Soft accent header strip
  setFill(doc, COLORS.accentFill);
  doc.rect(0, 0, pageWidth, 28, "F");

  // Magenta left accent bar
  setFill(doc, COLORS.primary);
  doc.rect(0, 0, 3.2, 28, "F");

  setText(doc, COLORS.secondary, 9, "bold");
  doc.text("ARA Resources", PAGE.marginX, y);

  y += 7;
  setText(doc, COLORS.primary, 16, "bold");
  doc.text("Job Information", PAGE.marginX, y);

  y += 4;
  setStroke(doc, COLORS.secondary, 0.7);
  doc.line(PAGE.marginX, y, PAGE.marginX + 36, y);

  // ARA Resources logo — top right of header band
  const logoSize = 16;
  const logoX = pageWidth - PAGE.marginX - logoSize;
  const logoY = (28 - logoSize) / 2;
  try {
    doc.addImage(
      ARA_LOGO_JPEG_DATA_URL,
      "JPEG",
      logoX,
      logoY,
      logoSize,
      logoSize
    );
  } catch {
    // Logo is decorative; keep PDF usable if image embed fails
  }

  return 32;
}

function drawMetaTwoColumn(
  doc: jsPDF,
  meta: JobDescriptionMetaField[],
  pageWidth: number,
  pageHeight: number,
  y: number
): number {
  const fields = meta
    .map((f) => ({
      label: f.label.trim(),
      value: String(f.value ?? "").trim(),
    }))
    .filter((f) => f.label && f.value);

  if (fields.length === 0) return y;

  const gap = 8;
  const colW = (pageWidth - PAGE.marginX * 2 - gap) / 2;
  const preferredOrder = [
    /job\s*requisition\s*id/i,
    /^primary\s*skills?$/i,
    /job\s*management\s*level|management\s*level/i,
    /primary\s*location/i,
  ];

  const ordered: typeof fields = [];
  for (const re of preferredOrder) {
    const idx = fields.findIndex(
      (f) => re.test(f.label) && !ordered.includes(f)
    );
    if (idx >= 0) ordered.push(fields[idx]);
  }
  for (const f of fields) {
    if (!ordered.includes(f)) ordered.push(f);
  }

  y = ensureSpace(doc, y, 8, pageHeight);
  setText(doc, COLORS.muted, 8, "bold");
  doc.text("JOB INFORMATION", PAGE.marginX, y);
  y += 3;
  setStroke(doc, COLORS.rule, 0.3);
  doc.line(PAGE.marginX, y, pageWidth - PAGE.marginX, y);
  y += 5;

  for (let i = 0; i < ordered.length; i += 2) {
    const left = ordered[i];
    const right = ordered[i + 1];

    const leftH = 4 + estimateWrappedHeight(doc, left.value, colW, 10) + 3;
    const rightH = right
      ? 4 + estimateWrappedHeight(doc, right.value, colW, 10) + 3
      : 0;
    const rowH = Math.max(leftH, rightH, 12);

    y = ensureSpace(doc, y, rowH, pageHeight);

    const drawField = (field: typeof left, colX: number) => {
      setText(doc, COLORS.secondary, 7.5, "bold");
      doc.text(field.label.toUpperCase(), colX, y);
      writeWrapped(doc, field.value, colX, y + 4.2, colW, pageHeight, {
        fontSize: 10,
        color: COLORS.text,
        lineGap: 4.4,
      });
    };

    drawField(left, PAGE.marginX);
    if (right) {
      drawField(right, PAGE.marginX + colW + gap);
    }

    y += rowH;
  }

  // Divider before body sections
  y = ensureSpace(doc, y, 6, pageHeight);
  setStroke(doc, COLORS.rule, 0.35);
  doc.line(PAGE.marginX, y, pageWidth - PAGE.marginX, y);
  return y + 6;
}

function drawSectionHeading(
  doc: jsPDF,
  heading: string,
  y: number,
  pageHeight: number,
  isProjectRole: boolean
): number {
  // Keep heading with following content when possible
  const minBlock = isProjectRole ? 16 : 14;
  y = ensureSpace(doc, y, minBlock, pageHeight);

  setText(doc, COLORS.primary, isProjectRole ? 11 : 9.5, "bold");
  const label = heading.toUpperCase();
  doc.text(label, PAGE.marginX, y);

  // Tracking-style underline accent
  const labelW = doc.getTextWidth(label);
  y += 1.8;
  setStroke(doc, COLORS.secondary, 0.45);
  doc.line(PAGE.marginX, y, PAGE.marginX + Math.min(labelW, 48), y);

  return y + (isProjectRole ? 5.5 : 4.8);
}

function drawFooters(doc: jsPDF, jobReqId: string) {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const total = doc.getNumberOfPages();
  const reqLabel = jobReqId.trim() || "—";

  for (let i = 1; i <= total; i += 1) {
    doc.setPage(i);

    const footerTop = pageHeight - PAGE.footerHeight;
    setFill(doc, COLORS.footer);
    doc.rect(0, footerTop, pageWidth, PAGE.footerHeight, "F");

    setStroke(doc, COLORS.primary, 0.5);
    doc.line(0, footerTop, pageWidth, footerTop);

    const baseline = pageHeight - 6;

    setText(doc, COLORS.primary, 8, "bold");
    doc.text("ARA Resources", PAGE.marginX, baseline);

    setText(doc, COLORS.muted, 7.5, "normal");
    const mid = `Job Requisition ID: ${reqLabel}`;
    const midW = doc.getTextWidth(mid);
    doc.text(mid, (pageWidth - midW) / 2, baseline);

    setText(doc, COLORS.secondary, 7.5, "bold");
    const pageLabel = `Page ${i} of ${total}`;
    const pageW = doc.getTextWidth(pageLabel);
    doc.text(pageLabel, pageWidth - PAGE.marginX - pageW, baseline);
  }
}

/**
 * Build a PDF document from the structured Job Description object.
 * Does not save — use for tests or custom export.
 */
export function generateStructuredJobDescriptionPdfDocument(
  input: StructuredJdPdfInput
): jsPDF {
  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4",
  });

  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - PAGE.marginX * 2;

  let y = drawHeaderBand(doc, pageWidth, 11);
  y = drawMetaTwoColumn(doc, input.meta, pageWidth, pageHeight, y);

  for (const section of input.sections) {
    if (!section.blocks.length) continue;

    const isProjectRole = Boolean(
      section.heading && /^PROJECT ROLE$/i.test(section.heading)
    );

    if (section.heading) {
      y = drawSectionHeading(
        doc,
        section.heading,
        y,
        pageHeight,
        isProjectRole
      );
    }

    for (const block of section.blocks) {
      if (block.type === "blank") continue;

      if (block.type === "skillChips") {
        y = drawSkillChips(
          doc,
          block.skills,
          block.variant,
          PAGE.marginX,
          y,
          contentWidth,
          pageHeight
        );
        y += 2;
        continue;
      }

      if (block.type === "bullet") {
        y = drawBulletItem(
          doc,
          block.text,
          PAGE.marginX,
          y,
          contentWidth,
          pageHeight
        );
        continue;
      }

      if (block.type === "number") {
        y = writeWrapped(
          doc,
          `${block.index}. ${block.text}`,
          PAGE.marginX,
          y,
          contentWidth,
          pageHeight,
          { fontSize: 10, color: COLORS.text, lineGap: 4.6 }
        );
        y += 2.2;
        continue;
      }

      if (block.type === "paragraph") {
        // Never comma-split paragraphs into chips — prose stays prose
        y = writeWrapped(doc, block.text, PAGE.marginX, y, contentWidth, pageHeight, {
          fontSize: isProjectRole ? 11.5 : 10,
          fontStyle: isProjectRole ? "bold" : "normal",
          color: COLORS.text,
          lineGap: isProjectRole ? 5.2 : 4.6,
        });
        y += isProjectRole ? 3.5 : 2.5;
      }
    }

    y += 4.5;
  }

  drawFooters(doc, input.jobReqId ?? "");
  return doc;
}

/**
 * Generate and download a PDF from the structured Job Description object.
 * Does not include ORIGINAL JOB DESCRIPTION.
 */
export function downloadStructuredJobDescriptionPdf(
  input: StructuredJdPdfInput
): void {
  const doc = generateStructuredJobDescriptionPdfDocument(input);
  const filename = buildJobDescriptionPdfFilename(input.jobReqId ?? "");
  doc.save(filename);
}
