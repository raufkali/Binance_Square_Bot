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
INDIVIDUAL PROFILE EDITION

FETCHES:
- Jobs
- Internships
- Scholarships
- Fellowships
- Graduate opportunities
- Remote opportunities
- Other relevant career opportunities

FLOW:
1. Fetch recent opportunities from multiple RSS feeds
2. Store opportunities in MongoDB
3. Select an unused recent opportunity
4. AI extracts ONLY verified information
5. Generate structured LinkedIn post
6. Generate opportunity-specific image
7. Add dynamic overlay
8. Publish to personal LinkedIn profile
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

/* =======================================================
   RSS SOURCES
=======================================================

   Google News RSS is used for scholarships, internships,
   fellowships and broader opportunity discovery.

   Indeed RSS is used for jobs.

   You can add/remove feeds here without changing the
   rest of the bot.
======================================================= */

const OPPORTUNITY_FEEDS = [
  {
    name: "Indeed Pakistan Software Jobs",
    type: "job",
    url: "https://rss.indeed.com/rss?q=software+engineer&l=Pakistan",
  },
  {
    name: "Indeed Pakistan Developer Jobs",
    type: "job",
    url: "https://rss.indeed.com/rss?q=developer&l=Pakistan",
  },
  {
    name: "Indeed Remote Software Jobs",
    type: "job",
    url: "https://rss.indeed.com/rss?q=software+engineer&l=Remote",
  },

  {
    name: "Google News Internships",
    type: "internship",
    url: "https://news.google.com/rss/search?q=software+engineering+internship+OR+computer+science+internship&hl=en-US&gl=US&ceid=US:en",
  },

  {
    name: "Google News Scholarships",
    type: "scholarship",
    url: "https://news.google.com/rss/search?q=fully+funded+scholarship+OR+international+scholarship+2026+OR+2027&hl=en-US&gl=US&ceid=US:en",
  },

  {
    name: "Google News Fellowships",
    type: "fellowship",
    url: "https://news.google.com/rss/search?q=fully+funded+fellowship+OR+international+fellowship+2026+OR+2027&hl=en-US&gl=US&ceid=US:en",
  },

  {
    name: "Google News Graduate Opportunities",
    type: "opportunity",
    url: "https://news.google.com/rss/search?q=graduate+program+OR+graduate+opportunity+computer+science&hl=en-US&gl=US&ceid=US:en",
  },

  {
    name: "Google News Remote Jobs",
    type: "job",
    url: "https://news.google.com/rss/search?q=remote+software+developer+job+OR+remote+software+engineer+job&hl=en-US&gl=US&ceid=US:en",
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

if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
  throw new Error("Cloudflare credentials are missing.");
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

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(url) {
  try {
    return new URL(String(url || "").trim()).toString();
  } catch {
    return "";
  }
}

function isRecentDate(dateValue, maxHours = 168) {
  if (!dateValue) return true;

  const parsed = new Date(dateValue);

  if (Number.isNaN(parsed.getTime())) {
    return true;
  }

  const age = Date.now() - parsed.getTime();

  return age <= maxHours * 60 * 60 * 1000;
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
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
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
    console.warn("⚠️ MONGODB_URI missing. Running without MongoDB.");
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
      used: 1,
      publishedAt: -1,
    });

    await opportunitiesCollection.createIndex({
      category: 1,
      publishedAt: -1,
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

    mongoClient = null;
    opportunitiesCollection = null;
    postHistoryCollection = null;
    linkedinTokensCollection = null;
  } catch {}
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
    console.warn("⚠️ MongoDB unavailable. LinkedIn token cannot be persisted.");

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
   OAUTH STATE
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

  if (Date.now() - record.createdAt > maxAge) {
    return false;
  }

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
      `Failed to fetch LinkedIn user info: ${response.status} ${await response.text()}`,
    );
  }

  const data = await response.json();

  if (!data.sub) {
    throw new Error("No LinkedIn person ID returned.");
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

  const accessToken = json.access_token;

  if (!accessToken) {
    throw new Error("LinkedIn did not return an access token.");
  }

  const expiresIn = Number(json.expires_in || 0);

  const expiresAt =
    expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null;

  const personId = await getLinkedInPersonId(accessToken);

  const personUrn = `urn:li:person:${personId}`;

  await saveLinkedInToken({
    accessToken,
    expiresAt,
    scope: json.scope || null,
    personUrn,
  });

  return {
    accessToken,
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
    console.warn("⚠️ Stored LinkedIn token has expired.");

    await clearLinkedInToken();

    return null;
  }

  return stored.accessToken;
}

