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
LINKEDIN AI OPPORTUNITY BOT V3.0.0
=========================================================

Fetches recent:
- Jobs
- Internships
- Scholarships
- Fellowships
- Graduate programs
- Remote opportunities
- Other relevant career opportunities

Workflow:
1. Fetch recent opportunities from multiple RSS sources.
2. Store them in MongoDB.
3. Select an opportunity that contains enough real information.
4. Enrich the source page when possible.
5. Use Groq to extract ONLY verified information.
6. Generate a clean LinkedIn post:
   #COMPANY is HIRING #ROLE

   Requirements:
   - ...

   Benefits:
   - ...

   Eligibility:
   - ...

   Where to Apply:
   ...

   #hashtags
7. Generate an image matching the opportunity type.
8. Upload image to LinkedIn.
9. Publish to personal profile.

IMPORTANT:
- Never invent requirements, benefits, eligibility, deadlines,
  locations, salaries, or application links.
- If an opportunity does not contain enough information,
  automatically skip it and try another opportunity.
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

/*
=========================================================
RSS SOURCES

Indeed frequently returns 403, so it is NOT treated as
the primary source.

Google News RSS is used because it can discover recent
opportunities from many different websites.
=========================================================
*/

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
    name: "Google News Fellowships",
    type: "fellowship",
    url:
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(
        "fellowship international students OR fellowship 2026 OR fellowship 2027",
      ) +
      "&hl=en-PK&gl=PK&ceid=PK:en",
  },

  {
    name: "Google News Graduate Opportunities",
    type: "job",
    url:
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent(
        "graduate program OR graduate jobs OR graduate scheme technology",
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

  {
    name: "Google News Technology Jobs",
    type: "job",
    url:
      "https://news.google.com/rss/search?q=" +
      encodeURIComponent("technology jobs hiring developer programmer") +
      "&hl=en-PK&gl=PK&ceid=PK:en",
  },
];

/* =======================================================
   LINKEDIN API
======================================================= */

const LINKEDIN_API = "https://api.linkedin.com/rest";

const LINKEDIN_OAUTH_AUTHORIZE =
  "https://www.linkedin.com/oauth/v2/authorization";

const LINKEDIN_OAUTH_TOKEN = "https://www.linkedin.com/oauth/v2/accessToken";

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
  throw new Error("LINKEDIN_POST_TRIGGER_SECRET is missing.");
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

  if (Number.isInteger(number) && number > 0) {
    return number;
  }

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
  } catch (error) {
    console.warn("⚠️ Could not read LinkedIn token:", error.message);

    return null;
  }
}

