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
LINKEDIN AI BOT V3.0.0 (REAL JOB SOURCING EDITION)
=========================================================
Key changes vs v2.1.0:
- Google News RSS replaced with real, structured job-board
  sources (Arbeitnow + RemoteOK). News headlines have no
  company/requirements/apply-link, which is why the old bot
  could not produce posts like your target example and had
  nothing real to post.
- Prompt + schema rewritten to match your target post style,
  using ONLY fields that came from the real listing (company,
  title, location, requirements, apply URL). No invented
  emails, deadlines, or salaries.
- Retry/backoff added around every network call that can
  transiently fail (job fetch, image generation, LinkedIn API).
- LinkedIn token expiry is now surfaced proactively, and a
  401 from LinkedIn clears the stored token immediately instead
  of failing silently on every future cycle.
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

// How many days before expiry to start logging loud warnings.
const TOKEN_EXPIRY_WARNING_DAYS = parsePositiveInteger(
  process.env.LINKEDIN_TOKEN_EXPIRY_WARNING_DAYS,
  5,
);

const STATE_FILE = path.join(__dirname, "linkedin-state.json");
const STATE_BACKUP_FILE = path.join(__dirname, "linkedin-state.backup.json");
const GENERATED_IMAGE_DIR = path.join(__dirname, "linkedin-generated-images");

// Real, keyless, structured job-board sources.
// Arbeitnow: broad international listings (includes remote + on-site).
// RemoteOK: remote-first tech jobs.
const ARBEITNOW_API_URL = "https://www.arbeitnow.com/api/job-board-api";
const REMOTEOK_API_URL = "https://remoteok.com/api";

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

function stripHtmlTags(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

/**
 * Generic retry-with-backoff wrapper for any async operation that can
 * transiently fail (network blips, rate limits, cold starts).
 * `shouldRetry` lets callers opt out of retrying permanent failures
 * (e.g. 401 auth errors) so we don't waste time/hammer the API.
 */
async function withRetry(
  fn,
  { retries = 3, baseDelayMs = 1000, label = "operation", shouldRetry } = {},
) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const canRetry = shouldRetry ? shouldRetry(error) : true;
      if (!canRetry || attempt >= retries) break;
      const delay = baseDelayMs * attempt;
      console.warn(
        `   ⚠️ ${label} failed (attempt ${attempt}/${retries}): ${error.message}. Retrying in ${delay}ms...`,
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

/* =======================================================
   MONGODB
======================================================= */

let mongoClient = null;
let jobListingsCollection = null;
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

    jobListingsCollection = db.collection("linkedin_job_listings");
    postHistoryCollection = db.collection("linkedin_post_history");
    linkedinTokensCollection = db.collection("linkedin_tokens");

    await jobListingsCollection.createIndex(
      { fingerprint: 1 },
      { unique: true },
    );
    await jobListingsCollection.createIndex({ used: 1, fetchedAt: -1 });
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
    jobListingsCollection = null;
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
        personUrn: data.personUrn || null,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function clearLinkedInToken(reason = "unspecified") {
  if (!linkedinTokensCollection) return;
  console.warn(`⚠️ Clearing stored LinkedIn token. Reason: ${reason}`);
  await linkedinTokensCollection.deleteOne({ provider: "linkedin" });
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
    scope: "openid profile email w_member_social",
  });

  return `${LINKEDIN_OAUTH_AUTHORIZE}?${params.toString()}`;
}

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

  const personId = await getLinkedInPersonId(accessToken);
  const personUrn = `urn:li:person:${personId}`;

  await saveLinkedInToken({
    accessToken,
    expiresAt,
    scope: json.scope || null,
    personUrn,
  });

  return { accessToken, expiresAt, scope: json.scope || null, personUrn };
}

async function getValidLinkedInAccessToken() {
  const stored = await getLinkedInToken();
  if (!stored?.accessToken) return null;

  if (stored.expiresAt && new Date(stored.expiresAt) <= new Date()) {
    console.warn("⚠️ Stored LinkedIn token has expired.");
    await clearLinkedInToken("expired");
    return null;
  }

  if (stored.expiresAt) {
    const daysLeft =
      (new Date(stored.expiresAt).getTime() - Date.now()) /
      (24 * 60 * 60 * 1000);
    if (daysLeft <= TOKEN_EXPIRY_WARNING_DAYS) {
      console.warn(
        `⚠️ LinkedIn token expires in ${daysLeft.toFixed(
          1,
        )} day(s). Re-authenticate via /auth/linkedin soon to avoid a gap.`,
      );
    }
  }

  return stored.accessToken;
}