/* =======================================================
   OAUTH CALLBACK
======================================================= */

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
    .replace(/&#39;/gi, "'");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
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

function getXmlLink(xml) {
  const normal = getXmlTag(xml, "link");

  if (normal) {
    return normalizeUrl(normal);
  }

  const atom = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);

  return normalizeUrl(atom?.[1] || "");
}

function fingerprintOpportunity(title, url = "") {
  return crypto
    .createHash("sha256")
    .update(
      `${cleanText(title).toLowerCase()}|${normalizeUrl(url).toLowerCase()}`,
    )
    .digest("hex");
}

/* =======================================================
   OPPORTUNITY DISCOVERY
======================================================= */

async function fetchFeed(feed) {
  try {
    console.log(`   🔎 ${feed.name}`);

    const response = await fetchWithTimeout(
      feed.url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 LinkedInOpportunityBot/3.0",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
      },
      30000,
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const xml = await response.text();

    const items = [...xml.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];

    const opportunities = [];

    for (const match of items.slice(0, 40)) {
      const item = match[2];

      const title = cleanText(getXmlTag(item, "title"));

      if (!title) continue;

      const description = cleanText(
        getXmlTag(item, "description") ||
          getXmlTag(item, "summary") ||
          getXmlTag(item, "content"),
      );

      const publishedAt =
        getXmlTag(item, "pubDate") ||
        getXmlTag(item, "published") ||
        getXmlTag(item, "updated");

      const link = getXmlLink(item);

      if (!isRecentDate(publishedAt, 336)) {
        continue;
      }

      opportunities.push({
        title: title.slice(0, 300),

        description: description.slice(0, 2000),

        publishedAt: publishedAt.slice(0, 100),

        source: link || feed.name,

        sourceName: feed.name,

        category: feed.type,

        url: link,

        fingerprint: fingerprintOpportunity(title, link),
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

  const allResults = [];

  for (const feed of OPPORTUNITY_FEEDS) {
    const results = await fetchFeed(feed);

    allResults.push(...results);
  }

  const unique = new Map();

  for (const opportunity of allResults) {
    if (!opportunity.fingerprint) {
      continue;
    }

    if (!unique.has(opportunity.fingerprint)) {
      unique.set(opportunity.fingerprint, opportunity);
    }
  }

  const opportunities = shuffleArray(Array.from(unique.values()));

  console.log(
    `\n📊 Total unique recent opportunities: ${opportunities.length}`,
  );

  const counts = opportunities.reduce((acc, item) => {
    const category = item.category || "opportunity";

    acc[category] = (acc[category] || 0) + 1;

    return acc;
  }, {});

  console.log("📌 Categories:", counts);

  await storeOpportunities(opportunities);

  return opportunities;
}

/* =======================================================
   MONGODB OPPORTUNITIES
======================================================= */

async function storeOpportunities(items) {
  if (!opportunitiesCollection || !items.length) {
    return;
  }

  const operations = items.map((item) => ({
    updateOne: {
      filter: {
        fingerprint: item.fingerprint,
      },

      update: {
        $setOnInsert: {
          ...item,
          fetchedAt: new Date(),
          used: false,
          usedAt: null,
        },
      },

      upsert: true,
    },
  }));

  try {
    await opportunitiesCollection.bulkWrite(operations, {
      ordered: false,
    });

    console.log(`💾 Stored ${items.length} opportunities.`);
  } catch (error) {
    console.warn("⚠️ Opportunity storage failed:", error.message);
  }
}

async function pullStoredOpportunity() {
  if (!opportunitiesCollection) {
    return null;
  }

  const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  try {
    const result = await opportunitiesCollection.findOneAndUpdate(
      {
        used: false,

        fetchedAt: {
          $gte: cutoff,
        },
      },

      {
        $set: {
          used: true,
          usedAt: new Date(),
        },
      },

      {
        sort: {
          publishedAt: -1,
          fetchedAt: -1,
        },

        returnDocument: "after",
      },
    );

    return result || null;
  } catch (error) {
    console.warn("⚠️ Stored opportunity pull failed:", error.message);

    return null;
  }
}

async function selectOpportunity(freshOpportunities) {
  const stored = await pullStoredOpportunity();

  if (stored) {
    return {
      ...stored,
      fromDb: true,
    };
  }

  if (Array.isArray(freshOpportunities) && freshOpportunities.length) {
    return {
      ...freshOpportunities[0],
      fromDb: false,
    };
  }

  return {
    title: "Software Engineering Opportunity",
    description:
      "A software engineering opportunity is available for candidates with relevant technical skills.",
    publishedAt: new Date().toISOString(),
    source: "Opportunity Feed",
    sourceName: "Opportunity Feed",
    category: "opportunity",
    url: "",
    fromDb: false,
  };
}

/* =======================================================
   POST SCHEMA
======================================================= */

const POST_SCHEMA = {
  type: "object",

  properties: {
    title: {
      type: "string",
    },

    opportunityType: {
      type: "string",

      enum: [
        "job",
        "internship",
        "scholarship",
        "fellowship",
        "graduate_program",
        "other",
      ],
    },

    companyName: {
      type: "string",
    },

    role: {
      type: "string",
    },

    location: {
      type: "string",
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

    imageTitle: {
      type: "string",
    },

    imageSubtitle: {
      type: "string",
    },

    imageTheme: {
      type: "string",
    },

    skip: {
      type: "boolean",
    },

    skipReason: {
      type: "string",
    },
  },

  required: [
    "title",
    "opportunityType",
    "companyName",
    "role",
    "location",
    "requirements",
    "benefits",
    "eligibility",
    "applicationMethod",
    "applicationUrl",
    "hashtags",
    "content",
    "imageTitle",
    "imageSubtitle",
    "imageTheme",
    "skip",
    "skipReason",
  ],

  additionalProperties: false,
};

/* =======================================================
   POST NORMALIZATION
======================================================= */

function normalizePost(post) {
  const allowedTypes = new Set([
    "job",
    "internship",
    "scholarship",
    "fellowship",
    "graduate_program",
    "other",
  ]);

  const normalizeArray = (value, max = 8) =>
    Array.isArray(value)
      ? value
          .map((item) => cleanText(item))
          .filter(Boolean)
          .slice(0, max)
      : [];

  return {
    title: cleanText(post?.title || "Career Opportunity").slice(0, 180),

    opportunityType: allowedTypes.has(post?.opportunityType)
      ? post.opportunityType
      : "other",

    companyName: cleanText(post?.companyName || "Organization").slice(0, 150),

    role: cleanText(post?.role || "Opportunity Available").slice(0, 180),

    location: cleanText(post?.location || "See official listing").slice(0, 180),

    requirements: normalizeArray(post?.requirements),

    benefits: normalizeArray(post?.benefits),

    eligibility: normalizeArray(post?.eligibility),

    applicationMethod: cleanText(
      post?.applicationMethod || "Apply through the official application page.",
    ).slice(0, 500),

    applicationUrl: normalizeUrl(post?.applicationUrl || ""),

    hashtags: normalizeArray(post?.hashtags, 8)
      .map((tag) => {
        const cleaned = tag.replace(/^#+/, "").replace(/[^a-zA-Z0-9_]/g, "");

        return cleaned ? `#${cleaned}` : "";
      })
      .filter(Boolean),

    content: stripEmojis(String(post?.content || "").trim()),

    imageTitle: cleanText(post?.imageTitle || "OPPORTUNITY").slice(0, 80),

    imageSubtitle: cleanText(post?.imageSubtitle || post?.role || "").slice(
      0,
      120,
    ),

    imageTheme: cleanText(
      post?.imageTheme || "professional career opportunity",
    ).slice(0, 250),

    skip: Boolean(post?.skip),

    skipReason: cleanText(post?.skipReason || ""),
  };
}

/* =======================================================
   AI GENERATION
======================================================= */

async function callGeneration(opportunity, retries = 3) {
  const listing = `
TITLE:
${opportunity.title}

TYPE FROM SOURCE:
${opportunity.category || "unknown"}

DESCRIPTION:
${opportunity.description || "Not provided"}

PUBLISHED:
${opportunity.publishedAt || "Unknown"}

SOURCE:
${opportunity.sourceName || "Unknown"}

SOURCE URL:
${opportunity.url || "Not available"}
`;

  const systemPrompt = `
You are an expert LinkedIn career opportunity content creator.

Your job is to transform a real opportunity listing into a concise,
high-quality LinkedIn post.

IMPORTANT:
You MUST use ONLY information explicitly available in the source listing.

Never invent:
- salary
- benefits
- eligibility
- degree requirements
- location
- deadline
- company information
- application links
- skills
- experience
- visa sponsorship
- remote status

If information is missing, use an empty array or a safe phrase such as:
"Not specified in the listing."

Do not fabricate information to make the post look complete.

The post MUST follow this structure:

#COMPANY_NAME is HIRING #ROLE

Requirements:
- requirement
- requirement

Benefits:
- benefit
- benefit

Eligibility:
- eligibility requirement
- eligibility requirement

Where to Apply:
application method or official URL

#Hashtag #Hashtag #Hashtag

For scholarships, fellowships and internships:
Do NOT force the word "HIRING" if it would be misleading.

Instead use:
#ORGANIZATION_NAME is OFFERING #OPPORTUNITY

Examples:

#GOOGLE is HIRING #SOFTWAREENGINEER

or

#ERASMUS is OFFERING #SCHOLARSHIP

or

#MICROSOFT is OFFERING #INTERNSHIP

The company/organization name must come from the source.

ROLE must be the actual role/opportunity title from the source.

The content should be easy to scan on LinkedIn.

Use simple professional English.

Do not use emojis.

Do not write a long introduction.

Do not add a "Source:" section.

Do not add unsupported information.

Generate 3-8 highly relevant hashtags.

Image information must match the actual opportunity.

For example:
- Software job -> modern technology/software workplace
- Internship -> young professional/technology internship environment
- Scholarship -> university/international education environment
- Fellowship -> academic/research/professional fellowship environment
- Graduate program -> modern graduate/professional workplace
- Healthcare job -> healthcare environment
- Finance job -> professional finance/business environment
- Engineering job -> engineering workplace
- Remote job -> professional remote workspace

The image must NOT contain logos or fake company branding.
The image should NOT contain random text.

If the source is too weak to identify the actual opportunity, set skip=true.
`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`   🧠 Groq attempt ${attempt}/${retries}`);

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,

        messages: [
          {
            role: "system",
            content: systemPrompt,
          },

          {
            role: "user",
            content: listing,
          },
        ],

        temperature: 0.2,

        max_completion_tokens: 1600,

        reasoning_effort: "low",

        reasoning_format: "hidden",

        response_format: {
          type: "json_schema",

          json_schema: {
            name: "linkedin_opportunity",

            strict: true,

            schema: POST_SCHEMA,
          },
        },
      });

      const raw = response?.choices?.[0]?.message?.content;

      if (!raw) {
        throw new Error("Groq returned empty content.");
      }

      return normalizePost(JSON.parse(raw));
    } catch (error) {
      console.warn(`   ⚠️ Groq attempt failed: ${error.message}`);

      if (attempt >= retries) {
        throw error;
      }

      await sleep(1500 * attempt);
    }
  }
}

/* =======================================================
   CONTENT VALIDATION
======================================================= */

function validatePost(post) {
  const reasons = [];

  if (!post) {
    return {
      valid: false,
      reasons: ["empty post"],
    };
  }

  if (post.content.length < 100) {
    reasons.push("post is too short");
  }

  if (post.content.length > 3000) {
    reasons.push("post is too long");
  }

  if (!post.companyName) {
    reasons.push("missing organization");
  }

  if (!post.role) {
    reasons.push("missing role/opportunity");
  }

  if (post.requirements.length === 0) {
    reasons.push("missing requirements");
  }

  if (!post.applicationMethod && !post.applicationUrl) {
    reasons.push("missing application method");
  }

  if (!/#\w+/i.test(post.content)) {
    reasons.push("missing hashtags");
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/* =======================================================
   IMAGE GENERATION
======================================================= */

function getOpportunityVisual(post) {
  const type = post.opportunityType;

  if (type === "scholarship") {
    return `
international university campus,
students studying,
academic scholarship opportunity,
modern university architecture,
books and education atmosphere
`;
  }

  if (type === "fellowship") {
    return `
professional research and fellowship environment,
modern academic research center,
researchers working,
international professional development atmosphere
`;
  }

  if (type === "internship") {
    return `
modern technology workplace,
young professional intern,
laptop with software development environment,
collaborative professional office,
early-career atmosphere
`;
  }

  if (type === "graduate_program") {
    return `
modern professional corporate workplace,
young graduate professionals,
career development environment,
laptops and collaborative workspace
`;
  }

  if (post.role) {
    const role = post.role.toLowerCase();

    if (
      role.includes("software") ||
      role.includes("developer") ||
      role.includes("engineer") ||
      role.includes("programmer") ||
      role.includes("data") ||
      role.includes("ai") ||
      role.includes("machine learning") ||
      role.includes("cyber")
    ) {
      return `
modern software engineering office,
developers working with computers,
technology workplace,
subtle code visible on monitors,
professional corporate environment
`;
    }

    if (
      role.includes("finance") ||
      role.includes("account") ||
      role.includes("bank")
    ) {
      return `
modern financial services office,
professional finance workplace,
business professionals,
subtle financial analytics screens
`;
    }

    if (
      role.includes("marketing") ||
      role.includes("sales") ||
      role.includes("business")
    ) {
      return `
modern business and marketing office,
professional business team,
creative strategy workplace,
laptops and presentation screens
`;
    }

    if (role.includes("design") || role.includes("ui") || role.includes("ux")) {
      return `
modern creative design studio,
professional UI UX designers,
large design displays,
creative digital workplace
`;
    }

    if (
      role.includes("health") ||
      role.includes("medical") ||
      role.includes("doctor") ||
      role.includes("nurse")
    ) {
      return `
modern healthcare workplace,
professional medical environment,
clean hospital interior,
healthcare professionals
`;
    }

    if (
      role.includes("mechanical") ||
      role.includes("electrical") ||
      role.includes("civil") ||
      role.includes("engineering")
    ) {
      return `
modern engineering workplace,
professional engineers,
technical equipment,
industrial engineering environment
`;
    }
  }

  return `
modern professional workplace,
career opportunity environment,
professional people working,
clean corporate office,
laptop and workspace
`;
}

function buildImagePrompt(post) {
  const visual = getOpportunityVisual(post);

  return `
Create a premium realistic LinkedIn career opportunity image.

OPPORTUNITY:
${post.title}

ORGANIZATION:
${post.companyName}

ROLE:
${post.role}

TYPE:
${post.opportunityType}

VISUAL THEME:
${post.imageTheme}

SCENE:
${visual}

STYLE:
photorealistic,
premium corporate photography,
professional LinkedIn aesthetic,
clean composition,
realistic lighting,
subtle depth of field,
high-end editorial photography,
modern,
trustworthy,
professional,
horizontal 1.91:1 composition

IMPORTANT:
- No logos
- No company branding
- No fake certificates
- No fake text
- No random letters
- No watermarks
- No distorted people
- No excessive futuristic effects
- No cartoon style
- No visible company trademarks

The image should visually communicate the actual opportunity type.
`;
}

/* =======================================================
   IMAGE OVERLAY
======================================================= */

function escapeSvgText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getOverlayLabel(type) {
  switch (type) {
    case "job":
      return "HIRING";

    case "internship":
      return "INTERNSHIP";

    case "scholarship":
      return "SCHOLARSHIP";

    case "fellowship":
      return "FELLOWSHIP";

    case "graduate_program":
      return "GRADUATE PROGRAM";

    default:
      return "OPPORTUNITY";
  }
}

async function generateImageWithCloudflare(post) {
  console.log("\n🎨 Generating opportunity-specific image...");

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

  let finalBuffer = imageBuffer;

  try {
    const sharpModule = await import("sharp");

    const sharp = sharpModule.default;

    const label = getOverlayLabel(post.opportunityType);

    const title = post.companyName;

    const subtitle = post.role;

    const safeLabel = escapeSvgText(label);

    const safeTitle = escapeSvgText(title);

    const safeSubtitle = escapeSvgText(subtitle);

    const svg = `
<svg
  width="1200"
  height="627"
  xmlns="http://www.w3.org/2000/svg"
>
  <defs>
    <linearGradient
      id="gradient"
      x1="0"
      y1="0"
      x2="1"
      y2="1"
    >
      <stop
        offset="0%"
        stop-color="rgba(0,0,0,0.78)"
      />

      <stop
        offset="100%"
        stop-color="rgba(0,0,0,0.25)"
      />
    </linearGradient>
  </defs>

  <rect
    x="0"
    y="0"
    width="1200"
    height="627"
    fill="url(#gradient)"
  />

  <rect
    x="55"
    y="55"
    width="360"
    height="75"
    rx="12"
    fill="rgba(0,0,0,0.65)"
  />

  <text
    x="85"
    y="105"
    font-family="Arial, Helvetica, sans-serif"
    font-size="38"
    font-weight="bold"
    fill="white"
  >
    ${safeLabel}
  </text>

  <text
    x="70"
    y="400"
    font-family="Arial, Helvetica, sans-serif"
    font-size="62"
    font-weight="bold"
    fill="white"
  >
    ${safeTitle}
  </text>

  <text
    x="70"
    y="465"
    font-family="Arial, Helvetica, sans-serif"
    font-size="34"
    fill="white"
  >
    ${safeSubtitle}
  </text>

  <rect
    x="70"
    y="500"
    width="220"
    height="6"
    rx="3"
    fill="white"
  />
</svg>
`;

    const overlay = Buffer.from(svg);

    finalBuffer = await sharp(imageBuffer)
      .resize(1200, 627, {
        fit: "cover",
      })
      .composite([
        {
          input: overlay,
          top: 0,
          left: 0,
        },
      ])
      .jpeg({
        quality: 90,
      })
      .toBuffer();
  } catch (error) {
    console.warn("⚠️ Overlay failed:", error.message);

    try {
      const sharpModule = await import("sharp");

      const sharp = sharpModule.default;

      finalBuffer = await sharp(imageBuffer)
        .resize(1200, 627, {
          fit: "cover",
        })
        .jpeg({
          quality: 90,
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
  if (!imagePath) return;

  try {
    await fs.unlink(imagePath);
  } catch {}
}

/* =======================================================
   LINKEDIN REQUEST
======================================================= */

async function linkedinRequest(url, options = {}, retries = 3) {
  let lastError;

  for (let i = 1; i <= retries; i++) {
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

      if (response.status >= 500 && i < retries) {
        console.log(
          `🔄 LinkedIn server error ${response.status}. Retry ${i}/${retries}`,
        );

        await sleep(2000 * i);

        continue;
      }

      return response;
    } catch (error) {
      lastError = error;

      if (i === retries) {
        throw error;
      }

      console.log(`🔄 LinkedIn request failed. Retry ${i}/${retries}`);

      await sleep(2000 * i);
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

  const json = JSON.parse(text);

  const value = json.value || {};

  const uploadUrl = value.uploadUrl;

  const image = value.image;

  if (!uploadUrl || !image) {
    throw new Error(
      "LinkedIn image initialization returned no upload URL/image URN.",
    );
  }

  return {
    uploadUrl,
    image,
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
      imageGenerated: Boolean(imagePath),
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
    .slice(-15)
    .map((post) => String(post.title || "").slice(0, 150))
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

      type: post.opportunityType || "other",

      companyName: post.companyName || null,

      role: post.role || null,

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

    type: post.opportunityType,

    companyName: post.companyName,

    role: post.role,

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

    /* ===============================================
       FETCH RECENT OPPORTUNITIES
    =============================================== */

    const opportunities = await researchOpportunities();

    /* ===============================================
       SELECT OPPORTUNITY
    =============================================== */

    const selected = await selectOpportunity(opportunities);

    console.log("\n🎯 SELECTED OPPORTUNITY");

    console.log(`📌 ${selected.title}`);

    console.log(`🏷️ Type: ${selected.category || "unknown"}`);

    console.log(`🔗 ${selected.url || "No URL"}`);

    /* ===============================================
       RECENT POST MEMORY
    =============================================== */

    const recentPosts = getRecentPostMemory();

    /* ===============================================
       AI GENERATION
    =============================================== */

    const enrichedOpportunity = {
      ...selected,

      recentPosts,
    };

    const post = await callGeneration(enrichedOpportunity, 3);

    /* ===============================================
       AI SKIP
    =============================================== */

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

    /* ===============================================
       DISPLAY
    =============================================== */

    console.log("\n📝 GENERATED OPPORTUNITY");

    console.log(`🏢 Organization: ${post.companyName}`);

    console.log(`💼 Role: ${post.role}`);

    console.log(`🏷️ Type: ${post.opportunityType}`);

    console.log(`📍 Location: ${post.location}`);

    console.log("\n----- GENERATED POST -----\n");

    console.log(post.content);

    console.log("\n--------------------------\n");

    /* ===============================================
       VALIDATION
    =============================================== */

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

    /* ===============================================
       IMAGE
    =============================================== */

    let imagePath = null;

    try {
      imagePath = await generateImageWithCloudflare(post);
    } catch (error) {
      console.warn("⚠️ Image generation failed:", error.message);
    }

    /* ===============================================
       PUBLISH
    =============================================== */

    let result;

    try {
      result = await publishToLinkedIn(post, imagePath);
    } finally {
      await cleanupImage(imagePath);
    }

    /* ===============================================
       SAVE
    =============================================== */

    await savePost(post, result);

    console.log("\n✅ CYCLE COMPLETED");

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

  console.log("🤖 INITIALIZING LINKEDIN OPPORTUNITY BOT V3.0.0");

  console.log("==============================================");

  await connectMongo();

  await loadState();

  console.log(`🧠 Groq: ${GROQ_MODEL}`);

  console.log("🔐 LinkedIn OAuth: enabled (personal profile)");

  console.log(`📡 LinkedIn API: ${LINKEDIN_VERSION}`);

  console.log(`🎨 Cloudflare: ${CLOUDFLARE_IMAGE_MODEL}`);

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`🎯 Daily limit: ${MAX_POSTS_PER_DAY}`);

  console.log(`📡 Opportunity feeds: ${OPPORTUNITY_FEEDS.length}`);

  const token = await getValidLinkedInAccessToken();

  const personUrn = await getLinkedInPersonUrn();

  console.log(`🔑 LinkedIn authorized: ${token ? "YES" : "NO"}`);

  if (personUrn) {
    console.log(`👤 Person URN: ${personUrn}`);
  }

  initialized = true;

  console.log("✅ LinkedIn opportunity bot initialized.");
}

/* =======================================================
   EXTERNAL ENTRY POINT
======================================================= */

async function runLinkedInBot() {
  await initializeLinkedInBot();

  return await safeRunCycle();
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

    opportunityFeeds: OPPORTUNITY_FEEDS.length,
  };
}

/* =======================================================
   SHUTDOWN
======================================================= */

async function shutdownLinkedInBot() {
  console.log("🛑 Shutting down LinkedIn opportunity bot...");

  try {
    await saveState();
  } catch {}

  await disconnectMongo();

  initialized = false;

  console.log("👋 LinkedIn opportunity bot shutdown complete.");
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
