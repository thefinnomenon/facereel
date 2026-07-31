import "dotenv/config";
import process from "node:process";

const DEFAULT_API_VERSION = "v24.0";
const REQUIRED_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_read_engagement",
  "pages_show_list",
] as const;

type JsonObject = Record<string, unknown>;

try {
  if (process.argv[2] !== "--check") {
    throw new Error("Usage: npm run instagram:token:check");
  }
  await checkInstalledToken();
} catch (error) {
  console.error(`Instagram token check failed: ${safeError(error)}`);
  process.exitCode = 1;
}

async function checkInstalledToken(): Promise<void> {
  const pageToken = requiredEnv("INSTAGRAM_PAGE_ACCESS_TOKEN");
  const instagramAccountId = requiredEnv("INSTAGRAM_BUSINESS_ACCOUNT_ID");
  const appId = requiredEnv("META_APP_ID");
  const appSecret = requiredEnv("META_APP_SECRET");
  const apiVersion = process.env.INSTAGRAM_GRAPH_API_VERSION?.trim() || DEFAULT_API_VERSION;

  const [profile, debug] = await Promise.all([
    verifyInstagramAccount({ apiVersion, pageToken, instagramAccountId }),
    inspectToken({ apiVersion, pageToken, appId, appSecret }),
  ]);
  validateProfile(profile, instagramAccountId);
  const scopes = validateTokenMetadata(debug, appId);

  console.log(`Verified Instagram account: @${profile.username} (${profile.id}).`);
  console.log("Verified token type: PAGE.");
  console.log("Meta reports no scheduled token expiration.");
  console.log(`Granted scopes: ${scopes.join(", ")}.`);
}

async function verifyInstagramAccount(input: {
  apiVersion: string;
  pageToken: string;
  instagramAccountId: string;
}): Promise<{ id: string; username: string }> {
  const payload = await graphRequest(
    graphUrl(input.apiVersion, `/${input.instagramAccountId}`, { fields: "id,username" }),
    input.pageToken,
  );
  return {
    id: stringField(payload, "id", "Meta did not return the Instagram business account ID."),
    username: stringField(payload, "username", "Meta did not return the Instagram username."),
  };
}

async function inspectToken(input: {
  apiVersion: string;
  pageToken: string;
  appId: string;
  appSecret: string;
}): Promise<JsonObject> {
  const payload = await graphRequest(
    graphUrl(input.apiVersion, "/debug_token", { input_token: input.pageToken }),
    `${input.appId}|${input.appSecret}`,
  );
  if (!isObject(payload.data)) throw new Error("Meta did not return Page token metadata.");
  return payload.data;
}

function validateProfile(profile: { id: string; username: string }, expectedId: string): void {
  if (profile.id !== expectedId) {
    throw new Error("Meta returned a different Instagram business account than configured.");
  }
  if (profile.username.toLowerCase() !== "facereelapp") {
    throw new Error(`Expected @facereelapp, but Meta returned @${profile.username}.`);
  }
}

function validateTokenMetadata(debug: JsonObject, appId: string): string[] {
  if (debug.is_valid !== true) throw new Error("Meta reports that the Page token is invalid.");
  const tokenType = optionalString(debug.type);
  if (tokenType !== "PAGE") {
    throw new Error(`Expected a Page token, but Meta reports token type ${tokenType ?? "unknown"}.`);
  }
  if (optionalString(debug.app_id) !== appId) {
    throw new Error("The Page token belongs to a different Meta app than META_APP_ID.");
  }
  if (optionalNumber(debug.expires_at) !== 0) {
    throw new Error("Meta does not report this Page token as never-expiring.");
  }

  const scopes = Array.isArray(debug.scopes)
    ? debug.scopes.filter((scope): scope is string => typeof scope === "string").sort()
    : [];
  const missingScopes = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Page token is missing required scopes: ${missingScopes.join(", ")}.`);
  }
  return scopes;
}

async function graphRequest(url: URL, bearerToken: string): Promise<JsonObject> {
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${bearerToken}` },
  });
  const payload = parseObject(await response.text());
  if (!response.ok) {
    const graphError = isObject(payload.error) ? payload.error : null;
    const code = graphError ? optionalNumber(graphError.code) : null;
    throw new Error(
      `Meta Graph API request failed (HTTP ${response.status}${code === null ? "" : `, code ${code}`}).`,
    );
  }
  return payload;
}

function graphUrl(apiVersion: string, pathname: string, params: Record<string, string>): URL {
  const url = new URL(`https://graph.facebook.com/${apiVersion}${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

function parseObject(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(input: JsonObject, key: string, message: string): string {
  const value = optionalString(input[key]);
  if (!value) throw new Error(message);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const secrets = [
    process.env.META_APP_SECRET,
    process.env.INSTAGRAM_PAGE_ACCESS_TOKEN,
    process.env.INSTAGRAM_PUBLISH_ACCESS_TOKEN,
  ].filter((value): value is string => Boolean(value));
  for (const secret of secrets) message = message.replaceAll(secret, "<redacted>");
  return message.replace(/\b(?:EAA|IGA)[A-Za-z0-9_-]{20,}\b/g, "<redacted>");
}
