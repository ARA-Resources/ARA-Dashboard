import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { hashPassword, verifyPasswordHash } from "@/lib/auth/passwords";

const STORE_PATH = path.join(process.cwd(), ".data", "dashboard-users.json");

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_USERNAME_LENGTH = 80;

export type DashboardUser = {
  id: string;
  username: string;
  passwordHash: string;
  createdAt: string;
};

type UserStore = {
  version: 1;
  users: DashboardUser[];
};

function emptyStore(): UserStore {
  return { version: 1, users: [] };
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

async function readStore(): Promise<UserStore> {
  try {
    const raw = (await fs.readFile(STORE_PATH, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as UserStore;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.users)) {
      return emptyStore();
    }
    return { version: 1, users: parsed.users };
  } catch {
    return emptyStore();
  }
}

async function writeStore(store: UserStore): Promise<void> {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), "utf8");
}

/**
 * Email domains allowed to self-register via POST /api/auth/signup.
 * Configurable with ARA_SIGNUP_EMAIL_DOMAINS (comma-separated); defaults to
 * araresources.com. Sign-in (named accounts + shared password) is unaffected.
 */
export function allowedSignupDomains(): string[] {
  const raw = process.env.ARA_SIGNUP_EMAIL_DOMAINS?.trim();
  const domains: string[] = raw ? raw.split(",") : ["araresources.com"];
  return domains
    .map((domain: string) => domain.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

export function isAllowedSignupEmail(username: string): boolean {
  const match = username.trim().toLowerCase().match(/^[^@\s]+@([^@\s]+)$/);
  if (!match) return false;
  return allowedSignupDomains().includes(match[1]);
}

export function validateUsername(username: string): string | null {
  const value = normalizeUsername(username);
  if (!value) return "Enter an email or username.";
  if (value.length > MAX_USERNAME_LENGTH) {
    return `Username must be ${MAX_USERNAME_LENGTH} characters or fewer.`;
  }
  if (!/^[a-z0-9._%+\-@]+$/i.test(value)) {
    return "Use a valid email or username.";
  }
  return null;
}

export function validatePassword(password: string): string | null {
  if (!password) return "Enter a password.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) return "Password is too long.";
  return null;
}

export async function findUserByUsername(
  username: string
): Promise<DashboardUser | null> {
  const key = normalizeUsername(username);
  if (!key) return null;
  const store = await readStore();
  return store.users.find((user) => user.username === key) ?? null;
}

export async function verifyUserPassword(
  username: string,
  password: string
): Promise<DashboardUser | null> {
  const user = await findUserByUsername(username);
  if (!user) return null;
  const ok = await verifyPasswordHash(password, user.passwordHash);
  return ok ? user : null;
}

export async function createUser(input: {
  username: string;
  password: string;
}): Promise<DashboardUser> {
  const username = normalizeUsername(input.username);
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  if (!isAllowedSignupEmail(username)) {
    throw new Error(
      "Sign-up is restricted to an @araresources.com email address."
    );
  }
  const passwordError = validatePassword(input.password);
  if (passwordError) throw new Error(passwordError);

  const store = await readStore();
  if (store.users.some((user) => user.username === username)) {
    const error = new Error("An account with this username already exists.");
    (error as Error & { code?: string }).code = "USER_EXISTS";
    throw error;
  }

  const user: DashboardUser = {
    id: randomUUID(),
    username,
    passwordHash: await hashPassword(input.password),
    createdAt: new Date().toISOString(),
  };
  store.users.push(user);
  await writeStore(store);
  return user;
}
