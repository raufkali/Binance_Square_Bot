import Groq from "groq-sdk";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { MongoClient } from "mongodb";

dotenv.config();

/*
=========================================================
LINKEDIN AI BOT V2.1.0 (INDIVIDUAL PROFILE EDITION)
=========================================================
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================================================
   CONFIG
======================================================= */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "Binance-Square-Bot";

const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;
const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;
const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI;
// <-- REMOVED: LINKEDIN_ORG_URN
const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || "202606";

const POST_TRIGGER_SECRET =
  process.env.LINKEDIN_POST_TRIGGER_SECRET || process.env.POST_TRIGGER_SECRET;

const MAX_POSTS_PER_DAY = parsePositiveInteger(
  process.env.LINKEDIN_MAX_POSTS_PER_DAY,
  3,
);
const MAX_HISTORY = parsePositiveInteger(process.env.LINKEDIN_MAX_HISTORY, 150);
const REQUEST_TIMEOUT_MS = parsePositiveInteger(
  process.env.REQUEST_TIMEOUT_MS,
  30000,
);

const DRY_RUN =
  String(process.env.LINKEDIN_DRY_RUN || "false").toLowerCase() === "true";

const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Asia/Karachi";

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_IMAGE_MODEL =
  process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

const STATE_FILE = path.join(__dirname, "linkedin-state.json");
const STATE_BACKUP_FILE = path.join(__dirname, "linkedin-state.backup.json");
const GENERATED_IMAGE_DIR = path.join(__dirname, "linkedin-generated-images");

const GOOGLE_NEWS_URL =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(
    '"job opening" OR hiring OR internship OR fellowship OR scholarship OR "apply now" career',
  ) +
  "&hl=en-US&gl=US&ceid=US:en";

const LINKEDIN_API = "https://api.linkedin.com/rest";
const LINKEDIN_OAUTH_AUTHORIZE =
  "https://www.linkedin.com/oauth/v2/authorization";
const LINKEDIN_OAUTH_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";

/* =======================================================
   VALIDATION
======================================================= */

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY is missing.");
  throw new Error("GROQ_API_KEY is missing.");
}
if (!LINKEDIN_CLIENT_ID) {
  console.error("❌ LINKEDIN_CLIENT_ID is missing.");
  throw new Error("LINKEDIN_CLIENT_ID is missing.");
}
if (!LINKEDIN_CLIENT_SECRET) {
  console.error("❌ LINKEDIN_CLIENT_SECRET is missing.");
  throw new Error("LINKEDIN_CLIENT_SECRET is missing.");
}
if (!LINKEDIN_REDIRECT_URI) {
  console.error("❌ LINKEDIN_REDIRECT_URI is missing.");
  throw new Error("LINKEDIN_REDIRECT_URI is missing.");
}
// <-- REMOVED LINKEDIN_ORG_URN check
if (!POST_TRIGGER_SECRET) {
  console.error("❌ LINKEDIN_POST_TRIGGER_SECRET is missing.");
  throw new Error("LINKEDIN_POST_TRIGGER_SECRET is missing.");
}
if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
  console.error("❌ Cloudflare credentials are missing.");
  throw new Error("Cloudflare credentials are missing.");
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

/* =======================================================
   HELPERS (unchanged)
======================================================= */
// ... (all helper functions remain the same: parsePositiveInteger, sleep, getLocalDate, stripEmojis, escapeHtml, fetchWithTimeout)

/* =======================================================
   MONGODB (unchanged)
======================================================= */
// ... connectMongo, disconnectMongo

/* =======================================================
   LINKEDIN TOKEN STORAGE (extended)
======================================================= */

async function getLinkedInToken() {
  if (!linkedinTokensCollection) return null;
  try {
    const token = await linkedinTokensCollection.findOne({
      provider: "linkedin",
    });
    return token || null;
  } catch (error) {
    console.warn("⚠️ Could not read LinkedIn token:", error.message);
    return null;
  }
}