/* =======================================================
   HANDLE OAUTH CALLBACK
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
   REAL JOB SOURCING (replaces Google News RSS)
======================================================= */

function fingerprintJob(job) {
  return `${job.company}::${job.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180);
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

async function fetchArbeitnowJobs() {
  const response = await withRetry(
    () => fetchWithTimeout(ARBEITNOW_API_URL, {}, 15000),
    { retries: 3, baseDelayMs: 1500, label: "Arbeitnow fetch" },
  );

  if (!response.ok) throw new Error(`Arbeitnow HTTP ${response.status}`);
  const json = await response.json();
  const items = Array.isArray(json?.data) ? json.data : [];

  return items.map((item) => ({
    source: "Arbeitnow",
    title: String(item.title || "").slice(0, 200),
    company: String(item.company_name || "").slice(0, 150),
    location: String(item.location || (item.remote ? "Remote" : "")).slice(
      0,
      120,
    ),
    remote: Boolean(item.remote),
    jobTypes: Array.isArray(item.job_types) ? item.job_types : [],
    tags: Array.isArray(item.tags) ? item.tags.slice(0, 10) : [],
    description: stripHtmlTags(item.description).slice(0, 2500),
    applyUrl: String(item.url || "").slice(0, 500),
    publishedAt: item.created_at
      ? new Date(item.created_at * 1000).toISOString()
      : null,
  }));
}

async function fetchRemoteOkJobs() {
  const response = await withRetry(
    () =>
      fetchWithTimeout(
        REMOTEOK_API_URL,
        { headers: { "User-Agent": "LinkedInAIBot/3.0" } },
        15000,
      ),
    { retries: 3, baseDelayMs: 1500, label: "RemoteOK fetch" },
  );

  if (!response.ok) throw new Error(`RemoteOK HTTP ${response.status}`);
  const json = await response.json();
  const items = Array.isArray(json) ? json.slice(1) : []; // first entry is metadata

  return items
    .filter((item) => item && item.position)
    .map((item) => ({
      source: "RemoteOK",
      title: String(item.position || "").slice(0, 200),
      company: String(item.company || "").slice(0, 150),
      location: String(item.location || "Remote").slice(0, 120) || "Remote",
      remote: true,
      jobTypes: [],
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 10) : [],
      description: stripHtmlTags(item.description).slice(0, 2500),
      applyUrl: String(item.url || item.apply_url || "").slice(0, 500),
      publishedAt: item.date ? new Date(item.date).toISOString() : null,
    }));
}

async function storeJobListings(jobs) {
  if (!jobListingsCollection || !Array.isArray(jobs) || jobs.length === 0) {
    return;
  }

  const operations = jobs
    .filter((job) => job.title && job.company && job.applyUrl)
    .map((job) => ({
      updateOne: {
        filter: { fingerprint: fingerprintJob(job) },
        update: {
          $setOnInsert: {
            ...job,
            fingerprint: fingerprintJob(job),
            fetchedAt: new Date(),
            used: false,
            usedAt: null,
          },
        },
        upsert: true,
      },
    }));

  if (operations.length === 0) return;

  try {
    await jobListingsCollection.bulkWrite(operations, { ordered: false });
  } catch (error) {
    console.warn("⚠️ Job listing storage failed:", error.message);
  }
}

async function pullJobListing() {
  if (!jobListingsCollection) return null;

  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  try {
    const result = await jobListingsCollection.findOneAndUpdate(
      { used: false, fetchedAt: { $gte: cutoff } },
      { $set: { used: true, usedAt: new Date() } },
      { sort: { fetchedAt: -1 }, returnDocument: "after" },
    );
    return result || null;
  } catch (error) {
    console.warn("⚠️ Job listing pull failed:", error.message);
    return null;
  }
}

/**
 * Fetches real, structured job listings from public job-board APIs.
 * Falls back gracefully if one source fails - as long as one source
 * succeeds we still have real jobs to post about.
 */
async function researchOpportunities() {
  console.log("\n🌐 [LinkedIn] Fetching real job listings...");

  const results = await Promise.allSettled([
    fetchArbeitnowJobs(),
    fetchRemoteOkJobs(),
  ]);

  let jobs = [];
  results.forEach((result, index) => {
    const label = index === 0 ? "Arbeitnow" : "RemoteOK";
    if (result.status === "fulfilled") {
      console.log(`   ✅ ${label}: ${result.value.length} jobs found.`);
      jobs = jobs.concat(result.value);
    } else {
      console.warn(`   ⚠️ ${label} failed: ${result.reason?.message}`);
    }
  });

  jobs = jobs.filter((job) => job.title && job.company && job.applyUrl);
  shuffleArray(jobs);

  if (jobs.length === 0) {
    console.warn("   ⚠️ No job listings retrieved from any source.");
  }

  await storeJobListings(jobs);
  return jobs;
}

async function selectJob(jobs) {
  const stored = await pullJobListing();
  if (stored) return { ...stored, fromDb: true };

  if (Array.isArray(jobs) && jobs.length) {
    const selected = jobs[Math.floor(Math.random() * jobs.length)];
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
    organization: { type: "string" },
    orgHashtag: { type: "string" },
    jobType: {
      type: "string",
      enum: ["Full-time", "Part-time", "Contract", "Internship", "Remote"],
    },
    industry: { type: "string" },
    location: { type: "string" },
    requirements: {
      type: "array",
      items: { type: "string" },
    },
    applyLine: { type: "string" },
    hashtags: {
      type: "array",
      items: { type: "string" },
    },
    imageQuery: { type: "string" },
    skip: { type: "boolean" },
    skipReason: { type: "string" },
  },
  required: [
    "title",
    "organization",
    "orgHashtag",
    "jobType",
    "industry",
    "location",
    "requirements",
    "applyLine",
    "hashtags",
    "imageQuery",
    "skip",
    "skipReason",
  ],
  additionalProperties: false,
};

function buildPostText(fields) {
  const {
    orgHashtag,
    organization,
    title,
    jobType,
    industry,
    location,
    requirements,
    applyLine,
    hashtags,
  } = fields;

  const reqLines = requirements
    .slice(0, 8)
    .map((req) => `🔹 ${req}`)
    .join("\n");

  const tagLine = hashtags
    .slice(0, 3)
    .map((tag) => (tag.startsWith("#") ? tag : `#${tag}`))
    .join(" ");

  return [
    `🚀 #${orgHashtag} is Hiring | ${title}`,
    "",
    `${organization} is looking for a ${title} to join their team.`,
    "",
    "📌 Key Details:",
    `* Job Type: ${jobType}`,
    `* Position: ${title}`,
    `* Industry: ${industry}`,
    `* Location: ${location}`,
    "",
    "What we're looking for:",
    reqLines,
    "",
    applyLine,
    "",
    tagLine,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join("\n")
    .trim();
}

function normalizePost(raw, sourceJob) {
  const allowedTypes = new Set([
    "Full-time",
    "Part-time",
    "Contract",
    "Internship",
    "Remote",
  ]);

  const fields = {
    title: String(raw?.title || "")
      .trim()
      .slice(0, 150),
    organization: String(raw?.organization || "")
      .trim()
      .slice(0, 150),
    orgHashtag: String(raw?.orgHashtag || "")
      .trim()
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 60),
    jobType: allowedTypes.has(raw?.jobType) ? raw.jobType : "Full-time",
    industry: String(raw?.industry || "")
      .trim()
      .slice(0, 100),
    location: String(raw?.location || "")
      .trim()
      .slice(0, 100),
    requirements: Array.isArray(raw?.requirements)
      ? raw.requirements
          .map((r) => stripEmojis(String(r || "")).trim())
          .filter(Boolean)
          .slice(0, 8)
      : [],
    applyLine: stripEmojis(String(raw?.applyLine || "")).trim(),
    hashtags: Array.isArray(raw?.hashtags)
      ? raw.hashtags.map((h) => String(h || "").trim()).filter(Boolean)
      : [],
    imageQuery: String(raw?.imageQuery || "professional office workspace")
      .trim()
      .slice(0, 150),
    skip: Boolean(raw?.skip),
    skipReason: String(raw?.skipReason || "").trim(),
  };

  // Hard safety net: always force the apply line to point at the REAL
  // apply URL from the source listing. Never trust the model to invent
  // contact details (emails, phone numbers, deadlines aren't in scope
  // here at all).
  if (sourceJob?.applyUrl) {
    fields.applyLine = `📩 Interested? Apply here: ${sourceJob.applyUrl}`;
  }

  const content = fields.skip ? "" : buildPostText(fields);

  return {
    ...fields,
    content,
    type: fields.jobType === "Internship" ? "internship" : "job",
  };
}

