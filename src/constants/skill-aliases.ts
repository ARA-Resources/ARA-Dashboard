/**
 * Canonical skill aliases for clustering / matching.
 * Keys and values must already be in basic-normalized form
 * (lowercase, collapsed whitespace) BEFORE punctuation/token rules,
 * or use the final normalized form — applyAliasMap runs after
 * punctuation standardization.
 *
 * Map alias → canonical normalized value.
 */
export const SKILL_ALIAS_TO_CANONICAL: Record<string, string> = {
  // Azure / Microsoft analytics
  adf: "azure data factory",
  "azure data factory": "azure data factory",
  "azure data factory (adf)": "azure data factory",
  "power bi": "microsoft power bi",
  powerbi: "microsoft power bi",
  "ms power bi": "microsoft power bi",
  "microsoft power bi": "microsoft power bi",
  "power bi desktop": "microsoft power bi",

  // SAP CRM UI
  "sap crm webui": "sap crm web ui",
  "sap crm web-ui": "sap crm web ui",
  "sap crm web ui": "sap crm web ui",

  // Cloud shorthand
  aws: "amazon web services",
  "amazon web services": "amazon web services",
  "amazon web services (aws)": "amazon web services",
  gcp: "google cloud platform",
  "google cloud": "google cloud platform",
  "google cloud platform": "google cloud platform",

  // AI / ML
  ml: "machine learning",
  "machine learning": "machine learning",
  "machine learning (ml)": "machine learning",
  llm: "large language models",
  llms: "large language models",
  "large language models": "large language models",
  "large language models (llm)": "large language models",
  "large language models (llms)": "large language models",
  genai: "generative ai",
  "gen ai": "generative ai",
  "generative ai": "generative ai",

  // Web / JS
  reactjs: "react.js",
  "react js": "react.js",
  "react.js": "react.js",
  react: "react.js",
  nodejs: "node.js",
  "node js": "node.js",
  "node.js": "node.js",

  // Adobe / AEM
  aem: "adobe experience manager",
  "adobe experience manager": "adobe experience manager",
  "adobe experience manager (aem)": "adobe experience manager",

  // Dynamics
  "ms dynamics": "microsoft dynamics",
  "ms dynamics crm": "microsoft dynamics crm",
  "dynamics crm": "microsoft dynamics crm",
  "microsoft dynamics crm": "microsoft dynamics crm",

  // Common data stack
  "azure databricks": "microsoft azure databricks",
  "microsoft azure databricks": "microsoft azure databricks",
  databricks: "databricks unified data analytics platform",

  // Snowflake
  snowflake: "snowflake data warehouse",
  "snowflake data warehouse": "snowflake data warehouse",

  // ServiceNow short forms
  "servicenow itsm": "servicenow it service management",
  "servicenow itom": "servicenow it operations management",
};

/** Longest-first alias keys for stable phrase replacement */
export const SKILL_ALIAS_KEYS_LONGEST_FIRST = Object.keys(
  SKILL_ALIAS_TO_CANONICAL
).sort((a, b) => b.length - a.length);
