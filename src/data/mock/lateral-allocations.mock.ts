/**
 * Placeholder allocation shapes for UI development.
 * Real Excel extraction will replace this later.
 */

export type AllocationStatus = "Allocated" | "Unallocated" | "Partial";
export type AllocationPriority = "P1" | "P2";

export interface AllocationSubSkillCategory {
  id: string;
  name: string;
  recruiters: string[];
  status: AllocationStatus;
  priority: AllocationPriority;
  roleCount: number;
}

export interface AllocationPrimarySkill {
  id: string;
  name: string;
  skillCategorization: string;
  totalRoles: number;
  subSkillCategories: AllocationSubSkillCategory[];
}

export const ALLOCATION_STATUS_OPTIONS: AllocationStatus[] = [
  "Allocated",
  "Partial",
  "Unallocated",
];

export const ALLOCATION_PRIORITY_OPTIONS: AllocationPriority[] = ["P1", "P2"];

export const MOCK_ALLOCATION_PRIMARY_SKILLS: AllocationPrimarySkill[] = [
  {
    id: "ps-salesforce",
    name: "Salesforce",
    skillCategorization: "Premium",
    totalRoles: 369,
    subSkillCategories: [
      {
        id: "ss-sf-core",
        name: "Salesforce Core / Admin",
        recruiters: ["Rajeshwari", "Shikha"],
        status: "Allocated",
        priority: "P1",
        roleCount: 120,
      },
      {
        id: "ss-sf-dev",
        name: "Salesforce Development",
        recruiters: ["Neha"],
        status: "Partial",
        priority: "P1",
        roleCount: 148,
      },
      {
        id: "ss-sf-cpq",
        name: "Salesforce CPQ",
        recruiters: [],
        status: "Unallocated",
        priority: "P2",
        roleCount: 101,
      },
    ],
  },
  {
    id: "ps-oracle",
    name: "Oracle",
    skillCategorization: "Premium+",
    totalRoles: 398,
    subSkillCategories: [
      {
        id: "ss-oracle-erp",
        name: "Oracle ERP Cloud",
        recruiters: ["Nandini"],
        status: "Allocated",
        priority: "P1",
        roleCount: 210,
      },
      {
        id: "ss-oracle-db",
        name: "Oracle Database",
        recruiters: ["Nandini", "Madhu"],
        status: "Partial",
        priority: "P2",
        roleCount: 188,
      },
    ],
  },
  {
    id: "ps-workday",
    name: "Workday",
    skillCategorization: "Premium",
    totalRoles: 328,
    subSkillCategories: [
      {
        id: "ss-wd-hcm",
        name: "Workday HCM",
        recruiters: ["Neha", "Rajeshwari"],
        status: "Allocated",
        priority: "P1",
        roleCount: 190,
      },
      {
        id: "ss-wd-finance",
        name: "Workday Financials",
        recruiters: ["Shikha"],
        status: "Partial",
        priority: "P2",
        roleCount: 138,
      },
    ],
  },
  {
    id: "ps-sap-abap",
    name: "SAP ABAP Development",
    skillCategorization: "Core",
    totalRoles: 562,
    subSkillCategories: [
      {
        id: "ss-sap-tech",
        name: "SAP Technical & Development",
        recruiters: [],
        status: "Unallocated",
        priority: "P1",
        roleCount: 320,
      },
      {
        id: "ss-sap-ui5",
        name: "SAP UI5 / Fiori",
        recruiters: ["Shreya"],
        status: "Partial",
        priority: "P1",
        roleCount: 242,
      },
    ],
  },
  {
    id: "ps-servicenow",
    name: "ServiceNow",
    skillCategorization: "Premium",
    totalRoles: 58,
    subSkillCategories: [
      {
        id: "ss-snow-itsm",
        name: "ServiceNow ITSM",
        recruiters: ["Shreya"],
        status: "Allocated",
        priority: "P2",
        roleCount: 40,
      },
      {
        id: "ss-snow-itom",
        name: "ServiceNow ITOM",
        recruiters: [],
        status: "Unallocated",
        priority: "P2",
        roleCount: 18,
      },
    ],
  },
  {
    id: "ps-ml",
    name: "Machine Learning",
    skillCategorization: "Premium+",
    totalRoles: 93,
    subSkillCategories: [
      {
        id: "ss-ml-core",
        name: "ML Engineering",
        recruiters: ["Madhu"],
        status: "Allocated",
        priority: "P1",
        roleCount: 55,
      },
      {
        id: "ss-ml-llm",
        name: "LLM / GenAI",
        recruiters: ["Sukanya", "Madhu"],
        status: "Allocated",
        priority: "P1",
        roleCount: 38,
      },
    ],
  },
];

export function getMockAllocationFilterOptions(
  skills: AllocationPrimarySkill[] = MOCK_ALLOCATION_PRIMARY_SKILLS
) {
  const primarySkills = skills.map((skill) => skill.name).sort();
  const recruiters = Array.from(
    new Set(
      skills.flatMap((skill) =>
        skill.subSkillCategories.flatMap((sub) => sub.recruiters)
      )
    )
  ).sort();

  return {
    primarySkills,
    recruiters,
    statuses: ALLOCATION_STATUS_OPTIONS,
    priorities: ALLOCATION_PRIORITY_OPTIONS,
  };
}
