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
LINKEDIN AI BOT V2.0.0
MODULE EDITION
=========================================================

This file contains ONLY LinkedIn bot logic.
The HTTP server is handled by index.js.

index.js calls:

    GET  /auth/linkedin           -> getLinkedInAuthorizationUrl()
    GET  /auth/linkedin/callback  -> handleLinkedInAuthCallback()
    POST /linkedin/post           -> runLinkedInBot()
        ↓
    safeRunCycle()
        ↓
    runCycle()
        ↓
    LinkedIn Posts API

Bot logic (prompts, validation, publishing) is unchanged
from the standalone version — only the HTTP server was
removed.
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
const LINKEDIN_ORG_URN = process.env.LINKEDIN_ORG_URN;
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
if (!LINKEDIN_ORG_URN) {
  console.error("❌ LINKEDIN_ORG_URN is missing.");
  throw new Error("LINKEDIN_ORG_URN is missing.");
}
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
   HELPERS
======================================================= */

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) return number;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLocalDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function stripEmojis(text) {
  return String(text || "")
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu,
      "",
    )
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function fetchWithTimeout(
  url,
  options = {},
  timeout = REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* =======================================================
   MONGODB
======================================================= */

let mongoClient = null;
let trendingTopicsCollection = null;
let postHistoryCollection = null;
let linkedinTokensCollection = null;

let initialized = false;

async function connectMongo() {
  if (mongoClient) return;

  if (!MONGODB_URI) {
    console.warn("⚠️ [LinkedIn] MONGODB_URI missing. Running without MongoDB.");
    return;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
    await mongoClient.connect();

    const db = mongoClient.db(MONGODB_DB_NAME);

    trendingTopicsCollection = db.collection("linkedin_trending_topics");
    postHistoryCollection = db.collection("linkedin_post_history");
    linkedinTokensCollection = db.collection("linkedin_tokens");

    await trendingTopicsCollection.createIndex(
      { fingerprint: 1 },
      { unique: true },
    );
    await trendingTopicsCollection.createIndex({ used: 1, fetchedAt: -1 });
    await postHistoryCollection.createIndex({ publishedAt: -1 });
    await linkedinTokensCollection.createIndex({
      provider: 1,
      unique: true,
    });

    console.log("💾 [LinkedIn] MongoDB connected.");
  } catch (error) {
    console.warn("⚠️ [LinkedIn] MongoDB connection failed:", error.message);
    mongoClient = null;
  }
}

async function disconnectMongo() {
  try {
    if (mongoClient) await mongoClient.close();
    mongoClient = null;
    trendingTopicsCollection = null;
    postHistoryCollection = null;
    linkedinTokensCollection = null;
    console.log("💾 [LinkedIn] MongoDB connection closed.");
  } catch {}
}

/* =======================================================
   LINKEDIN TOKEN STORAGE
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

/* =======================================================
   OAUTH STATE
======================================================= */

const oauthStates = new Map();

function createOAuthState() {
  const state = crypto.randomBytes(32).toString("hex");
  oauthStates.set(state, { createdAt: Date.now() });
  return state;
}

function consumeOAuthState(state) {
  if (!state) return false;
  const record = oauthStates.get(state);
  if (!record) return false;
  oauthStates.delete(state);
  const maxAge = 10 * 60 * 1000;
  if (Date.now() - record.createdAt > maxAge) return false;
  return true;
}

/* =======================================================
   LINKEDIN OAUTH
======================================================= */

function getLinkedInAuthorizationUrl() {
  const state = createOAuthState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: LINKEDIN_CLIENT_ID,
    redirect_uri: LINKEDIN_REDIRECT_URI,
    state,
    scope: "openid profile email w_organization_social",
  });

  return `${LINKEDIN_OAUTH_AUTHORIZE}?${params.toString()}`;
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

  await saveLinkedInToken({
    accessToken,
    expiresAt,
    scope: json.scope || null,
  });

  return { accessToken, expiresAt, scope: json.scope || null };
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