async function callGeneration(job, recentPosts, retries = 3) {
  const sourceBlock = `
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || "Not specified"}
Remote: ${job.remote ? "Yes" : "Unknown"}
Job type(s) from source: ${(job.jobTypes || []).join(", ") || "Not specified"}
Tags: ${(job.tags || []).join(", ") || "None"}
Apply URL: ${job.applyUrl}

Full description:
${job.description || "No further description provided."}
`;

  return withRetry(
    async () => {
      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          {
            role: "user",
            content: `
You write LinkedIn posts announcing real job openings, based ONLY on the
structured listing given below. You never invent facts that are not
supported by the listing.

Audience: students and early-career professionals.
Language: simple, clear, professional English.

STRICT RULES:
- Never invent a company name, salary, deadline, phone number, or email.
- "orgHashtag" must be the company name with spaces/punctuation removed
  (e.g. "Softpers Interactive" -> "Softpers"). If the company name is
  unclear or missing, set skip=true.
- "requirements" must be 4-8 short bullet phrases pulled or reasonably
  summarized from the actual description below. Do not invent skills
  that are not mentioned or clearly implied by the description.
- "applyLine" should be one short sentence inviting the reader to apply
  (do NOT include a URL or email yourself - that is added automatically
  from the verified source link).
- "industry" should be a short reasonable label (e.g. "IT Services /
  Software Development") inferred from the role/description.
- "hashtags" must be 2-3 relevant tags, no "#" prefix needed (added
  automatically), no spaces within a tag.
- If the listing is too vague, spammy, expired-looking, or not a real
  job (e.g. an aggregator page with no real employer), set skip=true
  and explain briefly in skipReason. Do not fabricate details to fill
  gaps - skip instead.
- "imageQuery" must describe a generic, non-branded, professional scene
  (no logos, no real people, no text).

REAL JOB LISTING (source of truth - use only this):
${sourceBlock}

RECENTLY POSTED TITLES (avoid repeating the same role/company):
${recentPosts || "None"}
`,
          },
        ],
        temperature: 0.4,
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

      return normalizePost(JSON.parse(raw), job);
    },
    { retries, baseDelayMs: 1500, label: "Groq generation" },
  );
}

