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
LINKEDIN AI OPPORTUNITY BOT V4.4.0
=========================================================

FIXES:
  1. Removed all deprecated Groq models.
  2. Uses current GPT-OSS models only.
  3. Uses strict Groq JSON Schema output.
  4. Explicitly tells the AI to return structured JSON.
  5. Better organization extraction.
  6. Better role/title extraction.
  7. Prevents publisher names from becoming organizations.
  8. Prevents Google News wrapper URLs from being published
     as application URLs.
  9. Better Google News article extraction.
 10. Better fallback generation when AI fails.
 11. Better LinkedIn post formatting.
 12. Keeps Cloudflare image generation.
 13. Keeps LinkedIn image upload.
 14. Keeps MongoDB token/state/history.
 15. Keeps OAuth.
 16. Keeps daily limits.
 17. Keeps duplicate prevention.
 18. Keeps graceful shutdown.
=========================================================
*/

const BOT_VERSION = "4.4.0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================================================
   CONFIG
======================================================= */

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const GROQ_FALLBACK_MODELS = [
  GROQ_MODEL,
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
];

const MONGODB_URI = process.env.MONGODB_URI;

const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "Binance-Square-Bot";

const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;

const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;

const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI;

const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || "202606";

const LINKEDIN_API = "https://api.linkedin.com/rest";

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

/* =======================================================
   RSS SOURCES
======================================================= */

const RSS_SOURCES = [
  {
    name: "Google News Jobs",
    type: "job",
    url:
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(
        '"software engineer" OR "developer" OR "software developer" hiring Pakistan',
      ) +
      "&hl=en-PK&gl=PK&ceid=PK:en",
  },

  {
    name: "Google News Internships",
    type: "internship",
    url:
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(
        "software internship OR developer internship OR tech internship",
      ) +
      "&hl=en-PK&gl=PK&ceid=PK:en",
  },

  {
    name: "Google News Scholarships",
    type: "scholarship",
    url:
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(
        "scholarship international students 2026 OR scholarship 2027",
      ) +
      "&hl=en-PK&gl=PK&ceid=PK:en",
  },

  {
    name: "Google News Remote Jobs",
    type: "job",
    url:
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(
        "remote software developer job OR remote software engineer job",
      ) +
      "&hl=en-PK&gl=PK&ceid=PK:en",
  },
];

/* =======================================================
   VALIDATION
======================================================= */

if (!GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is missing.");
}

if (!LINKEDIN_CLIENT_ID) {
  throw new Error("LINKEDIN_CLIENT_ID is missing.");
}

if (!LINKEDIN_CLIENT_SECRET) {
  throw new Error("LINKEDIN_CLIENT_SECRET is missing.");
}

if (!LINKEDIN_REDIRECT_URI) {
  throw new Error("LINKEDIN_REDIRECT_URI is missing.");
}

if (!POST_TRIGGER_SECRET) {
  throw new Error("POST_TRIGGER_SECRET is missing.");
}

if (!CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID is missing.");
}

if (!CLOUDFLARE_API_TOKEN) {
  throw new Error("CLOUDFLARE_API_TOKEN is missing.");
}

const groq = new Groq({
  apiKey: GROQ_API_KEY,
});

/* =======================================================
   HELPERS
======================================================= */

function parsePositiveInteger(value, fallback) {
  const number = Number(value);

  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function shuffleArray(array) {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url) {
  if (!url) return "";

  let value = String(url).trim();

  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1);
  }

  return value;
}