/*
=========================================================
Handles GET /auth/linkedin/callback for index.js.
Returns { statusCode, html }.
=========================================================
*/
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
    await exchangeLinkedInCode(code);
    return {
      statusCode: 200,
      html: `
<!doctype html>
<html><head><title>LinkedIn Connected</title></head>
<body>
<h2>LinkedIn connected successfully.</h2>
<p>Your LinkedIn authorization token has been saved.</p>
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
   TOPIC RESEARCH
======================================================= */

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getXmlTag(xml, tag) {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  if (!match) return "";
  return decodeXml(stripHtml(match[1])).trim();
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function fingerprintTopic(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180);
}

async function storeTrendingTopics(items) {
  if (
    !trendingTopicsCollection ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return;
  }

  const operations = items.map((item) => ({
    updateOne: {
      filter: { fingerprint: fingerprintTopic(item.title) },
      update: {
        $setOnInsert: {
          fingerprint: fingerprintTopic(item.title),
          title: item.title,
          description: item.description,
          source: item.source,
          publishedAt: item.publishedAt,
          fetchedAt: new Date(),
          used: false,
          usedAt: null,
        },
      },
      upsert: true,
    },
  }));

  try {
    await trendingTopicsCollection.bulkWrite(operations, { ordered: false });
  } catch (error) {
    console.warn("⚠️ Topic storage failed:", error.message);
  }
}

async function pullTrendingTopic() {
  if (!trendingTopicsCollection) return null;

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);

  try {
    const result = await trendingTopicsCollection.findOneAndUpdate(
      { used: false, fetchedAt: { $gte: cutoff } },
      { $set: { used: true, usedAt: new Date() } },
      { sort: { fetchedAt: -1 }, returnDocument: "after" },
    );
    return result || null;
  } catch (error) {
    console.warn("⚠️ Topic pull failed:", error.message);
    return null;
  }
}

async function researchOpportunities() {
  console.log("\n🌐 [LinkedIn] Searching Google News RSS...");

  let news = [];

  try {
    const response = await fetchWithTimeout(GOOGLE_NEWS_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 LinkedInAI/2.0",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    });

    if (!response.ok) throw new Error(`Google News HTTP ${response.status}`);

    const xml = await response.text();
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

    for (const match of items.slice(0, 25)) {
      const item = match[1];
      const title = getXmlTag(item, "title");
      if (!title) continue;

      news.push({
        title: title.slice(0, 300),
        description: getXmlTag(item, "description").slice(0, 700),
        publishedAt: getXmlTag(item, "pubDate").slice(0, 100),
        source: getXmlTag(item, "source").slice(0, 150),
      });
    }

    shuffleArray(news);
    console.log(`   ✅ ${news.length} news items found.`);
    await storeTrendingTopics(news);
  } catch (error) {
    console.warn("   ⚠️ Research failed:", error.message);
  }

  return news;
}

async function selectTopic(newsItems) {
  const stored = await pullTrendingTopic();
  if (stored) return { ...stored, fromDb: true };

  if (Array.isArray(newsItems) && newsItems.length) {
    const selected = newsItems[Math.floor(Math.random() * newsItems.length)];
    return { ...selected, fromDb: false };
  }

  return null;
}

/* =======================================================
   GROQ
======================================================= */

const POST_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    type: {
      type: "string",
      enum: ["job", "internship", "scholarship", "fellowship"],
    },
    organization: { type: "string" },
    content: { type: "string" },
    imageQuery: { type: "string" },
    skip: { type: "boolean" },
    skipReason: { type: "string" },
  },
  required: [
    "title",
    "type",
    "organization",
    "content",
    "imageQuery",
    "skip",
    "skipReason",
  ],
  additionalProperties: false,
};

function normalizePost(post) {
  const allowedTypes = new Set([
    "job",
    "internship",
    "scholarship",
    "fellowship",
  ]);

  return {
    title: String(post?.title || "Career Opportunity")
      .trim()
      .slice(0, 150),
    type: allowedTypes.has(post?.type) ? post.type : "job",
    organization: String(post?.organization || "")
      .trim()
      .slice(0, 150),
    content: stripEmojis(String(post?.content || "").trim()),
    imageQuery: String(post?.imageQuery || "professional office workspace")
      .trim()
      .slice(0, 150),
    skip: Boolean(post?.skip),
    skipReason: String(post?.skipReason || "").trim(),
  };
}

async function callGeneration(prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`   🧠 Groq attempt ${attempt}/${retries}`);

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "user",
            content: `
You write professional LinkedIn Company Page posts about real jobs, internships, scholarships, and fellowships.

Audience:
Students and early-career professionals.

Language:
Simple A2-B1 English.

Tone:
Professional, useful, factual, human.

Rules:
- No emojis.
- No exclamation marks.
- No hype.
- Never invent a company.
- Never invent a deadline.
- Never invent a salary.
- Never invent an application URL.
- Only use information supported by the source.
- If the source is not a real opportunity listing, set skip=true.
- If important information is missing, keep the post general.
- Do not claim that an opportunity is currently open unless the source supports it.

POST FORMAT:

First line:
Organization + opportunity.

Then:

Requirements:
- requirement
- requirement
- requirement

How to apply:
One short sentence.

At the end:
Maximum 3 relevant hashtags.

IMAGE:
Create a generic image query for a professional non-branded scene.

SOURCE:
${prompt}
`,
          },
        ],
        temperature: 0.5,
        max_completion_tokens: 900,
        reasoning_effort: "low",
        reasoning_format: "hidden",
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "linkedin_post",
            strict: true,
            schema: POST_SCHEMA,
          },
        },
      });

      const raw = response?.choices?.[0]?.message?.content;
      if (!raw) throw new Error("Groq returned empty content.");

      return normalizePost(JSON.parse(raw));
    } catch (error) {
      console.warn(`   ⚠️ Groq attempt failed: ${error.message}`);
      if (attempt >= retries) throw error;
      await sleep(1500 * attempt);
    }
  }
}

/* =======================================================
   VALIDATION
======================================================= */

function validatePost(post) {
  const reasons = [];
  if (!post) return { valid: false, reasons: ["empty post"] };

  const content = String(post.content || "").trim();

  if (content.length < 60) reasons.push("post is too short");
  if (content.length > 3000) reasons.push("post is too long");
  if (!/requirements?/i.test(content))
    reasons.push("missing Requirements section");
  if (!/how to apply|apply/i.test(content))
    reasons.push("missing application section");

  const hashtags = content.match(/#[a-zA-Z0-9_]+/g) || [];
  if (hashtags.length > 3) reasons.push("too many hashtags");

  return { valid: reasons.length === 0, reasons };
}

/* =======================================================
   CLOUDFLARE IMAGE
======================================================= */

function buildImagePrompt(post) {
  return `
Create a realistic professional stock-photo-style image related to:

${post.imageQuery}

Requirements:
- professional career or education context
- realistic photography
- clean composition
- suitable for LinkedIn
- no text
- no logos
- no watermarks
- no brand names
- no recognizable public figures
- no close-up identifiable faces
- natural lighting
- horizontal composition
`;
}

async function generateImageWithCloudflare(post) {
  console.log("\n🎨 [LinkedIn] Generating image...");

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: buildImagePrompt(post) }),
    },
    120000,
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Cloudflare ${response.status}: ${text}`);
  }

  const contentType = response.headers.get("content-type") || "";
  let imageBuffer;

  if (contentType.includes("application/json")) {
    const json = await response.json();
    let b64 =
      json?.result?.image ||
      json?.result?.output ||
      json?.image ||
      json?.output;

    if (Array.isArray(b64)) b64 = b64[0];
    if (typeof b64 !== "string")
      throw new Error("Cloudflare returned no image data.");

    imageBuffer = Buffer.from(
      b64.replace(/^data:image\/[^;]+;base64,/i, ""),
      "base64",
    );
  } else {
    imageBuffer = Buffer.from(await response.arrayBuffer());
  }

  if (!imageBuffer || imageBuffer.length < 1000) {
    throw new Error("Invalid generated image.");
  }

  let finalBuffer = imageBuffer;

  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default;

    finalBuffer = await sharp(imageBuffer)
      .resize(1200, 627, { fit: "cover" })
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    console.log("ℹ️ sharp unavailable; using original image.");
  }

  await fs.mkdir(GENERATED_IMAGE_DIR, { recursive: true });

  const imagePath = path.join(
    GENERATED_IMAGE_DIR,
    `linkedin-${Date.now()}.jpg`,
  );

  await fs.writeFile(imagePath, finalBuffer);

  console.log(
    `   ✅ Image generated: ${(finalBuffer.length / 1024).toFixed(1)} KB`,
  );

  return imagePath;
}