/* =======================================================
   VALIDATION
======================================================= */

function validatePost(post) {
  const reasons = [];
  if (!post) return { valid: false, reasons: ["empty post"] };

  const content = String(post.content || "").trim();

  if (content.length < 80) reasons.push("post is too short");
  if (content.length > 3000) reasons.push("post is too long");
  if (!/key details/i.test(content))
    reasons.push("missing Key Details section");
  if (!post.requirements || post.requirements.length < 2)
    reasons.push("missing requirements");
  if (!/apply/i.test(content)) reasons.push("missing apply call-to-action");
  if (!post.organization) reasons.push("missing organization name");

  const hashtags = content.match(/#[a-zA-Z0-9_]+/g) || [];
  if (hashtags.length > 4) reasons.push("too many hashtags");

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

  return withRetry(
    async () => {
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
    },
    { retries: 2, baseDelayMs: 2000, label: "Cloudflare image generation" },
  );
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

class LinkedInAuthError extends Error {}

async function linkedinRequest(url, options = {}) {
  const token = await getValidLinkedInAccessToken();

  if (!token) {
    throw new LinkedInAuthError(
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
    // Token is dead (revoked/expired server-side even though our local
    // expiresAt said otherwise). Clear it now so the NEXT cycle fails
    // fast with a clear "please re-auth" message instead of repeating
    // this same silent failure every time.
    await clearLinkedInToken("LinkedIn API returned 401");
    throw new LinkedInAuthError(
      "LinkedIn rejected the access token (401). Re-authenticate via /auth/linkedin.",
    );
  }

  return response;
}

async function linkedinRequestWithRetry(url, options, label) {
  return withRetry(() => linkedinRequest(url, options), {
    retries: 3,
    baseDelayMs: 2000,
    label,
    shouldRetry: (error) => !(error instanceof LinkedInAuthError),
  });
}

async function registerImageUpload() {
  const personUrn = await getLinkedInPersonUrn();
  if (!personUrn) {
    throw new LinkedInAuthError(
      "No person URN found. Please re-authenticate via /auth/linkedin.",
    );
  }

  const response = await linkedinRequestWithRetry(
    `${LINKEDIN_API}/images?action=initializeUpload`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        initializeUploadRequest: { owner: personUrn },
      }),
    },
    "LinkedIn image init",
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
  const buffer = await fs.readFile(imagePath);

  await withRetry(
    async () => {
      const token = await getValidLinkedInAccessToken();
      if (!token) throw new LinkedInAuthError("No valid LinkedIn token.");

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
    },
    {
      retries: 3,
      baseDelayMs: 2000,
      label: "LinkedIn image upload",
      shouldRetry: (error) => !(error instanceof LinkedInAuthError),
    },
  );
}

async function createLinkedInPost(text, imageUrn = null) {
  const personUrn = await getLinkedInPersonUrn();
  if (!personUrn) {
    throw new LinkedInAuthError("No person URN found. Please re-authenticate.");
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
      media: { altText: "Career opportunity", id: imageUrn },
    };
  }

  const response = await linkedinRequestWithRetry(
    `${LINKEDIN_API}/posts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "LinkedIn create post",
  );

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
      organization: post.organization || null,
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
    organization: post.organization,
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
  console.log("🚀 LINKEDIN AI BOT V3.0.0");
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
      throw new LinkedInAuthError(
        "LinkedIn is not authorized. Open /auth/linkedin first.",
      );
    }

    const jobs = await researchOpportunities();
    const job = await selectJob(jobs);

    if (!job) {
      console.log("⏭️ No job listings available this cycle.");
      state.totalSkipped++;
      await saveState();
      return { success: false, skipped: true, reason: "no_jobs_found" };
    }

    const recentPosts = getRecentPostMemory();
    const post = await callGeneration(job, recentPosts, 3);

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
      console.warn("⚠️ Image generation failed after retries:", error.message);
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
    return {
      success: false,
      error: error?.message || "Unknown error",
      authError: error instanceof LinkedInAuthError,
    };
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
  console.log(`🔐 LinkedIn OAuth: enabled (personal profile)`);
  console.log(`📡 LinkedIn API: ${LINKEDIN_VERSION}`);
  console.log(`🎨 Cloudflare: ${CLOUDFLARE_IMAGE_MODEL}`);
  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  console.log(`🎯 Daily limit: ${MAX_POSTS_PER_DAY}`);

  const token = await getValidLinkedInAccessToken();
  const personUrn = await getLinkedInPersonUrn();
  console.log(`🔑 LinkedIn authorized: ${token ? "YES" : "NO"}`);
  if (personUrn) console.log(`👤 Person URN: ${personUrn}`);

  initialized = true;
  console.log("✅ LinkedIn bot initialized.");
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

  const tokenDoc = await getLinkedInToken();
  const token = await getValidLinkedInAccessToken();
  const personUrn = await getLinkedInPersonUrn();

  let daysUntilExpiry = null;
  if (tokenDoc?.expiresAt) {
    daysUntilExpiry = Number(
      (
        (new Date(tokenDoc.expiresAt).getTime() - Date.now()) /
        (24 * 60 * 60 * 1000)
      ).toFixed(1),
    );
  }

  return {
    service: "linkedin-ai-bot",
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
    tokenExpiresAt: tokenDoc?.expiresAt || null,
    daysUntilTokenExpiry: daysUntilExpiry,
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