function isRealUrl(url) {
  try {
    const parsed = new URL(url);

    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isGoogleNewsWrapperUrl(url) {
  try {
    const parsed = new URL(url);

    return /(^|\.)news\.google\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

function toShortHashtag(value, maxWords = 3, maxLen = 24) {
  const words = cleanText(value)
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);

  const tag = words.join("").slice(0, maxLen);

  return tag ? `#${tag}` : "";
}

/* =======================================================
   TITLE / ORGANIZATION CLEANING
======================================================= */

const KNOWN_PUBLISHERS = [
  "edugist.org",
  "edugist",
  "opportunity desk",
  "scholarship positions",
  "scholars4dev",
  "we make scholars",
  "afterschoolafrica",
  "opportunities for youth",
  "study international",
  "find a scholarship",
  "study abroad",
  "careerindia",
  "indeed",
  "linkedin",
  "glassdoor",
  "ziprecruiter",
  "jobstreet",
  "rozee.pk",
];

function isKnownPublisher(value) {
  const normalized = cleanText(value)
    .toLowerCase()
    .replace(/^www\./, "");

  return KNOWN_PUBLISHERS.some(
    (publisher) => normalized === publisher || normalized.includes(publisher),
  );
}

function stripTrailingPublisher(title) {
  let text = cleanText(title);

  if (!text) return "";

  for (const publisher of KNOWN_PUBLISHERS) {
    const escaped = publisher.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const pattern = new RegExp(`\\s*[-|–—]\\s*${escaped}\\s*$`, "i");

    text = text.replace(pattern, "");
  }

  return cleanText(text);
}

function stripTrailingOrgSuffix(title, org) {
  let text = cleanText(title);

  if (!text) return "";

  text = stripTrailingPublisher(text);

  if (org) {
    const escaped = String(org).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const pattern = new RegExp(`\\s*[-|–—]\\s*${escaped}\\s*$`, "i");

    text = text.replace(pattern, "");
  }

  return cleanText(text);
}

function inferOrganizationFromOpportunity(opportunity) {
  const title = stripTrailingPublisher(opportunity?.title || "");

  const description = cleanText(opportunity?.description || "");

  const source = cleanText(opportunity?.source || "");

  /*
   * Never blindly use source as organization.
   */

  const combined = `${title} ${description}`;

  const explicitPatterns = [
    /(?:offered|provided|organized|hosted|funded|sponsored)\s+by\s+([A-Z][A-Za-z0-9&.,'() -]{2,100})/i,

    /(?:from|by)\s+([A-Z][A-Za-z0-9&.,'() -]{2,100})\s+(?:for|to|in)/i,

    /^([A-Z][A-Za-z0-9&.,'() -]{2,100})\s+(?:is\s+)?(?:hiring|offering|announces|opens|launches)/i,
  ];

  for (const pattern of explicitPatterns) {
    const match = combined.match(pattern);

    if (match?.[1]) {
      const candidate = cleanText(match[1].replace(/[|–—-]\s*$/, "").trim());

      if (
        candidate.length >= 3 &&
        candidate.length <= 150 &&
        !isKnownPublisher(candidate)
      ) {
        return candidate;
      }
    }
  }

  /*
   * Try scholarship title patterns.
   */

  const scholarshipPatterns = [
    /^(.+?)\s+(?:scholarship|fellowship)\b/i,
    /^(.+?)\s+(?:fully funded|funded)\b/i,
  ];

  for (const pattern of scholarshipPatterns) {
    const match = title.match(pattern);

    if (match?.[1]) {
      const candidate = cleanText(match[1]);

      if (
        candidate.length >= 3 &&
        candidate.length <= 120 &&
        !isKnownPublisher(candidate)
      ) {
        return candidate;
      }
    }
  }

  return "";
}

/* =======================================================
   MONGODB
======================================================= */

let mongoClient = null;
let opportunitiesCollection = null;
let postHistoryCollection = null;
let linkedinTokensCollection = null;
let initialized = false;

async function connectMongo() {
  if (mongoClient) return;

  if (!MONGODB_URI) {
    console.warn("⚠️ MongoDB URI missing. Running without MongoDB.");

    return;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
    });

    await mongoClient.connect();

    const db = mongoClient.db(MONGODB_DB_NAME);

    opportunitiesCollection = db.collection("linkedin_opportunities");

    postHistoryCollection = db.collection("linkedin_post_history");

    linkedinTokensCollection = db.collection("linkedin_tokens");

    await opportunitiesCollection.createIndex(
      { fingerprint: 1 },
      { unique: true },
    );

    await opportunitiesCollection.createIndex({
      fetchedAt: -1,
    });

    await opportunitiesCollection.createIndex({
      used: 1,
      fetchedAt: -1,
    });

    await postHistoryCollection.createIndex({
      publishedAt: -1,
    });

    await linkedinTokensCollection.createIndex(
      { provider: 1 },
      { unique: true },
    );

    console.log("💾 MongoDB connected.");
  } catch (error) {
    console.warn("⚠️ MongoDB connection failed:", error.message);

    mongoClient = null;
    opportunitiesCollection = null;
    postHistoryCollection = null;
    linkedinTokensCollection = null;
  }
}

async function disconnectMongo() {
  try {
    if (mongoClient) {
      await mongoClient.close();
    }
  } catch {}

  mongoClient = null;
  opportunitiesCollection = null;
  postHistoryCollection = null;
  linkedinTokensCollection = null;
}

/* =======================================================
   LINKEDIN TOKEN STORAGE
======================================================= */

async function getLinkedInToken() {
  if (!linkedinTokensCollection) {
    return null;
  }

  try {
    return await linkedinTokensCollection.findOne({
      provider: "linkedin",
    });
  } catch {
    return null;
  }
}

async function saveLinkedInToken(data) {
  if (!linkedinTokensCollection) {
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
        personUrn: data.personUrn || null,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function clearLinkedInToken() {
  if (!linkedinTokensCollection) {
    return;
  }

  await linkedinTokensCollection.deleteOne({
    provider: "linkedin",
  });
}

async function getLinkedInPersonUrn() {
  const token = await getLinkedInToken();

  return token?.personUrn || null;
}

async function getValidLinkedInAccessToken() {
  const stored = await getLinkedInToken();

  if (!stored?.accessToken) {
    return null;
  }

  if (stored.expiresAt && new Date(stored.expiresAt) <= new Date()) {
    console.warn("⚠️ Stored LinkedIn token expired.");

    await clearLinkedInToken();

    return null;
  }

  return stored.accessToken;
}

/* =======================================================
   OAUTH
======================================================= */

const oauthStates = new Map();

function createOAuthState() {
  const state = crypto.randomBytes(32).toString("hex");

  oauthStates.set(state, {
    createdAt: Date.now(),
  });

  return state;
}

function consumeOAuthState(state) {
  if (!state) {
    return false;
  }

  const record = oauthStates.get(state);

  if (!record) {
    return false;
  }

  oauthStates.delete(state);

  const maxAge = 10 * 60 * 1000;

  return Date.now() - record.createdAt < maxAge;
}

function getLinkedInAuthorizationUrl() {
  const state = createOAuthState();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: LINKEDIN_CLIENT_ID,
    redirect_uri: LINKEDIN_REDIRECT_URI,
    state,
    scope: "openid profile email w_member_social",
  });

  return "https://www.linkedin.com/oauth/v2/authorization?" + params.toString();
}

async function getLinkedInPersonId(accessToken) {
  const response = await fetchWithTimeout(
    "https://api.linkedin.com/v2/userinfo",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    10000,
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch LinkedIn user info: ${response.status} ${text}`,
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("LinkedIn userinfo returned invalid JSON.");
  }

  if (!data.sub) {
    throw new Error("No person ID returned from LinkedIn userinfo.");
  }

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
    "https://www.linkedin.com/oauth/v2/accessToken",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
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

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("LinkedIn token endpoint returned invalid JSON.");
  }

  if (!json.access_token) {
    throw new Error("LinkedIn did not return an access token.");
  }

  const expiresIn = Number(json.expires_in || 0);

  const expiresAt =
    expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

  const personId = await getLinkedInPersonId(json.access_token);

  const personUrn = `urn:li:person:${personId}`;

  await saveLinkedInToken({
    accessToken: json.access_token,
    expiresAt,
    scope: json.scope || null,
    personUrn,
  });

  return {
    accessToken: json.access_token,
    expiresAt,
    scope: json.scope || null,
    personUrn,
  };
}

async function handleLinkedInAuthCallback({ code, state, error }) {
  if (error) {
    return {
      statusCode: 400,
      html: `
<!doctype html>
<html>
<head>
<title>LinkedIn Authorization Failed</title>
</head>
<body>
<h2>LinkedIn authorization failed</h2>
<p>${escapeHtml(error)}</p>
</body>
</html>
`,
    };
  }

  if (!code || !consumeOAuthState(state)) {
    return {
      statusCode: 400,
      html: `
<!doctype html>
<html>
<head>
<title>Invalid OAuth Request</title>
</head>
<body>
<h2>Invalid OAuth request</h2>
<p>The authorization state is invalid or expired.</p>
</body>
</html>
`,
    };
  }

  try {
    const result = await exchangeLinkedInCode(code);

    return {
      statusCode: 200,
      html: `
<!doctype html>
<html>
<head>
<title>LinkedIn Connected</title>
</head>
<body>
<h2>LinkedIn connected successfully.</h2>
<p>Person URN: ${escapeHtml(result.personUrn)}</p>
<p>You can close this window.</p>
</body>
</html>
`,
    };
  } catch (error) {
    console.error("OAuth callback error:", error);

    return {
      statusCode: 500,
      html: `
<!doctype html>
<html>
<head>
<title>LinkedIn Connection Failed</title>
</head>
<body>
<h2>LinkedIn connection failed</h2>
<p>${escapeHtml(error.message)}</p>
</body>
</html>
`,
    };
  }
}

/* =======================================================
   XML / RSS
======================================================= */

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#x3D;/gi, "=")
    .replace(/&#(\d+);/gi, (_, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return _;
      }
    });
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(header|footer|nav|aside|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getXmlTag(xml, tag) {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );

  if (!match) {
    return "";
  }

  return decodeXml(stripHtml(match[1])).trim();
}

function getXmlLink(xml) {
  const atomLink = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);

  if (atomLink?.[1]) {
    return decodeXml(atomLink[1]);
  }

  return getXmlTag(xml, "link");
}

function fingerprintOpportunity(title, url) {
  return `${String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180)}|${String(url || "")
    .toLowerCase()
    .trim()
    .slice(0, 300)}`;
}

function inferOpportunityType(title, description, fallback) {
  const text = `${title} ${description}`.toLowerCase();

  if (/scholarship|scholarships|funded study|fully funded/.test(text)) {
    return "scholarship";
  }

  if (/fellowship|fellowships/.test(text)) {
    return "fellowship";
  }

  if (/internship|intern|trainee|summer program/.test(text)) {
    return "internship";
  }

  if (/graduate program|graduate scheme|graduate opportunity/.test(text)) {
    return "job";
  }

  if (
    /job|jobs|hiring|developer|engineer|analyst|designer|manager|vacancy|vacancies|career/.test(
      text,
    )
  ) {
    return "job";
  }

  return fallback || "opportunity";
}

/* =======================================================
   RSS FETCH
======================================================= */

async function fetchRssSource(source) {
  console.log(`\n   🔎 ${source.name}`);

  try {
    const response = await fetchWithTimeout(
      source.url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 LinkedInOpportunityBot/4.4",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
      },
      20000,
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();

    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

    const opportunities = [];

    for (const match of items.slice(0, 35)) {
      const item = match[1];

      const title = cleanText(getXmlTag(item, "title"));

      if (!title) continue;

      const description = cleanText(getXmlTag(item, "description"));

      const publishedAt = getXmlTag(item, "pubDate");

      const link = normalizeUrl(getXmlLink(item));

      const sourceName = cleanText(getXmlTag(item, "source")) || source.name;

      const type = inferOpportunityType(title, description, source.type);

      opportunities.push({
        title: title.slice(0, 400),
        description: description.slice(0, 5000),
        publishedAt: publishedAt.slice(0, 100),
        source: sourceName.slice(0, 200),
        url: link,
        type,
        fetchedAt: new Date(),
        used: false,
      });
    }

    console.log(`      ✅ ${opportunities.length} recent opportunities`);

    return opportunities;
  } catch (error) {
    console.warn(`      ⚠️ Feed failed: ${error.message}`);

    return [];
  }
}

async function researchOpportunities() {
  console.log("\n🌐 Searching recent opportunities...");

  let all = [];

  for (const source of RSS_SOURCES) {
    const results = await fetchRssSource(source);

    all.push(...results);

    await sleep(200);
  }

  const unique = new Map();

  for (const item of all) {
    const key = fingerprintOpportunity(item.title, item.url);

    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }

  let opportunities = Array.from(unique.values());

  opportunities.sort((a, b) => {
    const da = Date.parse(a.publishedAt) || 0;

    const db = Date.parse(b.publishedAt) || 0;

    return db - da;
  });

  const maxAge = Date.now() - 14 * 24 * 60 * 60 * 1000;

  opportunities = opportunities.filter((item) => {
    const timestamp = Date.parse(item.publishedAt);

    if (!Number.isFinite(timestamp)) {
      return true;
    }

    return timestamp >= maxAge;
  });

  opportunities = shuffleArray(opportunities.slice(0, 100));

  console.log(
    `\n📊 Total unique recent opportunities: ${opportunities.length}`,
  );

  const categories = opportunities.reduce((acc, item) => {
    acc[item.type] = (acc[item.type] || 0) + 1;

    return acc;
  }, {});

  console.log("📌 Categories:", categories);

  await storeOpportunities(opportunities);

  return opportunities;
}

async function storeOpportunities(items) {
  if (!opportunitiesCollection || !Array.isArray(items) || !items.length) {
    return;
  }

  const operations = items.map((item) => {
    const fingerprint = fingerprintOpportunity(item.title, item.url);

    return {
      updateOne: {
        filter: { fingerprint },

        update: {
          $setOnInsert: {
            ...item,
            fingerprint,
          },
        },

        upsert: true,
      },
    };
  });

  try {
    await opportunitiesCollection.bulkWrite(operations, {
      ordered: false,
    });

    console.log(`💾 Stored ${items.length} opportunities.`);
  } catch (error) {
    console.warn("⚠️ Opportunity storage failed:", error.message);
  }
}

/* =======================================================
   HTML EXTRACTION
======================================================= */

function extractMetaContent(html, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${escapedName}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i",
    ),

    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${escapedName}["'][^>]*>`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return decodeXml(match[1]);
    }
  }

  return "";
}

function extractCanonicalUrl(html) {
  const patterns = [
    /<link[^>]+rel=["'][^"']*canonical[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*canonical[^"']*["'][^>]*>/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1]) {
      return decodeXml(match[1]).trim();
    }
  }

  return "";
}

function extractPageText(html) {
  let cleaned = String(html || "");

  cleaned = cleaned.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");

  cleaned = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");

  cleaned = cleaned.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  cleaned = cleaned.replace(
    /<(header|footer|nav|aside|svg|form)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );

  cleaned = cleaned.replace(/<[^>]*>/g, " ");

  cleaned = decodeXml(cleaned);

  cleaned = cleaned.replace(/\s+/g, " ");

  return cleaned.trim();
}

/* =======================================================
   SOURCE ENRICHMENT
======================================================= */

async function enrichOpportunity(opportunity) {
  const base = {
    ...opportunity,
  };

  if (!opportunity.url || !isRealUrl(opportunity.url)) {
    return base;
  }

  try {
    console.log(`   🔗 Reading source: ${opportunity.url.slice(0, 120)}...`);

    const response = await fetchWithTimeout(
      opportunity.url,
      {
        redirect: "follow",

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",

          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      20000,
    );

    if (!response.ok) {
      console.warn(`   ⚠️ Source page HTTP ${response.status}`);

      return base;
    }

    const finalUrl = response.url || opportunity.url;

    if (isGoogleNewsWrapperUrl(finalUrl)) {
      console.log("   ℹ️ Final URL is still a Google News wrapper.");

      return {
        ...base,
        finalUrl,
      };
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/html")) {
      return {
        ...base,
        finalUrl,
      };
    }

    const html = await response.text();

    const title =
      extractMetaContent(html, "og:title") ||
      extractMetaContent(html, "twitter:title") ||
      cleanText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");

    const description =
      extractMetaContent(html, "og:description") ||
      extractMetaContent(html, "description");

    const canonicalUrl = extractCanonicalUrl(html);

    const pageText = extractPageText(html);

    const sourceText = [title, description, pageText]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 18000);

    if (sourceText.length > 500) {
      console.log(`   ✅ Source enriched (${sourceText.length} chars)`);
    } else {
      console.log("   ⚠️ Source contains little readable information.");
    }

    return {
      ...base,
      finalUrl,
      canonicalUrl:
        isRealUrl(canonicalUrl) && !isGoogleNewsWrapperUrl(canonicalUrl)
          ? canonicalUrl
          : "",
      pageTitle: cleanText(title),
      pageDescription: cleanText(description),
      sourceText,
    };
  } catch (error) {
    console.warn("   ⚠️ Source enrichment failed:", error.message);

    return base;
  }
}

/* =======================================================
   AI SCHEMA
======================================================= */

const OPPORTUNITY_SCHEMA = {
  type: "object",

  properties: {
    organization: {
      type: "string",
    },

    role: {
      type: "string",
    },

    type: {
      type: "string",

      enum: ["job", "internship", "scholarship", "fellowship", "opportunity"],
    },

    requirements: {
      type: "array",
      items: {
        type: "string",
      },
    },

    benefits: {
      type: "array",
      items: {
        type: "string",
      },
    },

    eligibility: {
      type: "array",
      items: {
        type: "string",
      },
    },

    location: {
      type: "string",
    },

    deadline: {
      type: "string",
    },

    applicationMethod: {
      type: "string",
    },

    applicationUrl: {
      type: "string",
    },

    hashtags: {
      type: "array",
      items: {
        type: "string",
      },
    },

    content: {
      type: "string",
    },
  },

  required: [
    "organization",
    "role",
    "type",
    "requirements",
    "benefits",
    "eligibility",
    "location",
    "deadline",
    "applicationMethod",
    "applicationUrl",
    "hashtags",
    "content",
  ],

  additionalProperties: false,
};

/* =======================================================
   AI PROMPT
======================================================= */

function buildGenerationPrompt(opportunity) {
  return `
You are an expert LinkedIn career opportunity editor.

Return ONLY the JSON object required by the supplied JSON schema.

Your job is to extract accurate information from the opportunity and create a useful LinkedIn post.

IMPORTANT RULES:

1. Use ONLY information explicitly contained in the supplied data.
2. NEVER invent requirements.
3. NEVER invent benefits.
4. NEVER invent eligibility requirements.
5. NEVER invent deadlines.
6. NEVER invent salaries.
7. NEVER invent locations.
8. NEVER invent application instructions.
9. If information is missing, return an empty string or empty array.
10. Identify the REAL organization offering the opportunity.
11. Do NOT use the news publisher as the organization.
12. Publishers include sites such as edugist.org, Opportunity Desk, Scholarship Positions, Scholars4Dev, etc.
13. The "role" field must contain ONLY the opportunity/job/scholarship title.
14. Remove publisher names from the role.
15. Do not put the organization name into the role unless it is genuinely part of the official opportunity title.
16. The content must be 3-5 useful short sentences.
17. Do not merely repeat the title.
18. The content should be professional and suitable for LinkedIn.
19. Hashtags must be short and readable.
20. Do not create hashtags from the entire headline.
21. Do not place URLs inside content.
22. applicationUrl must be empty if there is no reliable direct URL.
23. NEVER use a news.google.com URL as applicationUrl.
24. If the only available URL is a Google News wrapper, leave applicationUrl empty.
25. If the source text contains a direct application URL, use it.
26. If the source contains the actual provider website, use that URL.
27. Preserve exact dates when available.
28. Do not claim that an opportunity is fully funded unless the source explicitly says so.

OPPORTUNITY DATA:

TITLE:
${opportunity.title || ""}

DESCRIPTION:
${opportunity.description || ""}

RSS SOURCE:
${opportunity.source || ""}

RSS TYPE:
${opportunity.type || ""}

ORIGINAL URL:
${opportunity.url || ""}

FINAL URL:
${opportunity.finalUrl || ""}

CANONICAL URL:
${opportunity.canonicalUrl || ""}

PAGE TITLE:
${opportunity.pageTitle || ""}

PAGE DESCRIPTION:
${opportunity.pageDescription || ""}

SOURCE PAGE TEXT:
${opportunity.sourceText || ""}

Extract the best possible structured information.
`;
}

/* =======================================================
   NORMALIZE AI RESULT
======================================================= */

function normalizeOpportunity(result, opportunity) {
  const allowedTypes = new Set([
    "job",
    "internship",
    "scholarship",
    "fellowship",
    "opportunity",
  ]);

  const cleanArray = (value) => {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => cleanText(item))
      .filter(Boolean)
      .slice(0, 12);
  };

  let rawOrg = cleanText(result?.organization);

  if (!rawOrg || isKnownPublisher(rawOrg)) {
    rawOrg = inferOrganizationFromOpportunity(opportunity);
  }

  let rawRole = cleanText(result?.role);

  if (!rawRole) {
    rawRole = stripTrailingOrgSuffix(opportunity?.title, rawOrg);
  }

  rawRole = stripTrailingPublisher(rawRole);

  if (rawOrg && rawRole) {
    const escaped = rawOrg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    rawRole = rawRole.replace(
      new RegExp(`\\s*[-|–—]\\s*${escaped}\\s*$`, "i"),
      "",
    );

    rawRole = rawRole.replace(
      new RegExp(`^${escaped}\\s*[-|–—:]\\s*`, "i"),
      "",
    );

    rawRole = cleanText(rawRole);
  }

  if (!rawOrg) {
    rawOrg = "Opportunity Provider";
  }

  if (!rawRole) {
    rawRole = "Career Opportunity";
  }

  const hashtags = cleanArray(result?.hashtags)
    .map((tag) => {
      const clean = String(tag)
        .replace(/^#+/, "")
        .replace(/[^a-zA-Z0-9_]/g, "")
        .slice(0, 24);

      return clean ? `#${clean}` : "";
    })
    .filter(Boolean)
    .slice(0, 7);

  let applicationUrl = normalizeUrl(result?.applicationUrl);

  if (!isRealUrl(applicationUrl) || isGoogleNewsWrapperUrl(applicationUrl)) {
    applicationUrl = "";
  }

  if (!applicationUrl) {
    const candidates = [opportunity?.canonicalUrl, opportunity?.finalUrl];

    for (const candidate of candidates) {
      if (isRealUrl(candidate) && !isGoogleNewsWrapperUrl(candidate)) {
        applicationUrl = candidate;

        break;
      }
    }
  }

  return {
    organization: rawOrg.slice(0, 150),

    role: rawRole.slice(0, 180),

    type: allowedTypes.has(result?.type)
      ? result.type
      : opportunity?.type || "opportunity",

    requirements: cleanArray(result?.requirements),

    benefits: cleanArray(result?.benefits),

    eligibility: cleanArray(result?.eligibility),

    location: cleanText(result?.location).slice(0, 200),

    deadline: cleanText(result?.deadline).slice(0, 150),

    applicationMethod: cleanText(result?.applicationMethod).slice(0, 500),

    applicationUrl,

    hashtags,

    content: stripEmojis(String(result?.content || "").trim()),
  };
}

/* =======================================================
   GROQ GENERATION
======================================================= */

async function callGeneration(opportunity, retries = 2) {
  const prompt = buildGenerationPrompt(opportunity);

  const models = [...new Set(GROQ_FALLBACK_MODELS.filter(Boolean))];

  let lastError = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(
          `   🧠 Groq attempt ${attempt}/${retries} with model ${model}`,
        );

        const response = await groq.chat.completions.create({
          model,

          messages: [
            {
              role: "system",
              content:
                "You are a structured data extraction system. Return only valid JSON matching the supplied schema. Never invent facts.",
            },

            {
              role: "user",
              content: prompt,
            },
          ],

          temperature: 0.3,

          max_completion_tokens: 2500,

          reasoning_effort: "low",

          response_format: {
            type: "json_schema",

            json_schema: {
              name: "linkedin_opportunity_post",

              strict: true,

              schema: OPPORTUNITY_SCHEMA,
            },
          },
        });

        const raw = response?.choices?.[0]?.message?.content;

        if (!raw) {
          throw new Error("Groq returned empty content.");
        }

        let parsed;

        try {
          parsed = JSON.parse(raw);
        } catch (error) {
          throw new Error(`Groq returned invalid JSON: ${error.message}`);
        }

        const normalized = normalizeOpportunity(parsed, opportunity);

        console.log("   ✅ Groq generation successful.");

        return normalized;
      } catch (error) {
        lastError = error;

        const message = String(error?.message || error);

        console.warn(
          `   ⚠️ Groq (${model}) attempt ${attempt}/${retries} failed: ${message}`,
        );

        const lower = message.toLowerCase();

        if (
          lower.includes("decommissioned") ||
          lower.includes("model_not_found") ||
          lower.includes("does not exist") ||
          lower.includes("you do not have access")
        ) {
          console.warn(`   ⏭️ Skipping unavailable model: ${model}`);

          break;
        }

        if (attempt < retries) {
          await sleep(1500 * attempt);
        }
      }
    }
  }

  throw lastError || new Error("All Groq models failed.");
}

/* =======================================================
   FALLBACK GENERATION
======================================================= */

function createFallbackPost(opportunity) {
  const organization =
    inferOrganizationFromOpportunity(opportunity) || "Opportunity Provider";

  const role =
    stripTrailingOrgSuffix(
      stripTrailingPublisher(opportunity.title),
      organization,
    ) || "Career Opportunity";

  const type = opportunity.type || "opportunity";

  const description = cleanText(opportunity.description);

  let content = "";

  if (description) {
    content = `This ${type} opportunity is worth exploring for eligible candidates. ${description.slice(
      0,
      700,
    )}`;
  } else {
    content = `This ${type} opportunity may be relevant to students and professionals looking for new career or education opportunities. Check the official source for complete eligibility and application details.`;
  }

  let applicationUrl = "";

  const candidates = [opportunity.canonicalUrl, opportunity.finalUrl];

  for (const candidate of candidates) {
    if (isRealUrl(candidate) && !isGoogleNewsWrapperUrl(candidate)) {
      applicationUrl = candidate;

      break;
    }
  }

  return {
    organization: organization.slice(0, 150),

    role: role.slice(0, 180),

    type,

    requirements: [],

    benefits: [],

    eligibility: [],

    location: "",

    deadline: "",

    applicationMethod: applicationUrl
      ? "Visit the official source for application instructions."
      : "",

    applicationUrl,

    hashtags: [],

    content: stripEmojis(content),
  };
}

/* =======================================================
   APPLICATION URL
======================================================= */

function getBestApplicationUrl(opportunity, post) {
  const candidates = [
    post?.applicationUrl,
    opportunity?.canonicalUrl,
    opportunity?.finalUrl,
  ];

  for (const candidate of candidates) {
    if (!isRealUrl(candidate)) {
      continue;
    }

    if (isGoogleNewsWrapperUrl(candidate)) {
      continue;
    }

    return candidate;
  }

  return "";
}

/* =======================================================
   POST BUILDER
======================================================= */

function buildFinalPost(post, opportunity) {
  const lines = [];

  const org = cleanText(
    post.organization.replace(/^#+/, "").replace(/\s+/g, " "),
  );

  const role = cleanText(post.role.replace(/^#+/, "").replace(/\s+/g, " "));

  let heading;

  if (
    post.type === "scholarship" ||
    post.type === "fellowship" ||
    post.type === "internship"
  ) {
    heading = `${org} is OFFERING ${role}`;
  } else if (post.type === "job") {
    heading = `${org} is HIRING ${role}`;
  } else {
    heading = `${org} is OFFERING ${role}`;
  }

  lines.push(heading);
  lines.push("");

  if (post.content) {
    lines.push(post.content.trim());

    lines.push("");
  }

  if (post.requirements.length) {
    lines.push("Requirements:");

    for (const item of post.requirements) {
      lines.push(`- ${item}`);
    }

    lines.push("");
  }

  if (post.benefits.length) {
    lines.push("Benefits:");

    for (const item of post.benefits) {
      lines.push(`- ${item}`);
    }

    lines.push("");
  }

  if (post.eligibility.length) {
    lines.push("Eligibility:");

    for (const item of post.eligibility) {
      lines.push(`- ${item}`);
    }

    lines.push("");
  }

  if (post.location) {
    lines.push(`Location: ${post.location}`);

    lines.push("");
  }

  if (post.deadline) {
    lines.push(`Deadline: ${post.deadline}`);

    lines.push("");
  }

  const applicationUrl = getBestApplicationUrl(opportunity, post);

  if (applicationUrl || post.applicationMethod) {
    lines.push("Where to Apply:");

    if (applicationUrl) {
      lines.push(applicationUrl);
    }

    if (post.applicationMethod) {
      lines.push(post.applicationMethod);
    }

    lines.push("");
  }

  const defaultTags = [
    toShortHashtag(org, 2, 20),

    toShortHashtag(role, 3, 24),

    `#${post.type}`,

    "#Career",

    "#Opportunities",
  ].filter(Boolean);

  const allTags = [...post.hashtags, ...defaultTags];

  const uniqueTags = [];
  const seen = new Set();

  for (const tag of allTags) {
    const clean = String(tag || "")
      .replace(/^#+/, "")
      .replace(/[^a-zA-Z0-9_]/g, "")
      .slice(0, 24);

    if (!clean) {
      continue;
    }

    const finalTag = `#${clean}`;

    const key = finalTag.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    uniqueTags.push(finalTag);

    if (uniqueTags.length >= 7) {
      break;
    }
  }

  if (uniqueTags.length) {
    lines.push(uniqueTags.join(" "));
  }

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* =======================================================
   VALIDATION
======================================================= */

function validatePost(content) {
  const reasons = [];

  const text = String(content || "").trim();

  if (text.length < 80) {
    reasons.push("post is too short");
  }

  if (text.length > 3000) {
    reasons.push("post exceeds LinkedIn length limit");
  }

  const lines = text.split("\n");

  if (lines.length < 3) {
    reasons.push("post does not contain enough content");
  }

  return {
    valid: reasons.length === 0,

    reasons,
  };
}

/* =======================================================
   IMAGE GENERATION
======================================================= */

function buildImagePrompt(post) {
  const role = post.role || "professional opportunity";

  const organization = post.organization || "professional organization";

  let scene;

  switch (post.type) {
    case "scholarship":
      scene =
        "premium realistic photograph of an international university campus, modern academic buildings, students studying, diverse international students, bright professional academic environment";

      break;

    case "fellowship":
      scene =
        "premium realistic photograph of a modern research and professional fellowship environment, university research center, international collaboration atmosphere, researchers working together";

      break;

    case "internship":
      scene =
        "premium realistic photograph of a modern technology office, young professionals learning and collaborating, laptops and professional workspace";

      break;

    case "job":
    default:
      scene =
        "premium realistic photograph of a modern professional workplace related to " +
        role +
        ", high-end office environment, technology and business atmosphere";

      break;
  }

  return `
${scene}

The opportunity is for:
${role}

Organization:
${organization}

Realistic professional photography.
Landscape composition.
Clean premium LinkedIn style.
High detail.
Natural lighting.
Modern professional aesthetic.
No visible logos.
No brand names.
No readable text.
No captions.
No watermark.
`;
}

async function generateImageWithCloudflare(post) {
  console.log("\n🎨 Generating opportunity image...");

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,

        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        prompt: buildImagePrompt(post),
      }),
    },
    120000,
  );

  if (!response.ok) {
    throw new Error(`Cloudflare ${response.status}: ${await response.text()}`);
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

    if (Array.isArray(b64)) {
      b64 = b64[0];
    }

    if (typeof b64 !== "string") {
      throw new Error("Cloudflare returned no image data.");
    }

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

  const sharpModule = await import("sharp");

  const sharp = sharpModule.default;

  const img = sharp(imageBuffer).resize(1200, 627, {
    fit: "cover",
  });

  const overlayText = post.type?.toUpperCase() || "OPPORTUNITY";

  const safeRole = escapeHtml(post.role.slice(0, 35));

  const safeOrganization = escapeHtml(post.organization.slice(0, 45));

  const svg = `
<svg width="1200" height="627">
  <defs>
    <linearGradient
      id="overlay"
      x1="0"
      y1="0"
      x2="1"
      y2="1"
    >
      <stop
        offset="0%"
        stop-color="black"
        stop-opacity="0.68"
      />

      <stop
        offset="100%"
        stop-color="black"
        stop-opacity="0.20"
      />
    </linearGradient>
  </defs>

  <rect
    x="0"
    y="0"
    width="1200"
    height="627"
    fill="url(#overlay)"
  />

  <text
    x="70"
    y="115"
    font-family="Arial, Helvetica, sans-serif"
    font-size="34"
    font-weight="bold"
    fill="white"
    letter-spacing="4"
  >
    ${escapeHtml(overlayText)}
  </text>

  <text
    x="70"
    y="185"
    font-family="Arial, Helvetica, sans-serif"
    font-size="52"
    font-weight="bold"
    fill="white"
  >
    ${safeRole}
  </text>

  <text
    x="70"
    y="245"
    font-family="Arial, Helvetica, sans-serif"
    font-size="30"
    fill="white"
  >
    ${safeOrganization}
  </text>
</svg>
`;

  const finalBuffer = await img
    .composite([
      {
        input: Buffer.from(svg),
        top: 0,
        left: 0,
      },
    ])
    .jpeg({
      quality: 88,
    })
    .toBuffer();

  await fs.mkdir(GENERATED_IMAGE_DIR, {
    recursive: true,
  });

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
  if (!imagePath) {
    return;
  }

  try {
    await fs.unlink(imagePath);
  } catch {}
}

/* =======================================================
   LINKEDIN API
======================================================= */

async function linkedinRequest(url, options = {}, retries = 3) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const token = await getValidLinkedInAccessToken();

      if (!token) {
        throw new Error(
          "No valid LinkedIn access token. Visit /auth/linkedin first.",
        );
      }

      const response = await fetchWithTimeout(
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

      if (response.status === 401) {
        console.warn("⚠️ LinkedIn returned 401 Unauthorized.");

        await clearLinkedInToken();
      }

      if (response.status === 429) {
        const retryAfter = parseInt(
          response.headers.get("retry-after") || "5",
          10,
        );

        console.log(`⏳ Rate limited. Waiting ${retryAfter}s...`);

        await sleep(retryAfter * 1000);

        continue;
      }

      if (response.status >= 500 && attempt < retries) {
        console.log(
          `🔄 LinkedIn server error ${response.status}. Retry ${attempt}/${retries}...`,
        );

        await sleep(2000 * attempt);

        continue;
      }

      return response;
    } catch (error) {
      lastError = error;

      if (attempt >= retries) {
        throw error;
      }

      console.log(`🔄 LinkedIn request failed. Retry ${attempt}/${retries}...`);

      await sleep(2000 * attempt);
    }
  }

  throw lastError || new Error("LinkedIn request failed.");
}

/* =======================================================
   LINKEDIN IMAGE UPLOAD
======================================================= */

async function registerImageUpload() {
  const personUrn = await getLinkedInPersonUrn();

  if (!personUrn) {
    throw new Error("No person URN found. Please re-authenticate.");
  }

  const response = await linkedinRequest(
    `${LINKEDIN_API}/images?action=initializeUpload`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        initializeUploadRequest: {
          owner: personUrn,
        },
      }),
    },
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `LinkedIn image initialization failed: ${response.status} ${text}`,
    );
  }

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("LinkedIn image initialization returned invalid JSON.");
  }

  const value = json.value || {};

  if (!value.uploadUrl || !value.image) {
    throw new Error(
      "LinkedIn image initialization returned no upload URL/image URN.",
    );
  }

  return {
    uploadUrl: value.uploadUrl,

    image: value.image,
  };
}