async function cleanupImage(imagePath) {
  if (!imagePath) return;
  try {
    await fs.unlink(imagePath);
  } catch {}
}

/* =======================================================
   LINKEDIN API
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
  const response = await linkedinRequest(
    `${LINKEDIN_API}/images?action=initializeUpload`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        initializeUploadRequest: { owner: LINKEDIN_ORG_URN },
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
  const body = {
    author: LINKEDIN_ORG_URN,
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
   PUBLISH
======================================================= */

async function publishToLinkedIn(post, imagePath) {
  if (DRY_RUN) {
    console.log("\n🧪 DRY_RUN=true");
    console.log("\n----- POST -----\n");
    console.log(post.content);
    console.log("\n---------------\n");

    return { success: true, dryRun: true, id: null, link: null };
  }

  let imageUrn = null;

  if (imagePath) {
    try {
      const { uploadUrl, image } = await registerImageUpload();
      await uploadImageBinary(uploadUrl, imagePath);
      imageUrn = image;
      console.log("   ✅ LinkedIn image uploaded.");
      await sleep(3000);
    } catch (error) {
      console.warn("⚠️ Image upload failed.", error.message);
      console.log("   Continuing with text-only post.");
      imageUrn = null;
    }
  }

  const result = await createLinkedInPost(post.content, imageUrn);

  return {
    success: true,
    dryRun: false,
    id: result.id,
    link: result.link,
    imageGenerated: Boolean(imageUrn),
  };
}