async function saveLinkedInToken(data) {
  if (!linkedinTokensCollection) {
    console.warn("⚠️ MongoDB unavailable. LinkedIn token cannot be persisted.");
    return;
  }

  await linkedinTokensCollection.updateOne(
    { provider: "linkedin" },
    {
      $set: {
        provider: "linkedin",
        accessToken: data.accessToken,
        expiresAt: data.expiresAt || null,
        scope: data.scope || null,
        personUrn: data.personUrn || null, // <-- NEW: store person URN
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function clearLinkedInToken() {
  if (!linkedinTokensCollection) return;
  await linkedinTokensCollection.deleteOne({ provider: "linkedin" });
}

// <-- NEW: helper to get stored person URN
async function getLinkedInPersonUrn() {
  const token = await getLinkedInToken();
  return token?.personUrn || null;
}

/* =======================================================
   OAUTH STATE (unchanged)
======================================================= */
// ... (oauthStates map, createOAuthState, consumeOAuthState)

/* =======================================================
   LINKEDIN OAUTH (updated)
======================================================= */

function getLinkedInAuthorizationUrl() {
  const state = createOAuthState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: LINKEDIN_CLIENT_ID,
    redirect_uri: LINKEDIN_REDIRECT_URI,
    state,
    // <-- CHANGE: use w_member_social for individual posting
    scope: "openid profile email w_member_social",
  });

  return `${LINKEDIN_OAUTH_AUTHORIZE}?${params.toString()}`;
}

// <-- NEW: fetch person ID from userinfo endpoint
async function getLinkedInPersonId(accessToken) {
  const response = await fetchWithTimeout(
    "https://api.linkedin.com/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    10000,
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch user info: ${response.status} ${text}`);
  }
  const data = await response.json();
  // data.sub is the person ID (e.g., "123abc")
  if (!data.sub) throw new Error("No person ID returned from userinfo");
  return data.sub;
}

async function exchangeLinkedInCode(code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: LINKEDIN_REDIRECT_URI,
    client_id: LINKEDIN_CLIENT_ID,
    client_secret: LINKEDIN_CLIENT_SECRET,
  });

  const response = await fetchWithTimeout(
    LINKEDIN_OAUTH_TOKEN,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    30000,
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `LinkedIn token exchange failed: ${response.status} ${text}`,
    );
  }

  const json = JSON.parse(text);
  const accessToken = json.access_token;

  if (!accessToken) {
    throw new Error("LinkedIn did not return an access token.");
  }

  const expiresIn = Number(json.expires_in || 0);
  const expiresAt =
    expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

  // <-- Fetch person ID
  const personId = await getLinkedInPersonId(accessToken);
  const personUrn = `urn:li:person:${personId}`;

  await saveLinkedInToken({
    accessToken,
    expiresAt,
    scope: json.scope || null,
    personUrn, // <-- store it
  });

  return { accessToken, expiresAt, scope: json.scope || null, personUrn };
}

async function getValidLinkedInAccessToken() {
  const stored = await getLinkedInToken();
  if (!stored?.accessToken) return null;

  if (stored.expiresAt && new Date(stored.expiresAt) <= new Date()) {
    console.warn("⚠️ Stored LinkedIn token has expired.");
    await clearLinkedInToken();
    return null;
  }

  return stored.accessToken;
}

/* =======================================================
   HANDLE OAUTH CALLBACK (updated)
======================================================= */

async function handleLinkedInAuthCallback({ code, state, error }) {
  if (error) {
    return {
      statusCode: 400,
      html: `
<!doctype html>
<html><body>
<h2>LinkedIn authorization failed</h2>
<p>${escapeHtml(error)}</p>
</body></html>`,
    };
  }

  if (!code || !consumeOAuthState(state)) {
    return {
      statusCode: 400,
      html: `
<!doctype html>
<html><body>
<h2>Invalid OAuth request</h2>
<p>The authorization state is invalid or expired.</p>
</body></html>`,
    };
  }

  try {
    const result = await exchangeLinkedInCode(code);
    return {
      statusCode: 200,
      html: `
<!doctype html>
<html><head><title>LinkedIn Connected</title></head>
<body>
<h2>LinkedIn connected successfully.</h2>
<p>Your LinkedIn authorization token has been saved.</p>
<p>Person URN: ${escapeHtml(result.personUrn)}</p>
<p>You can close this window.</p>
</body></html>`,
    };
  } catch (error) {
    console.error("OAuth callback error:", error);
    return {
      statusCode: 500,
      html: `
<!doctype html>
<html><body>
<h2>LinkedIn connection failed</h2>
<p>${escapeHtml(error.message)}</p>
</body></html>`,
    };
  }
}

/* =======================================================
   TOPIC RESEARCH (unchanged)
======================================================= */
// ... (decodeXml, getXmlTag, shuffleArray, fingerprintTopic, storeTrendingTopics, pullTrendingTopic, researchOpportunities, selectTopic)

/* =======================================================
   GROQ (unchanged)
======================================================= */
// ... (POST_SCHEMA, normalizePost, callGeneration)

/* =======================================================
   VALIDATION (unchanged)
======================================================= */
// ... validatePost

/* =======================================================
   CLOUDFLARE IMAGE (unchanged)
======================================================= */
// ... buildImagePrompt, generateImageWithCloudflare, cleanupImage

/* =======================================================
   LINKEDIN API (updated to use person URN)
======================================================= */

async function linkedinRequest(url, options = {}) {
  const token = await getValidLinkedInAccessToken();

  if (!token) {
    throw new Error(
      "No valid LinkedIn access token. Visit /auth/linkedin first.",
    );
  }

  return fetchWithTimeout(
    url,
    {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        "Linkedin-Version": LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
        ...(options.headers || {}),
      },
    },
    60000,
  );
}

async function registerImageUpload() {
  const personUrn = await getLinkedInPersonUrn();
  if (!personUrn) {
    throw new Error("No person URN found. Please re-authenticate via /auth/linkedin.");
  }

  const response = await linkedinRequest(
    `${LINKEDIN_API}/images?action=initializeUpload`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        initializeUploadRequest: { owner: personUrn }, // <-- use person URN
      }),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `LinkedIn image initialization failed: ${response.status} ${text}`,
    );
  }

  const json = JSON.parse(text);
  const value = json.value || {};
  const uploadUrl = value.uploadUrl;
  const image = value.image;

  if (!uploadUrl || !image) {
    throw new Error(
      "LinkedIn image initialization returned no upload URL/image URN.",
    );
  }

  return { uploadUrl, image };
}

async function uploadImageBinary(uploadUrl, imagePath) {
  // no change – uses token from linkedinRequest already
  const token = await getValidLinkedInAccessToken();
  const buffer = await fs.readFile(imagePath);

  const response = await fetchWithTimeout(
    uploadUrl,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: buffer,
    },
    60000,
  );

  if (!response.ok && response.status !== 201) {
    throw new Error(
      `LinkedIn image upload failed: ${response.status} ${await response.text()}`,
    );
  }
}

async function createLinkedInPost(text, imageUrn = null) {
  const personUrn = await getLinkedInPersonUrn();
  if (!personUrn) {
    throw new Error("No person URN found. Please re-authenticate.");
  }

  const body = {
    author: personUrn, // <-- use person URN
    commentary: text,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  if (imageUrn) {
    body.content = {
      media: { altText: "Career opportunity", id: imageUrn },
    };
  }

  const response = await linkedinRequest(`${LINKEDIN_API}/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const textResponse = await response.text();

  if (!response.ok) {
    throw new Error(`LinkedIn post failed: ${response.status} ${textResponse}`);
  }

  const id = response.headers.get("x-restli-id");

  return {
    id: id || null,
    link: id
      ? `https://www.linkedin.com/feed/update/${encodeURIComponent(id)}/`
      : null,
  };
}

/* =======================================================
   PUBLISH (unchanged)
======================================================= */
// ... publishToLinkedIn (uses createLinkedInPost and image upload)

/* =======================================================
   STATE, HISTORY, MAIN CYCLE (unchanged)
======================================================= */
// ... loadState, saveState, runCycle, safeRunCycle, etc.
// All other functions remain the same – they don't rely on LINKEDIN_ORG_URN anymore.

/* =======================================================
   EXTERNAL ENTRY POINT (unchanged)
======================================================= */

async function runLinkedInBot() {
  await initializeLinkedInBot();
  return await safeRunCycle();
}

/* =======================================================
   STATUS & SHUTDOWN (updated to show person URN presence)
======================================================= */

async function getLinkedInStatus() {
  resetDailyCounter();

  const token = await getValidLinkedInAccessToken();
  const personUrn = await getLinkedInPersonUrn();

  return {
    service: "linkedin-ai-bot",
    version: "2.1.0",
    timezone: BOT_TIMEZONE,
    localDate: getLocalDate(),
    postsToday: state.postsToday,
    maxPostsPerDay: MAX_POSTS_PER_DAY,
    totalPosts: state.totalPosts,
    totalFailures: state.totalFailures,
    totalSkipped: state.totalSkipped,
    cycleRunning,
    dryRun: DRY_RUN,
    mongoConnected: Boolean(mongoClient),
    linkedinAuthorized: Boolean(token),
    personUrnStored: Boolean(personUrn), // <-- new
  };
}

async function shutdownLinkedInBot() {
  console.log("🛑 Shutting down LinkedIn bot...");
  try {
    await saveState();
  } catch {}
  await disconnectMongo();
  initialized = false;
  console.log("👋 LinkedIn bot shutdown complete.");
}

/* =======================================================
   EXPORTS
======================================================= */

export {
  runLinkedInBot,
  safeRunCycle,
  runCycle,
  initializeLinkedInBot,
  getLinkedInStatus,
  shutdownLinkedInBot,
  getLinkedInAuthorizationUrl,
  handleLinkedInAuthCallback,
  POST_TRIGGER_SECRET,
};