async function uploadImageBinary(uploadUrl, imagePath) {
  const token = await getValidLinkedInAccessToken();

  if (!token) {
    throw new Error("LinkedIn access token is unavailable.");
  }

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

/* =======================================================
   CREATE LINKEDIN POST
======================================================= */

async function createLinkedInPost(text, imageUrn = null) {
  const personUrn = await getLinkedInPersonUrn();

  if (!personUrn) {
    throw new Error("No person URN found.");
  }

  const body = {
    author: personUrn,

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
      media: {
        altText: "Career opportunity",
        id: imageUrn,
      },
    };
  }

  const response = await linkedinRequest(`${LINKEDIN_API}/posts`, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

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

    return {
      success: true,
      dryRun: true,
      id: null,
      link: null,
      imageGenerated: false,
    };
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
      console.warn("⚠️ Image upload failed:", error.message);

      console.log("   Continuing with text-only post.");
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
  if (typeof state.date !== "string") {
    state.date = getLocalDate();
  }

  if (!Number.isFinite(state.postsToday)) {
    state.postsToday = 0;
  }

  if (!Number.isFinite(state.totalPosts)) {
    state.totalPosts = 0;
  }

  if (!Number.isFinite(state.totalFailures)) {
    state.totalFailures = 0;
  }

  if (!Number.isFinite(state.totalSkipped)) {
    state.totalSkipped = 0;
  }

  if (!Array.isArray(state.history)) {
    state.history = [];
  }

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
      state = {
        ...createDefaultState(),
        ...parsed,
      };

      loaded = true;
    }
  } catch {}

  if (!loaded) {
    try {
      const raw = await fs.readFile(STATE_BACKUP_FILE, "utf8");

      const parsed = JSON.parse(raw);

      if (parsed && typeof parsed === "object") {
        state = {
          ...createDefaultState(),
          ...parsed,
        };

        loaded = true;
      }
    } catch {}
  }

  normalizeState();

  resetDailyCounter();

  if (!loaded) {
    await saveState();
  }
}