/* =======================================================
   STATE
======================================================= */

function createDefaultState() {
  return {
    date: getLocalDate(),
    postsToday: 0,
    totalPosts: 0,
    totalFailures: 0,
    totalSkipped: 0,
    lastPostAt: null,
    lastTriggerAt: null,
    lastTriggerResult: null,
    history: [],
  };
}

let state = createDefaultState();

function normalizeState() {
  if (typeof state.date !== "string") state.date = getLocalDate();
  if (!Number.isFinite(state.postsToday)) state.postsToday = 0;
  if (!Number.isFinite(state.totalPosts)) state.totalPosts = 0;
  if (!Number.isFinite(state.totalFailures)) state.totalFailures = 0;
  if (!Number.isFinite(state.totalSkipped)) state.totalSkipped = 0;
  if (!Array.isArray(state.history)) state.history = [];
  state.history = state.history.slice(-MAX_HISTORY);
}

let stateSaveRunning = Promise.resolve();

async function saveState() {
  stateSaveRunning = stateSaveRunning
    .catch(() => {})
    .then(async () => {
      const tempFile = `${STATE_FILE}.tmp`;
      await fs.writeFile(tempFile, JSON.stringify(state, null, 2), "utf8");
      try {
        await fs.copyFile(STATE_FILE, STATE_BACKUP_FILE);
      } catch {}
      await fs.rename(tempFile, STATE_FILE);
    });

  return stateSaveRunning;
}

function resetDailyCounter() {
  const today = getLocalDate();
  if (state.date !== today) {
    state.date = today;
    state.postsToday = 0;
    saveState().catch(() => {});
  }
}

async function loadState() {
  let loaded = false;

  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      state = { ...createDefaultState(), ...parsed };
      loaded = true;
    }
  } catch {}

  if (!loaded) {
    try {
      const raw = await fs.readFile(STATE_BACKUP_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        state = { ...createDefaultState(), ...parsed };
        loaded = true;
      }
    } catch {}
  }

  normalizeState();
  resetDailyCounter();

  if (!loaded) await saveState();
}

/* =======================================================
   POST HISTORY
======================================================= */

function getRecentPostMemory() {
  return state.history
    .slice(-15)
    .map((post) => String(post.title || "").slice(0, 150))
    .join("\n");
}

async function storePostHistory(post, result) {
  if (!postHistoryCollection) return;

  try {
    await postHistoryCollection.insertOne({
      id: result?.id || null,
      title: post.title || null,
      type: post.type || "job",
      text: post.content,
      publishedAt: new Date(),
      dryRun: Boolean(result?.dryRun),
    });
  } catch (error) {
    console.warn("⚠️ Post history failed:", error.message);
  }
}

async function savePost(post, result) {
  state.history.push({
    id: result?.id || null,
    title: post.title,
    type: post.type,
    text: post.content,
    imageGenerated: Boolean(result?.imageGenerated),
    publishedAt: new Date().toISOString(),
    dryRun: Boolean(result?.dryRun),
  });

  state.history = state.history.slice(-MAX_HISTORY);

  if (!result?.dryRun) {
    state.postsToday++;
    state.totalPosts++;
    state.lastPostAt = new Date().toISOString();
  }

  await saveState();
  await storePostHistory(post, result);
}

/* =======================================================
   MAIN CYCLE
======================================================= */

let cycleRunning = false;

