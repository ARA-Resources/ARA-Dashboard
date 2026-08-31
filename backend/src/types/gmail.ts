export type GmailOAuthTokens = {
  access_token?: string | null;
  refresh_token?: string | null;
  scope?: string | null;
  token_type?: string | null;
  expiry_date?: number | null;
  id_token?: string | null;
};

export type StoredGmailAuth = {
  email: string;
  expectedEmail: string;
  tokens: GmailOAuthTokens;
  connectedAt: string;
  updatedAt: string;
};