/* =======================================================
   POST HISTORY
======================================================= */

async function storePostHistory(post, result) {
  if (!postHistoryCollection) {
    return;
  }

  try {
    await postHistoryCollection.insertOne({
      id: result?.id || null,

      title: post.title || null,

      type: post.type || "opportunity",

      organization: post.organization || null,

      role: post.role || null,

      text: post.content,

      publishedAt: new Date(),

      dryRun: Boolean(result?.dryRun),
    });
  } catch (error) {
    console.warn("⚠️ Post history failed:", error.message);
  }
}

async function savePost(post, result, originalOpportunity) {
  state.history.push({
    id: result?.id || null,

    title: post.title || null,

    type: post.type,

    organization: post.organization,

    role: post.role,

    text: post.content,

    imageGenerated: Boolean(result?.imageGenerated),

    sourceUrl:
      originalOpportunity?.canonicalUrl ||
      originalOpportunity?.finalUrl ||
      originalOpportunity?.url ||
      null,

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
   OPPORTUNITY SELECTION
======================================================= */

async function findOpportunity(opportunities) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    return null;
  }

  const shuffled = shuffleArray(opportunities);

  const recentTitles = state.history.slice(-30).map((item) =>
    String(item.title || "")
      .toLowerCase()
      .trim(),
  );

  for (const raw of shuffled) {
    if (!raw.title || !raw.url) {
      continue;
    }

    const normalizedTitle = String(raw.title).toLowerCase().trim();

    if (recentTitles.includes(normalizedTitle)) {
      continue;
    }

    return raw;
  }

  return null;
}

async function getUnusedDatabaseOpportunities() {
  if (!opportunitiesCollection) {
    return [];
  }

  try {
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    return await opportunitiesCollection
      .find({
        used: false,

        fetchedAt: {
          $gte: cutoff,
        },
      })
      .sort({
        fetchedAt: -1,
      })
      .limit(100)
      .toArray();
  } catch {
    return [];
  }
}

/* =======================================================
   MAIN CYCLE
======================================================= */

let cycleRunning = false;

async function runCycle() {
  resetDailyCounter();

  state.lastTriggerAt = new Date().toISOString();

  await saveState();

  console.log("\n================================================");

  console.log(`🚀 LINKEDIN AI OPPORTUNITY BOT V${BOT_VERSION}`);

  console.log("================================================");

  console.log(
    `🕐 ${new Date().toLocaleString("en-US", {
      timeZone: BOT_TIMEZONE,
    })}`,
  );

  console.log(`📅 Posts: ${state.postsToday}/${MAX_POSTS_PER_DAY}`);

  if (state.postsToday >= MAX_POSTS_PER_DAY) {
    console.log("🛑 Daily limit reached.");

    state.totalSkipped++;

    state.lastTriggerResult = "daily_limit";

    await saveState();

    return {
      success: false,
      skipped: true,
      reason: "daily_limit",
    };
  }

  try {
    const token = await getValidLinkedInAccessToken();

    if (!token) {
      throw new Error("LinkedIn is not authorized. Open /auth/linkedin first.");
    }

    let opportunities = await researchOpportunities();

    if (opportunities.length === 0) {
      console.log("⚠️ RSS returned no opportunities. Checking MongoDB...");

      opportunities = await getUnusedDatabaseOpportunities();
    }

    if (opportunities.length === 0) {
      throw new Error("No recent opportunities were found.");
    }

    const rawOpportunity = await findOpportunity(opportunities);

    if (!rawOpportunity) {
      state.totalSkipped++;

      state.lastTriggerResult = "no_suitable_opportunity";

      await saveState();

      return {
        success: false,
        skipped: true,
        reason: "no_suitable_opportunity",
      };
    }

    console.log(`\n🎯 Selected opportunity: ${rawOpportunity.title}`);

    const opportunity = await enrichOpportunity(rawOpportunity);

    let post;

    try {
      post = await callGeneration(opportunity, 2);
    } catch (error) {
      console.warn(
        "⚠️ AI generation failed. Using intelligent fallback:",
        error.message,
      );

      post = createFallbackPost(opportunity);
    }

    const finalContent = buildFinalPost(post, opportunity);

    post.content = finalContent;

    console.log("\n================================================");

    console.log("📝 GENERATED POST");

    console.log("================================================");

    console.log(`🏢 Organization: ${post.organization}`);

    console.log(`💼 Role: ${post.role}`);

    console.log(`📋 Requirements: ${post.requirements.length}`);

    console.log(`🎁 Benefits: ${post.benefits.length}`);

    console.log(`🎓 Eligibility: ${post.eligibility.length}`);

    console.log(`📍 Location: ${post.location || "Not provided"}`);

    console.log(`⏰ Deadline: ${post.deadline || "Not provided"}`);

    console.log(
      `🔗 Apply: ${getBestApplicationUrl(opportunity, post) || "Not provided"}`,
    );

    console.log("\n----- POST -----\n");

    console.log(finalContent);

    console.log("\n----------------\n");

    const validation = validatePost(finalContent);

    if (!validation.valid) {
      console.error("❌ Post rejected by validation:", validation.reasons);

      state.totalSkipped++;

      state.lastTriggerResult = "validation_failed";

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

    await savePost(post, result, opportunity);

    if (opportunitiesCollection) {
      try {
        await opportunitiesCollection.updateOne(
          {
            fingerprint: fingerprintOpportunity(
              rawOpportunity.title,
              rawOpportunity.url,
            ),
          },
          {
            $set: {
              used: true,
              usedAt: new Date(),
            },
          },
        );
      } catch {}
    }

    state.lastTriggerResult = "success";

    await saveState();

    console.log("\n================================================");

    console.log("✅ CYCLE COMPLETED");

    console.log("================================================");

    if (result.id) {
      console.log(`🆔 ${result.id}`);
    }

    if (result.link) {
      console.log(`🔗 ${result.link}`);
    }

    return {
      success: true,

      id: result.id,

      link: result.link,

      dryRun: Boolean(result.dryRun),

      imageGenerated: Boolean(result.imageGenerated),

      opportunity: {
        organization: post.organization,

        role: post.role,

        type: post.type,
      },
    };
  } catch (error) {
    state.totalFailures++;

    state.lastTriggerResult = "failure";

    await saveState();

    console.error("\n❌ Cycle error:", error?.stack || error?.message || error);

    return {
      success: false,

      error: error?.message || "Unknown error",
    };
  }
}

/* =======================================================
   SAFE RUN
======================================================= */

async function safeRunCycle() {
  if (cycleRunning) {
    return {
      success: false,
      error: "A post cycle is already running.",
    };
  }

  cycleRunning = true;

  try {
    return await runCycle();
  } finally {
    cycleRunning = false;
  }
}

/* =======================================================
   INITIALIZE
======================================================= */

async function initializeLinkedInBot() {
  if (initialized) {
    return;
  }

  console.log("\n==============================================");

  console.log(`🤖 INITIALIZING LINKEDIN BOT V${BOT_VERSION}`);

  console.log("==============================================");

  await connectMongo();

  await loadState();

  console.log(`🧠 Groq primary model: ${GROQ_MODEL}`);

  console.log(
    `🧠 Groq fallbacks: ${[...new Set(GROQ_FALLBACK_MODELS)].join(", ")}`,
  );

  console.log("🔐 LinkedIn OAuth: enabled");

  console.log(`🎨 Cloudflare: ${CLOUDFLARE_IMAGE_MODEL}`);

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`🎯 Daily limit: ${MAX_POSTS_PER_DAY}`);

  console.log(`🌐 RSS sources: ${RSS_SOURCES.length}`);

  const token = await getValidLinkedInAccessToken();

  console.log(`🔑 LinkedIn authorized: ${token ? "YES" : "NO"}`);

  initialized = true;

  console.log(`✅ LinkedIn bot V${BOT_VERSION} initialized.`);
}

/* =======================================================
   STATUS
======================================================= */

async function getLinkedInStatus() {
  resetDailyCounter();

  const token = await getValidLinkedInAccessToken();

  const personUrn = await getLinkedInPersonUrn();

  return {
    service: "linkedin-ai-opportunity-bot",

    version: BOT_VERSION,

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

    personUrnStored: Boolean(personUrn),

    groqModel: GROQ_MODEL,

    cloudflareImageModel: CLOUDFLARE_IMAGE_MODEL,
  };
}

/* =======================================================
   SHUTDOWN
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
   PUBLIC RUN FUNCTION
======================================================= */

async function runLinkedInBot() {
  await initializeLinkedInBot();

  return await safeRunCycle();
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