async function runCycle() {
  resetDailyCounter();

  console.log("\n================================================");
  console.log("🚀 LINKEDIN AI BOT V2.0.0");
  console.log("================================================");
  console.log(
    `🕐 ${new Date().toLocaleString("en-US", { timeZone: BOT_TIMEZONE })}`,
  );
  console.log(`📅 Posts: ${state.postsToday}/${MAX_POSTS_PER_DAY}`);

  if (state.postsToday >= MAX_POSTS_PER_DAY) {
    console.log("🛑 Daily limit reached.");
    state.totalSkipped++;
    await saveState();
    return { success: false, skipped: true, reason: "daily_limit" };
  }

  try {
    const token = await getValidLinkedInAccessToken();

    if (!token) {
      throw new Error("LinkedIn is not authorized. Open /auth/linkedin first.");
    }

    const news = await researchOpportunities();
    const selectedTopic = await selectTopic(news);
    const recentPosts = getRecentPostMemory();

    let researchBlock = "NO CURRENT LISTING FOUND.";

    if (selectedTopic) {
      researchBlock = `
Headline:
${selectedTopic.title}

Description:
${selectedTopic.description || ""}

Published:
${selectedTopic.publishedAt || ""}

Source:
${selectedTopic.source || "Unknown"}
`;
    }

    const prompt = `
CURRENT NEWS / LISTING:

${researchBlock}

RECENT POSTS:
${recentPosts || "None"}
`;

    const post = await callGeneration(prompt, 3);

    if (post.skip) {
      console.log("⏭️ AI skipped:", post.skipReason);
      state.totalSkipped++;
      await saveState();
      return {
        success: false,
        skipped: true,
        reason: post.skipReason || "ai_skip",
      };
    }

    console.log("\n📝 Title:", post.title);
    console.log("🏢 Organization:", post.organization);
    console.log("🏷️ Type:", post.type);

    const validation = validatePost(post);

    if (!validation.valid) {
      console.error("❌ Validation failed:", validation.reasons.join(", "));
      state.totalSkipped++;
      await saveState();
      return {
        success: false,
        skipped: true,
        reason: "validation_failed",
        validation: validation.reasons,
      };
    }

    let imagePath = null;

    try {
      imagePath = await generateImageWithCloudflare(post);
    } catch (error) {
      console.warn("⚠️ Image generation failed:", error.message);
    }

    let result;

    try {
      result = await publishToLinkedIn(post, imagePath);
    } finally {
      await cleanupImage(imagePath);
    }

    await savePost(post, result);

    console.log("\n✅ CYCLE COMPLETED");
    if (result.id) console.log(`🆔 ${result.id}`);
    if (result.link) console.log(`🔗 ${result.link}`);

    return {
      success: true,
      id: result.id,
      link: result.link,
      dryRun: Boolean(result.dryRun),
    };
  } catch (error) {
    state.totalFailures++;
    await saveState();
    console.error("\n❌ Cycle error:", error?.stack || error?.message || error);
    return { success: false, error: error?.message || "Unknown error" };
  }
}

async function safeRunCycle() {
  if (cycleRunning) {
    return { success: false, error: "A post cycle is already running." };
  }

  cycleRunning = true;

  try {
    return await runCycle();
  } finally {
    cycleRunning = false;
  }
}

/* =======================================================
   INITIALIZATION
======================================================= */

async function initializeLinkedInBot() {
  if (initialized) return;

  console.log("\n==============================================");
  console.log("🤖 INITIALIZING LINKEDIN BOT");
  console.log("==============================================");

  await connectMongo();
  await loadState();

  console.log(`🧠 Groq: ${GROQ_MODEL}`);
  console.log(`🔐 LinkedIn OAuth: enabled`);
  console.log(`🏢 Organization: ${LINKEDIN_ORG_URN}`);
  console.log(`📡 LinkedIn API: ${LINKEDIN_VERSION}`);
  console.log(`🎨 Cloudflare: ${CLOUDFLARE_IMAGE_MODEL}`);
  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  console.log(`🎯 Daily limit: ${MAX_POSTS_PER_DAY}`);

  const token = await getValidLinkedInAccessToken();
  console.log(`🔑 LinkedIn authorized: ${token ? "YES" : "NO"}`);

  initialized = true;
  console.log("✅ LinkedIn bot initialized.");
}

/* =======================================================
   EXTERNAL ENTRY POINT

index.js calls:

    runLinkedInBot()

This initializes MongoDB/state once and then
runs one LinkedIn posting cycle.
======================================================= */

async function runLinkedInBot() {
  await initializeLinkedInBot();
  return await safeRunCycle();
}

/* =======================================================
   OPTIONAL STATUS
======================================================= */

async function getLinkedInStatus() {
  resetDailyCounter();

  const token = await getValidLinkedInAccessToken();

  return {
    service: "linkedin-ai-bot",
    version: "2.0.0",
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
  };
}

/* =======================================================
   SHUTDOWN SUPPORT
======================================================= */

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