async function saveLinkedInToken(data) {
  if (!linkedinTokensCollection) {
    console.warn("⚠️ MongoDB unavailable. Token cannot be persisted.");

    return;
  }

  await linkedinTokensCollection.updateOne(
    {
      provider: "linkedin",
    },
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
    {
      upsert: true,
    },
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
  if (!state) return false;

  const record = oauthStates.get(state);

  if (!record) return false;

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

  return `${LINKEDIN_OAUTH_AUTHORIZE}?${params.toString()}`;
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

  if (!response.ok) {
    throw new Error(
      `Failed to fetch user info: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json();

  if (!data.sub) {
    throw new Error("No person ID returned from userinfo.");
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
    LINKEDIN_OAUTH_TOKEN,
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

  const json = JSON.parse(text);

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

async function handleLinkedInAuthCallback({ code, state, error }) {
  if (error) {
    return {
      statusCode: 400,
      html: `
<!doctype html>
<html>
<body>
<h2>LinkedIn authorization failed</h2>
<p>${escapeHtml(error)}</p>
</body>
</html>`,
    };
  }

  if (!code || !consumeOAuthState(state)) {
    return {
      statusCode: 400,
      html: `
<!doctype html>
<html>
<body>
<h2>Invalid OAuth request</h2>
<p>The authorization state is invalid or expired.</p>
</body>
</html>`,
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
<p>Your LinkedIn authorization token has been saved.</p>
<p>Person URN: ${escapeHtml(result.personUrn)}</p>
<p>You can close this window.</p>
</body>
</html>`,
    };
  } catch (error) {
    console.error("OAuth callback error:", error);

    return {
      statusCode: 500,
      html: `
<!doctype html>
<html>
<body>
<h2>LinkedIn connection failed</h2>
<p>${escapeHtml(error.message)}</p>
</body>
</html>`,
    };
  }
}

/* =======================================================
   RSS PARSING
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
    .replace(/&#x3D;/gi, "=");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
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

  const link = getXmlTag(xml, "link");

  return link;
}

function fingerprintOpportunity(title, url) {
  return `${String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180)}|${String(url || "")
    .toLowerCase()
    .trim()
    .slice(0, 250)}`;
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
   FETCH ONE RSS SOURCE
======================================================= */

async function fetchRssSource(source) {
  console.log(`\n   🔎 ${source.name}`);

  try {
    const response = await fetchWithTimeout(
      source.url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 LinkedInOpportunityBot/3.0",
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

      if (!title) {
        continue;
      }

      const description = cleanText(getXmlTag(item, "description"));

      const publishedAt = getXmlTag(item, "pubDate");

      const link = normalizeUrl(getXmlLink(item));

      const sourceName = cleanText(getXmlTag(item, "source")) || source.name;

      const type = inferOpportunityType(title, description, source.type);

      opportunities.push({
        title: title.slice(0, 400),
        description: description.slice(0, 3000),
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

/* =======================================================
   STORE OPPORTUNITIES
======================================================= */

async function storeOpportunities(items) {
  if (!opportunitiesCollection || !Array.isArray(items) || !items.length) {
    return;
  }

  const operations = items.map((item) => {
    const fingerprint = fingerprintOpportunity(item.title, item.url);

    return {
      updateOne: {
        filter: {
          fingerprint,
        },
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
   RECENT OPPORTUNITY RESEARCH
======================================================= */

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

  /*
  Prefer recent items.
  */

  opportunities.sort((a, b) => {
    const da = Date.parse(a.publishedAt) || 0;

    const db = Date.parse(b.publishedAt) || 0;

    return db - da;
  });

  /*
  Remove very old opportunities when
  publication date is available.
  */

  const maxAge = Date.now() - 14 * 24 * 60 * 60 * 1000;

  opportunities = opportunities.filter((item) => {
    const timestamp = Date.parse(item.publishedAt);

    if (!Number.isFinite(timestamp)) {
      return true;
    }

    return timestamp >= maxAge;
  });

  /*
  Shuffle within recent results so
  the bot doesn't always choose the
  exact same source/category.
  */

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

/* =======================================================
   SOURCE PAGE EXTRACTION
======================================================= */

function extractMetaContent(html, name) {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["'][^>]*>`,
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

function extractPageText(html) {
  let cleaned = String(html || "");

  cleaned = cleaned.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");

  cleaned = cleaned.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");

  cleaned = cleaned.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ");

  cleaned = cleaned.replace(
    /<(header|footer|nav|aside|svg)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );

  cleaned = cleaned.replace(/<[^>]*>/g, " ");

  cleaned = decodeXml(cleaned);

  cleaned = cleaned.replace(/\s+/g, " ");

  return cleaned.trim();
}

async function enrichOpportunity(opportunity) {
  const base = {
    ...opportunity,
  };

  if (!opportunity.url || !isRealUrl(opportunity.url)) {
    return base;
  }

  /*
  Google News links can redirect.
  Follow redirects automatically.
  */

  try {
    console.log(`   🔗 Reading source: ${opportunity.url.slice(0, 120)}...`);

    const response = await fetchWithTimeout(
      opportunity.url,
      {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      },
      20000,
    );

    if (!response.ok) {
      console.warn(`   ⚠️ Source page HTTP ${response.status}`);

      return base;
    }

    const finalUrl = response.url || opportunity.url;

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
      extractMetaContent(html, "twitter:title");

    const description =
      extractMetaContent(html, "og:description") ||
      extractMetaContent(html, "description");

    const pageText = extractPageText(html);

    /*
    Keep source material within a
    reasonable context size.
    */

    const sourceText = [title, description, pageText]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 14000);

    if (sourceText.length > 500) {
      console.log(`   ✅ Source enriched (${sourceText.length} chars)`);
    } else {
      console.log("   ⚠️ Source contains little readable information.");
    }

    return {
      ...base,
      finalUrl,
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
   MONGODB TOPIC SELECTION
======================================================= */

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
  } catch (error) {
    console.warn("⚠️ Database opportunity query failed:", error.message);

    return [];
  }
}

async function markOpportunityUsed(opportunity) {
  if (!opportunitiesCollection || !opportunity) {
    return;
  }

  try {
    await opportunitiesCollection.updateOne(
      {
        fingerprint:
          opportunity.fingerprint ||
          fingerprintOpportunity(opportunity.title, opportunity.url),
      },
      {
        $set: {
          used: true,
          usedAt: new Date(),
        },
      },
    );
  } catch (error) {
    console.warn("⚠️ Could not mark opportunity used:", error.message);
  }
}

/* =======================================================
   AI SCHEMA
======================================================= */

const OPPORTUNITY_SCHEMA = {
  type: "object",
  properties: {
    valid: {
      type: "boolean",
    },

    skipReason: {
      type: "string",
    },

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

    imagePrompt: {
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
    "valid",
    "skipReason",
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
    "imagePrompt",
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

Your job is to turn a REAL opportunity listing into a concise,
useful LinkedIn post.

VERY IMPORTANT:
NEVER invent facts.

Only use information explicitly present in:
1. The RSS listing.
2. The source webpage text.
3. The source title/description.

If a requirement is not present, DO NOT create one.

If benefits are not present, DO NOT create benefits.

If eligibility is not present, DO NOT create eligibility.

If application information is not present, DO NOT create an
application method or URL.

If the listing is too incomplete to make a useful post,
set valid=false.

The bot will automatically try another opportunity when
valid=false.

=========================================================
OPPORTUNITY TYPE
=========================================================

${opportunity.type}

=========================================================
RSS TITLE
=========================================================

${opportunity.title}

=========================================================
RSS DESCRIPTION
=========================================================

${opportunity.description || "Not available"}

=========================================================
RSS SOURCE
=========================================================

${opportunity.source || "Unknown"}

=========================================================
RSS DATE
=========================================================

${opportunity.publishedAt || "Unknown"}

=========================================================
RSS URL
=========================================================

${opportunity.url || "Not available"}

=========================================================
SOURCE PAGE TITLE
=========================================================

${opportunity.pageTitle || "Not available"}

=========================================================
SOURCE PAGE DESCRIPTION
=========================================================

${opportunity.pageDescription || "Not available"}

=========================================================
SOURCE PAGE TEXT
=========================================================

${opportunity.sourceText || "Not available"}

=========================================================
VALIDITY RULES
=========================================================

For a JOB:
- organization/company must be identifiable
- role/position must be identifiable
- at least 1 real requirement must exist
- application information must exist OR a valid source URL exists

For an INTERNSHIP:
- organization must be identifiable
- internship/position must be identifiable
- at least 1 real requirement OR eligibility condition must exist
- application information or source URL must exist

For a SCHOLARSHIP:
- scholarship/program name must be identifiable
- organization/provider must be identifiable
- at least 1 real eligibility condition must exist
- application information or source URL must exist

For a FELLOWSHIP:
- fellowship/program name must be identifiable
- organization/provider must be identifiable
- at least 1 real eligibility condition must exist
- application information or source URL must exist

For OTHER OPPORTUNITIES:
- opportunity name must be identifiable
- organization must be identifiable
- meaningful eligibility/requirements must exist
- application information must exist

Do NOT treat "not specified", "not mentioned", or similar
phrases as real information.

If the only information available is something like:

"Chevening Scholarship Falkland Islands; Deadline..."
with no real eligibility, requirements, benefits, or application
information, set valid=false.

=========================================================
POST FORMAT
=========================================================

The final post MUST follow this structure:

#COMPANY_NAME is HIRING #ROLE

Requirements:
- requirement
- requirement
- requirement

Benefits:
- benefit
- benefit

Eligibility:
- eligibility
- eligibility

Where to Apply:
application method or URL

Deadline:
deadline, ONLY if explicitly provided

Location:
location, ONLY if explicitly provided

#CompanyName #Role #OpportunityType #Career #Jobs

For scholarships/fellowships/internships, "is HIRING" may be
replaced with an accurate phrase such as:

#ORGANIZATION is OFFERING #SCHOLARSHIP

#ORGANIZATION is OFFERING #FELLOWSHIP

#ORGANIZATION is OFFERING #INTERNSHIP

Do not use emojis.

Keep the language simple and professional.

Do not copy long sentences from the source.

Do not mention information that is not verified.

The hashtags should be relevant and limited to 4-7 hashtags.

=========================================================
IMAGE
=========================================================

Create an imagePrompt that matches the opportunity.

For jobs:
- professional workplace
- technology/business environment matching the role
- realistic photography
- no people if possible
- no logos
- no text

For internships:
- modern workplace
- young professional/learning environment
- realistic photography
- no logos
- no text

For scholarships:
- university/academic environment
- international education atmosphere
- students/campus imagery
- realistic photography
- no logos
- no text

For fellowships:
- professional academic/research environment
- international collaboration
- realistic photography
- no logos
- no text

Do NOT put the opportunity title or company name into the generated
image itself. The bot adds its own overlay.

=========================================================
CURRENT OPPORTUNITY
=========================================================

${JSON.stringify(opportunity, null, 2)}
`;
}

/* =======================================================
   GROQ GENERATION
======================================================= */

function normalizeOpportunity(result) {
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

  const hashtags = cleanArray(result?.hashtags)
    .map((tag) => {
      const clean = tag.replace(/^#+/, "").replace(/[^a-zA-Z0-9_]/g, "");

      return clean ? `#${clean}` : "";
    })
    .filter(Boolean)
    .slice(0, 7);

  return {
    valid: Boolean(result?.valid),

    skipReason: cleanText(result?.skipReason),

    organization: cleanText(result?.organization).slice(0, 150),

    role: cleanText(result?.role).slice(0, 180),

    type: allowedTypes.has(result?.type) ? result.type : "opportunity",

    requirements: cleanArray(result?.requirements),

    benefits: cleanArray(result?.benefits),

    eligibility: cleanArray(result?.eligibility),

    location: cleanText(result?.location).slice(0, 200),

    deadline: cleanText(result?.deadline).slice(0, 150),

    applicationMethod: cleanText(result?.applicationMethod).slice(0, 500),

    applicationUrl: normalizeUrl(result?.applicationUrl),

    imagePrompt: cleanText(result?.imagePrompt).slice(0, 1000),

    hashtags,

    content: stripEmojis(String(result?.content || "").trim()),
  };
}

async function callGeneration(opportunity, retries = 3) {
  const prompt = buildGenerationPrompt(opportunity);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`   🧠 Groq attempt ${attempt}/${retries}`);

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,

        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],

        temperature: 0.1,

        max_completion_tokens: 1800,

        reasoning_effort: "low",

        reasoning_format: "hidden",

        response_format: {
          type: "json_schema",

          json_schema: {
            name: "linkedin_opportunity",

            strict: true,

            schema: OPPORTUNITY_SCHEMA,
          },
        },
      });

      const raw = response?.choices?.[0]?.message?.content;

      if (!raw) {
        throw new Error("Groq returned empty content.");
      }

      return normalizeOpportunity(JSON.parse(raw));
    } catch (error) {
      console.warn(`   ⚠️ Groq attempt failed: ${error.message}`);

      if (attempt >= retries) {
        throw error;
      }

      await sleep(1500 * attempt);
    }
  }

  throw new Error("Generation failed.");
}

/* =======================================================
   POST VALIDATION
======================================================= */

function validateGeneratedOpportunity(post, opportunity) {
  const reasons = [];

  if (!post) {
    return {
      valid: false,
      reasons: ["empty AI response"],
    };
  }

  if (!post.valid) {
    reasons.push(post.skipReason || "AI marked opportunity as incomplete");

    return {
      valid: false,
      reasons,
    };
  }

  if (!post.organization) {
    reasons.push("missing organization");
  }

  if (!post.role) {
    reasons.push("missing role/opportunity name");
  }

  /*
  Jobs and internships require
  real requirements.
  */

  if (post.type === "job" || post.type === "internship") {
    if (!Array.isArray(post.requirements) || post.requirements.length === 0) {
      reasons.push("missing requirements");
    }
  }

  /*
  Scholarships and fellowships
  require eligibility.
  */

  if (post.type === "scholarship" || post.type === "fellowship") {
    if (!Array.isArray(post.eligibility) || post.eligibility.length === 0) {
      reasons.push("missing eligibility");
    }
  }

  /*
  Every opportunity needs some
  application destination.
  */

  const hasApplication =
    Boolean(post.applicationMethod) ||
    isRealUrl(post.applicationUrl) ||
    isRealUrl(opportunity.finalUrl || opportunity.url);

  if (!hasApplication) {
    reasons.push("missing application information");
  }

  /*
  The generated content must
  actually contain useful sections.
  */

  if (!post.content || post.content.length < 100) {
    reasons.push("generated post is too short");
  }

  /*
  Reject placeholders.
  */

  const placeholderPattern =
    /not specified|not mentioned|unknown|n\/a|information unavailable|not available/i;

  if (placeholderPattern.test(post.content)) {
    reasons.push("post contains placeholder information");
  }

  /*
  Prevent fabricated URLs.
  */

  if (post.applicationUrl && !isRealUrl(post.applicationUrl)) {
    reasons.push("invalid application URL");
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/* =======================================================
   FINAL POST BUILDER

   We build the final post ourselves rather
   than trusting the AI formatting.

   This guarantees the requested format.
======================================================= */

function buildFinalPost(post, opportunity) {
  let headingOrganization = post.organization
    .replace(/^#+/, "")
    .replace(/\s+/g, " ")
    .trim();

  let headingRole = post.role.replace(/^#+/, "").replace(/\s+/g, " ").trim();

  const companyTag = headingOrganization
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 50);

  const roleTag = headingRole.replace(/[^a-zA-Z0-9]/g, "").slice(0, 50);

  let heading;

  if (post.type === "scholarship") {
    heading = `#${companyTag} is OFFERING #${roleTag}`;
  } else if (post.type === "fellowship") {
    heading = `#${companyTag} is OFFERING #${roleTag}`;
  } else if (post.type === "internship") {
    heading = `#${companyTag} is OFFERING #${roleTag}`;
  } else {
    heading = `#${companyTag} is HIRING #${roleTag}`;
  }

  const lines = [heading, ""];

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

  lines.push("Where to Apply:");

  if (isRealUrl(post.applicationUrl)) {
    lines.push(post.applicationUrl);
  } else if (post.applicationMethod) {
    lines.push(post.applicationMethod);

    if (isRealUrl(opportunity.finalUrl || opportunity.url)) {
      lines.push(opportunity.finalUrl || opportunity.url);
    }
  } else if (isRealUrl(opportunity.finalUrl || opportunity.url)) {
    lines.push(opportunity.finalUrl || opportunity.url);
  }

  lines.push("");

  const defaultTags = [
    companyTag,
    roleTag,
    post.type,
    "Career",
    "Opportunities",
  ];

  const allTags = [
    ...post.hashtags,
    ...defaultTags.map(
      (tag) =>
        `#${String(tag)
          .replace(/^#+/, "")
          .replace(/[^a-zA-Z0-9]/g, "")}`,
    ),
  ];

  const uniqueTags = [];

  for (const tag of allTags) {
    if (!tag || uniqueTags.includes(tag.toLowerCase())) {
      continue;
    }

    uniqueTags.push(tag.toLowerCase());

    if (uniqueTags.length >= 7) {
      break;
    }
  }

  lines.push(uniqueTags.join(" "));

  return lines.join("\n");
}

/* =======================================================
   IMAGE PROMPT
======================================================= */

function buildImagePrompt(post) {
  const role = post.role || "professional opportunity";

  const organization = post.organization || "professional organization";

  let scene;

  switch (post.type) {
    case "scholarship":
      scene = `
premium realistic photograph of an
international university campus,
modern academic buildings,
students studying and walking on campus,
subtle global education atmosphere,
bright professional academic environment
`;
      break;

    case "fellowship":
      scene = `
premium realistic photograph of a
modern research and professional fellowship
environment, university research center,
international collaboration atmosphere,
modern workspace, sophisticated academic setting
`;
      break;

    case "internship":
      scene = `
premium realistic photograph of a
modern technology office,
young professionals learning and collaborating,
laptops and professional workspace,
career development atmosphere
`;
      break;

    case "job":
    default:
      scene = `
premium realistic photograph of a
modern professional workplace related to
${role},
high-end office environment,
technology and business atmosphere,
professional career setting
`;
      break;
  }

  return `
${scene}

The opportunity is for:
${role}

Organization:
${organization}

The image should visually communicate:
${
  post.type === "job"
    ? "HIRING"
    : post.type === "internship"
      ? "INTERNSHIP"
      : post.type === "scholarship"
        ? "SCHOLARSHIP"
        : post.type === "fellowship"
          ? "FELLOWSHIP"
          : "OPPORTUNITY"
}

Realistic professional photography.
Landscape composition.
Clean premium LinkedIn style.
High detail.
Natural lighting.
No visible logos.
No brand names.
No readable text.
No captions.
No watermark.
No UI.
No poster design.
No distorted hands.
No unrealistic objects.
`;
}

/* =======================================================
   IMAGE GENERATION
======================================================= */

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

  /*
  Add an opportunity-specific
  overlay instead of always using
  "HIRING".
  */

  let overlayText;

  switch (post.type) {
    case "scholarship":
      overlayText = "SCHOLARSHIP";
      break;

    case "fellowship":
      overlayText = "FELLOWSHIP";
      break;

    case "internship":
      overlayText = "INTERNSHIP";
      break;

    case "job":
      overlayText = "HIRING";
      break;

    default:
      overlayText = "OPPORTUNITY";
  }

  let finalBuffer = imageBuffer;

  try {
    const sharpModule = await import("sharp");

    const sharp = sharpModule.default;

    const img = sharp(imageBuffer).resize(1200, 627, {
      fit: "cover",
    });

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
    ${escapeHtml(post.role.slice(0, 35))}
  </text>

  <text
    x="70"
    y="245"
    font-family="Arial, Helvetica, sans-serif"
    font-size="30"
    fill="white"
  >
    ${escapeHtml(post.organization.slice(0, 45))}
  </text>
</svg>
`;

    finalBuffer = await img
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
  } catch (error) {
    console.warn("⚠️ Image overlay failed:", error.message);

    try {
      const sharpModule = await import("sharp");

      const sharp = sharpModule.default;

      finalBuffer = await sharp(imageBuffer)
        .resize(1200, 627, {
          fit: "cover",
        })
        .jpeg({
          quality: 88,
        })
        .toBuffer();
    } catch {}
  }

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

  const json = JSON.parse(text);

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

function getRecentPostMemory() {
  return state.history
    .slice(-20)
    .map((post) => String(post.title || "").slice(0, 180))
    .join("\n");
}

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

    title: post.title,

    type: post.type,

    organization: post.organization,

    role: post.role,

    text: post.content,

    imageGenerated: Boolean(result?.imageGenerated),

    sourceUrl:
      originalOpportunity?.finalUrl || originalOpportunity?.url || null,

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
   SELECT A VALID OPPORTUNITY

   THIS IS THE IMPORTANT FIX.

   The previous bot selected one RSS item and immediately
   generated a post. That caused:

   "Benefits: Not specified"
   "Eligibility: Not specified"
   "Requirements: Not specified"

   Now the bot:
   1. gets many opportunities
   2. enriches them
   3. asks AI to validate each
   4. rejects incomplete listings
   5. tries the next one
   6. only publishes when validation passes
======================================================= */

async function findValidOpportunity(opportunities) {
  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    return null;
  }

  const recentTitles = new Set(
    state.history.slice(-30).map((item) =>
      String(item.title || "")
        .toLowerCase()
        .trim(),
    ),
  );

  /*
  Put jobs, internships,
  scholarships and fellowships
  into a mixed queue.
  */

  const candidates = shuffleArray(opportunities);

  let checked = 0;

  for (const original of candidates) {
    if (checked >= 20) {
      break;
    }

    const normalizedTitle = String(original.title || "")
      .toLowerCase()
      .trim();

    if (recentTitles.has(normalizedTitle)) {
      continue;
    }

    checked++;

    console.log("\n================================================");

    console.log(`🎯 CANDIDATE ${checked}/20`);

    console.log(`📌 ${original.title}`);

    console.log(`🏷️ Type: ${original.type}`);

    console.log(`🔗 ${original.url || "No URL"}`);

    /*
    Enrich from source webpage.
    */

    const opportunity = await enrichOpportunity(original);

    try {
      const post = await callGeneration(opportunity, 3);

      console.log("\n🤖 AI ANALYSIS");

      console.log(`   Valid: ${post.valid}`);

      console.log(`   Organization: ${post.organization || "—"}`);

      console.log(`   Role: ${post.role || "—"}`);

      console.log(`   Type: ${post.type}`);

      console.log(`   Requirements: ${post.requirements.length}`);

      console.log(`   Benefits: ${post.benefits.length}`);

      console.log(`   Eligibility: ${post.eligibility.length}`);

      const validation = validateGeneratedOpportunity(post, opportunity);

      if (!validation.valid) {
        console.log(`   ⏭️ Rejected: ${validation.reasons.join(", ")}`);

        await markOpportunityUsed(opportunity);

        continue;
      }

      const finalContent = buildFinalPost(post, opportunity);

      /*
      Final safety validation.
      */

      if (finalContent.length < 120) {
        console.log("   ⏭️ Rejected: final post too short.");

        continue;
      }

      if (
        /not specified|not mentioned|unknown|n\/a|not available/i.test(
          finalContent,
        )
      ) {
        console.log("   ⏭️ Rejected: placeholder detected.");

        continue;
      }

      /*
      Store final content.
      */

      const result = {
        ...post,

        title: post.role || opportunity.title,

        content: finalContent,

        sourceUrl: opportunity.finalUrl || opportunity.url || null,
      };

      console.log("\n   ✅ VALID OPPORTUNITY FOUND");

      return {
        opportunity,
        post: result,
      };
    } catch (error) {
      console.warn(`   ⚠️ Candidate processing failed: ${error.message}`);

      await markOpportunityUsed(opportunity);
    }
  }

  return null;
}

/* =======================================================
   MAIN CYCLE
======================================================= */

let cycleRunning = false;

async function runCycle() {
  resetDailyCounter();

  console.log("\n================================================");

  console.log("🚀 LINKEDIN AI OPPORTUNITY BOT V3.0.0");

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

    /*
    Fetch fresh opportunities.
    */

    let opportunities = await researchOpportunities();

    /*
    If RSS temporarily fails,
    use unused MongoDB opportunities.
    */

    if (opportunities.length === 0) {
      console.log("⚠️ RSS returned no opportunities. Checking MongoDB...");

      opportunities = await getUnusedDatabaseOpportunities();
    }

    if (opportunities.length === 0) {
      throw new Error("No recent opportunities were found.");
    }

    /*
    Find a genuinely usable listing.
    */

    const selected = await findValidOpportunity(opportunities);

    if (!selected) {
      state.totalSkipped++;

      await saveState();

      return {
        success: false,
        skipped: true,
        reason: "no_valid_recent_opportunity",
      };
    }

    const { opportunity, post } = selected;

    console.log("\n================================================");

    console.log("📝 GENERATED OPPORTUNITY");

    console.log("================================================");

    console.log(`🏢 Organization: ${post.organization}`);

    console.log(`💼 Role: ${post.role}`);

    console.log(`🏷️ Type: ${post.type}`);

    console.log(`📋 Requirements: ${post.requirements.length}`);

    console.log(`🎁 Benefits: ${post.benefits.length}`);

    console.log(`🎓 Eligibility: ${post.eligibility.length}`);

    console.log(`📍 Location: ${post.location || "Not provided"}`);

    console.log(`⏰ Deadline: ${post.deadline || "Not provided"}`);

    console.log(
      `🔗 Apply: ${
        post.applicationUrl ||
        opportunity.finalUrl ||
        opportunity.url ||
        "Not provided"
      }`,
    );

    console.log("\n----- GENERATED POST -----\n");

    console.log(post.content);

    console.log("\n--------------------------\n");

    /*
    Generate image based on
    opportunity type.
    */

    let imagePath = null;

    try {
      imagePath = await generateImageWithCloudflare(post);
    } catch (error) {
      console.warn("⚠️ Image generation failed:", error.message);
    }

    /*
    Publish.
    */

    let result;

    try {
      result = await publishToLinkedIn(post, imagePath);
    } finally {
      await cleanupImage(imagePath);
    }

    /*
    Mark source as used only
    after successful generation/
    publication.
    */

    await markOpportunityUsed(opportunity);

    await savePost(post, result, opportunity);

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
      opportunity: {
        organization: post.organization,
        role: post.role,
        type: post.type,
      },
    };
  } catch (error) {
    state.totalFailures++;

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
   INITIALIZATION
======================================================= */

async function initializeLinkedInBot() {
  if (initialized) {
    return;
  }

  console.log("\n==============================================");

  console.log("🤖 INITIALIZING LINKEDIN BOT V3.0.0");

  console.log("==============================================");

  await connectMongo();

  await loadState();

  console.log(`🧠 Groq: ${GROQ_MODEL}`);

  console.log("🔐 LinkedIn OAuth: enabled (personal profile)");

  console.log(`📡 LinkedIn API: ${LINKEDIN_VERSION}`);

  console.log(`🎨 Cloudflare: ${CLOUDFLARE_IMAGE_MODEL}`);

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`🎯 Daily limit: ${MAX_POSTS_PER_DAY}`);

  console.log(`🌐 RSS sources: ${RSS_SOURCES.length}`);

  const token = await getValidLinkedInAccessToken();

  const personUrn = await getLinkedInPersonUrn();

  console.log(`🔑 LinkedIn authorized: ${token ? "YES" : "NO"}`);

  if (personUrn) {
    console.log(`👤 Person URN: ${personUrn}`);
  }

  initialized = true;

  console.log("✅ LinkedIn bot initialized.");
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

    version: "3.0.0",

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
   EXTERNAL ENTRY POINT
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
