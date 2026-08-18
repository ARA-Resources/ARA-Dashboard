import type { BusinessUnitId } from "@/types/business-unit";

/**
 * Placeholder openings rows for UI only.
 * Replace with Excel-backed data in a later phase.
 */
export interface OpeningRow {
  id: string;
  businessUnit: BusinessUnitId;
  role: string;
  location: string;
  grade: string;
  openings: number;
  priority: "High" | "Medium" | "Low";
  status: "Open" | "On Hold" | "In Progress";
  ageingDays: number;
  recruiter: string;
}

const LATERAL_SEED: Omit<OpeningRow, "id" | "businessUnit">[] = [
  {
    role: "Data Scientist – Generative AI",
    location: "Bangalore",
    grade: "9",
    openings: 4,
    priority: "High",
    status: "Open",
    ageingDays: 18,
    recruiter: "A. Sharma",
  },
  {
    role: "ML Engineer – NLP",
    location: "Hyderabad",
    grade: "10",
    openings: 2,
    priority: "High",
    status: "In Progress",
    ageingDays: 12,
    recruiter: "R. Iyer",
  },
  {
    role: "Analytics Consultant",
    location: "Pune",
    grade: "8",
    openings: 3,
    priority: "Medium",
    status: "Open",
    ageingDays: 25,
    recruiter: "S. Patel",
  },
  {
    role: "AI Solution Architect",
    location: "Gurgaon",
    grade: "11",
    openings: 1,
    priority: "High",
    status: "Open",
    ageingDays: 9,
    recruiter: "M. Khan",
  },
  {
    role: "Data Engineer – Azure",
    location: "Chennai",
    grade: "9",
    openings: 5,
    priority: "Medium",
    status: "In Progress",
    ageingDays: 21,
    recruiter: "P. Nair",
  },
  {
    role: "Applied Scientist",
    location: "Bangalore",
    grade: "10",
    openings: 2,
    priority: "High",
    status: "Open",
    ageingDays: 7,
    recruiter: "K. Rao",
  },
  {
    role: "BI Developer",
    location: "Mumbai",
    grade: "8",
    openings: 3,
    priority: "Low",
    status: "On Hold",
    ageingDays: 34,
    recruiter: "N. Gupta",
  },
  {
    role: "MLOps Engineer",
    location: "Hyderabad",
    grade: "9",
    openings: 2,
    priority: "Medium",
    status: "Open",
    ageingDays: 14,
    recruiter: "V. Singh",
  },
  {
    role: "Decision Scientist",
    location: "Pune",
    grade: "9",
    openings: 1,
    priority: "High",
    status: "In Progress",
    ageingDays: 11,
    recruiter: "T. Das",
  },
  {
    role: "GenAI Prompt Engineer",
    location: "Bangalore",
    grade: "8",
    openings: 4,
    priority: "Medium",
    status: "Open",
    ageingDays: 16,
    recruiter: "H. Mehta",
  },
];

const EXECUTIVE_SEED: Omit<OpeningRow, "id" | "businessUnit">[] = [
  {
    role: "Managing Director – Technology",
    location: "Mumbai",
    grade: "MD",
    openings: 1,
    priority: "High",
    status: "Open",
    ageingDays: 40,
    recruiter: "E. Cap",
  },
  {
    role: "Senior Manager – Strategy",
    location: "Gurgaon",
    grade: "SM",
    openings: 2,
    priority: "High",
    status: "In Progress",
    ageingDays: 22,
    recruiter: "L. Fox",
  },
  {
    role: "Director – Client Services",
    location: "Bangalore",
    grade: "D",
    openings: 1,
    priority: "Medium",
    status: "Open",
    ageingDays: 28,
    recruiter: "J. Cole",
  },
  {
    role: "Associate Director – Delivery",
    location: "Hyderabad",
    grade: "AD",
    openings: 1,
    priority: "High",
    status: "Open",
    ageingDays: 15,
    recruiter: "C. West",
  },
  {
    role: "Senior Manager – Data & AI",
    location: "Pune",
    grade: "SM",
    openings: 2,
    priority: "High",
    status: "In Progress",
    ageingDays: 19,
    recruiter: "A. Bloom",
  },
  {
    role: "Director – Industry X",
    location: "Chennai",
    grade: "D",
    openings: 1,
    priority: "Medium",
    status: "On Hold",
    ageingDays: 45,
    recruiter: "R. Lane",
  },
  {
    role: "Managing Director – Cloud",
    location: "Bangalore",
    grade: "MD",
    openings: 1,
    priority: "High",
    status: "Open",
    ageingDays: 33,
    recruiter: "S. Park",
  },
  {
    role: "Senior Manager – Security",
    location: "Mumbai",
    grade: "SM",
    openings: 1,
    priority: "Medium",
    status: "Open",
    ageingDays: 17,
    recruiter: "D. Hill",
  },
  {
    role: "Director – Operations",
    location: "Gurgaon",
    grade: "D",
    openings: 1,
    priority: "Low",
    status: "In Progress",
    ageingDays: 26,
    recruiter: "M. Stone",
  },
  {
    role: "Associate Director – Growth",
    location: "Bangalore",
    grade: "AD",
    openings: 2,
    priority: "High",
    status: "Open",
    ageingDays: 10,
    recruiter: "P. Quinn",
  },
];

