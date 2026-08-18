/** Browser-safe OAuth start URL. Identity comes from setup or GMAIL_ACCOUNT. */
export function gmailOAuthStartHref(email?: string | null): string {
  const trimmed = email?.trim();
  if (!trimmed) return "/api/dataset/gmail/oauth/start";
  return `/api/dataset/gmail/oauth/start?email=${encodeURIComponent(trimmed)}`;
}