const CONSULTING_SEED: Omit<OpeningRow, "id" | "businessUnit">[] = [
  {
    role: "Technology Consulting Analyst",
    location: "Bangalore",
    grade: "A",
    openings: 6,
    priority: "High",
    status: "Open",
    ageingDays: 8,
    recruiter: "C. Demand",
  },
  {
    role: "Senior Consultant – SAP",
    location: "Hyderabad",
    grade: "SC",
    openings: 3,
    priority: "High",
    status: "In Progress",
    ageingDays: 20,
    recruiter: "B. Flow",
  },
  {
    role: "Consultant – Cloud",
    location: "Pune",
    grade: "C",
    openings: 4,
    priority: "Medium",
    status: "Open",
    ageingDays: 13,
    recruiter: "G. Wave",
  },
  {
    role: "Manager – Transformation",
    location: "Mumbai",
    grade: "M",
    openings: 2,
    priority: "High",
    status: "Open",
    ageingDays: 24,
    recruiter: "F. Peak",
  },
  {
    role: "Consultant – Salesforce",
    location: "Chennai",
    grade: "C",
    openings: 3,
    priority: "Medium",
    status: "On Hold",
    ageingDays: 31,
    recruiter: "H. Trail",
  },
  {
    role: "Senior Consultant – Analytics",
    location: "Gurgaon",
    grade: "SC",
    openings: 2,
    priority: "High",
    status: "In Progress",
    ageingDays: 16,
    recruiter: "I. North",
  },
  {
    role: "Analyst – Digital",
    location: "Bangalore",
    grade: "A",
    openings: 5,
    priority: "Low",
    status: "Open",
    ageingDays: 6,
    recruiter: "J. Bridge",
  },
  {
    role: "Consultant – Cyber",
    location: "Hyderabad",
    grade: "C",
    openings: 2,
    priority: "Medium",
    status: "Open",
    ageingDays: 18,
    recruiter: "K. Shield",
  },
  {
    role: "Senior Consultant – Strategy",
    location: "Mumbai",
    grade: "SC",
    openings: 1,
    priority: "High",
    status: "In Progress",
    ageingDays: 27,
    recruiter: "L. Orbit",
  },
  {
    role: "Manager – Industry Consulting",
    location: "Pune",
    grade: "M",
    openings: 1,
    priority: "High",
    status: "Open",
    ageingDays: 12,
    recruiter: "O. Crest",
  },
];

function withIds(
  businessUnit: BusinessUnitId,
  rows: Omit<OpeningRow, "id" | "businessUnit">[]
): OpeningRow[] {
  return rows.map((row, index) => ({
    ...row,
    id: `${businessUnit}-${index + 1}`,
    businessUnit,
  }));
}

export const PLACEHOLDER_OPENINGS: Record<BusinessUnitId, OpeningRow[]> = {
  lateral: withIds("lateral", LATERAL_SEED),
  executive: withIds("executive", EXECUTIVE_SEED),
  consulting: withIds("consulting", CONSULTING_SEED),
};

export function getPlaceholderOpenings(
  businessUnit: BusinessUnitId
): OpeningRow[] {
  return PLACEHOLDER_OPENINGS[businessUnit] ?? [];
}
