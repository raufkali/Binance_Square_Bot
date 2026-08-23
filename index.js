import Groq from "groq-sdk";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import http from "http";
import { MongoClient } from "mongodb";

dotenv.config();

/*
=========================================================
BINANCE SQUARE AI BOT V8.0.0
=========================================================

NEW IN V8
----------

- Generates a related image for EVERY post.
- Uses Cloudflare Workers AI for image generation.
- Saves generated image temporarily.
- Publishes the image through Binance Square image API.
- Automatically cleans temporary images after publishing.
- If image generation fails, the bot falls back to
  publishing the text post normally.

ARCHITECTURE

External Scheduler
        ↓
POST /post
        ↓
Google News RSS
        ↓
MongoDB trending topics
        ↓
Groq
        ↓
Text post generation
        ↓
Cloudflare Workers AI
        ↓
Related image
        ↓
Binance Square image publisher
        ↓
Persistent state + MongoDB

IMPORTANT

There is NO internal timer.
There is NO setInterval().
There is NO automatic startup post.

The server only creates a post when:

POST /post

is called with the correct authorization header.
=========================================================
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================================================
   CONFIG
======================================================= */

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const BINANCE_SQUARE_OPENAPI_KEY = process.env.BINANCE_SQUARE_OPENAPI_KEY;

const POST_TRIGGER_SECRET = process.env.POST_TRIGGER_SECRET;

const MONGODB_URI = process.env.MONGODB_URI;

const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "binance_square_bot";

const MAX_POSTS_PER_DAY = parsePositiveInteger(
  process.env.MAX_POSTS_PER_DAY,
  36,
);

const MAX_HISTORY = parsePositiveInteger(process.env.MAX_HISTORY, 200);

const REQUEST_TIMEOUT_MS = parsePositiveInteger(
  process.env.REQUEST_TIMEOUT_MS,
  30000,
);

const PORT = parsePositiveInteger(process.env.PORT, 3000);

const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Asia/Karachi";

const STATE_FILE = path.join(__dirname, "bot-state.json");

const STATE_BACKUP_FILE = path.join(__dirname, "bot-state.backup.json");

const SQUARE_TEXT_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-text.mjs",
);

const SQUARE_IMAGE_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-image.mjs",
);

const GENERATION_MAX_TOKENS = parsePositiveInteger(
  process.env.GENERATION_MAX_TOKENS,
  1800,
);

const TRENDING_TOPIC_MAX_AGE_HOURS = parsePositiveInteger(
  process.env.TRENDING_TOPIC_MAX_AGE_HOURS,
  36,
);

/*
=========================================================
CLOUDFLARE WORKERS AI
=========================================================

Set these in your .env / Render environment:

CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_TOKEN=your_token

Default model:

@cf/black-forest-labs/flux-1-schnell

You can change it with:

CLOUDFLARE_IMAGE_MODEL=...

=========================================================
*/

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const CLOUDFLARE_IMAGE_MODEL =
  process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

/*
Temporary directory for generated images.
*/

const GENERATED_IMAGE_DIR = path.join(__dirname, "generated-images");

/*
Google News RSS
*/

const GOOGLE_NEWS_URL =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(
    "crypto OR bitcoin OR ethereum OR binance OR solana OR XRP",
  ) +
  "&hl=en-US&gl=US&ceid=US:en";

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

/* =======================================================
   ENVIRONMENT VALIDATION
======================================================= */

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY is missing.");
  process.exit(1);
}

if (!BINANCE_SQUARE_OPENAPI_KEY) {
  console.error("❌ BINANCE_SQUARE_OPENAPI_KEY is missing.");
  process.exit(1);
}

if (!POST_TRIGGER_SECRET) {
  console.error("❌ POST_TRIGGER_SECRET is missing.");
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is missing.");
  process.exit(1);
}

if (!CLOUDFLARE_ACCOUNT_ID) {
  console.error("❌ CLOUDFLARE_ACCOUNT_ID is missing.");
  process.exit(1);
}

if (!CLOUDFLARE_API_TOKEN) {
  console.error("❌ CLOUDFLARE_API_TOKEN is missing.");
  process.exit(1);
}

/* =======================================================
   GROQ
======================================================= */

const groq = new Groq({
  apiKey: GROQ_API_KEY,
});

/* =======================================================
   MONGODB
======================================================= */

let mongoClient = null;
let db = null;
let trendingTopicsCollection = null;
let postHistoryCollection = null;

async function connectMongo() {
  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 5,
  });

  await mongoClient.connect();

  db = mongoClient.db(MONGODB_DB_NAME);

  trendingTopicsCollection = db.collection("trending_topics");

  postHistoryCollection = db.collection("post_history");

  await trendingTopicsCollection.createIndex({
    used: 1,
    fetchedAt: -1,
  });

  await trendingTopicsCollection.createIndex(
    { fingerprint: 1 },
    { unique: true },
  );

  await postHistoryCollection.createIndex({
    publishedAt: -1,
  });

  console.log("💾 MongoDB connected.");
}

async function disconnectMongo() {
  try {
    if (mongoClient) {
      await mongoClient.close();
      console.log("💾 MongoDB connection closed.");
    }
  } catch (error) {
    console.warn("⚠️ MongoDB close warning:", error.message);
  }
}

/* =======================================================
   TRENDING TOPICS
======================================================= */

function fingerprintTopic(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180);
}

async function storeTrendingTopics(newsItems) {
  if (!Array.isArray(newsItems) || newsItems.length === 0) {
    return;
  }

  const operations = newsItems.map((item) => {
    const fingerprint = fingerprintTopic(item.title);

    return {
      updateOne: {
        filter: { fingerprint },

        update: {
          $setOnInsert: {
            fingerprint,

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
    };
  });

  try {
    const result = await trendingTopicsCollection.bulkWrite(operations, {
      ordered: false,
    });

    console.log(
      `   💾 Trending topics stored: ${result.upsertedCount} new / ${newsItems.length} seen.`,
    );
  } catch (error) {
    console.warn("⚠️ Storing trending topics failed:", error.message);
  }
}

async function pullTrendingTopic() {
  const cutoff = new Date(
    Date.now() - TRENDING_TOPIC_MAX_AGE_HOURS * 60 * 60 * 1000,
  );

  try {
    const topic = await trendingTopicsCollection.findOneAndUpdate(
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
          fetchedAt: -1,
        },

        returnDocument: "after",
      },
    );

    return topic || null;
  } catch (error) {
    console.warn("⚠️ Pulling trending topic failed:", error.message);

    return null;
  }
}

async function pruneStaleTopics() {
  const cutoff = new Date(
    Date.now() - TRENDING_TOPIC_MAX_AGE_HOURS * 4 * 60 * 60 * 1000,
  );

  try {
    await trendingTopicsCollection.deleteMany({
      fetchedAt: {
        $lt: cutoff,
      },
    });
  } catch (error) {
    console.warn("⚠️ Pruning stale topics failed:", error.message);
  }
}

async function storePostHistory(post, result) {
  try {
    await postHistoryCollection.insertOne({
      id: result?.id || null,

      title: post.title || null,

      topic: post.topic || "crypto",

      text: post.content,

      qualityScore: post.qualityScore,

      newsUsed: Boolean(post.newsUsed),

      catalystConfidence: post.catalystConfidence,

      imageGenerated: Boolean(post.imageGenerated),

      imageGenerationFailed: Boolean(post.imageGenerationFailed),

      publishedAt: new Date(),

      dryRun: Boolean(result?.dryRun),
    });
  } catch (error) {
    console.warn("⚠️ Storing post history in MongoDB failed:", error.message);
  }
}

/* =======================================================
   TOPIC POOL
======================================================= */

const TOPICS = [
  "Bitcoin",
  "Ethereum",
  "BNB",
  "Solana",
  "XRP",
  "Bitcoin dominance",
  "Altcoin season",
  "Crypto market sentiment",
  "Bull markets",
  "Bear markets",
  "Crypto market cycles",
  "Bitcoin adoption",
  "Ethereum ecosystem",
  "Solana ecosystem",
  "BNB ecosystem",
  "DeFi",
  "Web3",
  "Crypto whales",
  "Crypto liquidity",
  "Crypto volatility",
  "Trading psychology",
  "Risk management",
  "Common crypto trading mistakes",
  "Long-term crypto investing",
  "Crypto portfolio management",
  "Blockchain adoption",
  "Crypto regulation",
  "Institutional crypto adoption",
  "Bitcoin ETFs",
  "Ethereum ETFs",
  "Stablecoins",
  "Layer 1 blockchains",
  "Layer 2 networks",
  "Decentralized exchanges",
  "Centralized exchanges",
  "Memecoins",
  "Crypto security",
  "Crypto wallets",
  "Self custody",
  "On-chain activity",
  "Crypto market momentum",
  "Support and resistance",
  "Technical analysis concepts",
  "Crypto fundamentals",
  "Bitcoin halving",
  "Ethereum upgrades",
  "Blockchain scalability",
  "Crypto payments",
  "Real-world blockchain applications",
  "Future of cryptocurrency",
];

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

/* =======================================================
   LOCAL DATE
======================================================= */

function getLocalDate() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TIMEZONE,

    year: "numeric",

    month: "2-digit",

    day: "2-digit",
  });

  return formatter.format(new Date());
}

/* =======================================================
   STATE LOAD
======================================================= */

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

      console.log("💾 State loaded successfully.");
    }
  } catch {
    console.warn("⚠️ Primary state unavailable.");
  }

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

        console.log("♻️ Backup state restored.");
      }
    } catch {
      console.log("ℹ️ No usable state file found.");
    }
  }

  normalizeState();

  resetDailyCounter();

  if (!loaded) {
    await saveState();

    console.log("💾 Fresh state created.");
  }
}

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

  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }
}

let stateSaveRunning = Promise.resolve();

async function saveState() {
  stateSaveRunning = stateSaveRunning
    .catch(() => {})
    .then(async () => {
      const tempFile = `${STATE_FILE}.tmp`;

      const json = JSON.stringify(state, null, 2);

      await fs.writeFile(tempFile, json, "utf8");

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
    console.log(`📅 New local day detected: ${today}`);

    state.date = today;

    state.postsToday = 0;

    saveState().catch((error) => {
      console.error("⚠️ Daily reset save failed:", error.message);
    });
  }
}

/* =======================================================
   FETCH WITH TIMEOUT
======================================================= */

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

/* =======================================================
   XML HELPERS
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
    .replace(/&#x2F;/gi, "/");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getXmlTag(xml, tag) {
  const regex = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");

  const match = xml.match(regex);

  if (!match) return "";

  return decodeXml(stripHtml(match[1])).trim();
}

/* =======================================================
   GOOGLE NEWS RESEARCH
======================================================= */

async function researchWeb() {
  console.log("\n🌐 Searching Google News RSS...");

  try {
    const response = await fetchWithTimeout(GOOGLE_NEWS_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 BinanceSquareAI/8.0",

        Accept: "application/rss+xml, application/xml, text/xml",
      },
    });

    if (!response.ok) {
      throw new Error(`Google News HTTP ${response.status}`);
    }

    const xml = await response.text();

    if (!xml || xml.length < 100) {
      throw new Error("Google News returned an empty response.");
    }

    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

    if (items.length === 0) {
      throw new Error("No RSS items found.");
    }

    const news = [];

    for (const match of items.slice(0, 20)) {
      const item = match[1];

      const title = getXmlTag(item, "title");

      const description = getXmlTag(item, "description");

      const publishedAt = getXmlTag(item, "pubDate");

      const source = getXmlTag(item, "source");

      if (!title) continue;

      news.push({
        title: title.slice(0, 300),

        description: description.slice(0, 700),

        publishedAt: publishedAt.slice(0, 100),

        source: source.slice(0, 150),
      });
    }

    if (news.length === 0) {
      throw new Error("RSS contained no usable articles.");
    }

    shuffleArray(news);

    console.log(`   ✅ ${news.length} fresh news items found.`);

    await storeTrendingTopics(news);

    return news;
  } catch (error) {
    console.warn(`   ⚠️ Research failed: ${error.message}`);

    console.log("   ↪️ Will rely on stored trending topics / topic pool.");

    return [];
  }
}

/* =======================================================
   RANDOM TOPIC
======================================================= */

function getRandomTopic() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

/* =======================================================
   SHUFFLE
======================================================= */

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
}

/* =======================================================
   RECENT POST MEMORY
======================================================= */

function getRecentPostMemory() {
  return state.history
    .slice(-12)
    .map((post) => {
      const topic = String(post.topic || "crypto");

      const text = String(post.text || "")
        .replace(/\s+/g, " ")
        .slice(0, 200);

      return `${topic}: ${text}`;
    })
    .join("\n");
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

    topic: {
      type: "string",

      enum: ["bitcoin", "ethereum", "bnb", "solana", "xrp", "market", "crypto"],
    },

    content: {
      type: "string",
    },

    qualityScore: {
      type: "number",
    },

    newsUsed: {
      type: "boolean",
    },

    catalystConfidence: {
      type: "string",

      enum: ["LOW", "MEDIUM", "HIGH", "NONE"],
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
    "topic",
    "content",
    "qualityScore",
    "newsUsed",
    "catalystConfidence",
    "skip",
    "skipReason",
  ],

  additionalProperties: false,
};

/* =======================================================
   GROQ GENERATION
======================================================= */

async function callGeneration(
  prompt,
  maxTokens = GENERATION_MAX_TOKENS,
  retries = 3,
) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`   🧠 Groq generation attempt ${attempt}/${retries}...`);

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,

        messages: [
          {
            role: "user",

            content: `
You are an experienced crypto writer posting on Binance Square under your own
name. You are not an AI assistant and you should never sound like one.

GOAL

Write one post that makes a reader stop scrolling because the headline raises
a real question in their head, then answer it in a satisfying, honest way.

VOICE AND STYLE

- Plain, everyday language.
- Short sentences.
- Short paragraphs.
- No emojis.
- No emoji-style bullet symbols.
- No hashtags inside the body.
- No AI-sounding phrases.
- No exclamation-point hype.
- No ALL CAPS words.
- First line must work as a headline.
- Headline should be specific and interesting.
- Avoid generic headlines.
- End with one genuine question.

HARD RULES

- Do not invent current prices.
- Do not invent exact percentage movements.
- Do not invent breaking news.
- If research is provided, use only information supported by it.
- If research is not provided, discuss the fallback topic generally.
- Do not give financial advice.
- Do not tell anyone to buy or sell.
- Do not promise profits.
- Do not fabricate statistics.
- Do not use manipulative urgency.
- Include exactly 3 hashtags at the very end.
- End with exactly:

Not financial advice.

Post length: 700-1400 characters approximately.

${prompt}
`,
          },
        ],

        temperature: 0.85,

        max_completion_tokens: maxTokens,

        reasoning_effort: "low",

        reasoning_format: "hidden",

        response_format: {
          type: "json_schema",

          json_schema: {
            name: "binance_square_post",

            strict: true,

            schema: POST_SCHEMA,
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
      } catch {
        throw new Error(
          "Groq returned invalid JSON despite structured output.",
        );
      }

      return normalizeGeneratedPost(parsed);
    } catch (error) {
      console.warn(`   ⚠️ Groq attempt ${attempt} failed: ${error.message}`);

      if (attempt >= retries) {
        throw error;
      }

      await sleep(1500 * attempt);
    }
  }

  throw new Error("Groq generation failed.");
}

/* =======================================================
   NORMALIZE POST
======================================================= */

function normalizeGeneratedPost(post) {
  const normalized = {
    title: String(post?.title || "Crypto Market Discussion")
      .trim()
      .slice(0, 120),

    topic: String(post?.topic || "crypto")
      .toLowerCase()
      .trim(),

    content: String(post?.content || "").trim(),

    qualityScore: Number.isFinite(Number(post?.qualityScore))
      ? Number(post.qualityScore)
      : 7,

    newsUsed: Boolean(post?.newsUsed),

    catalystConfidence: String(
      post?.catalystConfidence || "NONE",
    ).toUpperCase(),

    skip: Boolean(post?.skip),

    skipReason: String(post?.skipReason || "").trim(),
  };

  const allowedTopics = new Set([
    "bitcoin",
    "ethereum",
    "bnb",
    "solana",
    "xrp",
    "market",
    "crypto",
  ]);

  if (!allowedTopics.has(normalized.topic)) {
    normalized.topic = "crypto";
  }

  if (
    !["LOW", "MEDIUM", "HIGH", "NONE"].includes(normalized.catalystConfidence)
  ) {
    normalized.catalystConfidence = "NONE";
  }

  return normalized;
}

/* =======================================================
   HASHTAGS
======================================================= */

function ensureHashtags(content, topic = "crypto") {
  const MAX_HASHTAGS = 3;

  let text = String(content || "").trim();

  text = text
    .replace(/#[a-zA-Z0-9_]+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const defaultTags = {
    bitcoin: ["#Bitcoin", "#BTC", "#Crypto"],

    ethereum: ["#Ethereum", "#ETH", "#Crypto"],

    bnb: ["#BNB", "#Binance", "#Crypto"],

    solana: ["#Solana", "#SOL", "#Crypto"],

    xrp: ["#XRP", "#Ripple", "#Crypto"],

    market: ["#Crypto", "#Market", "#Trading"],

    crypto: ["#Crypto", "#Binance", "#Blockchain"],
  };

  const normalizedTopic = String(topic || "crypto")
    .toLowerCase()
    .trim();

  const selectedTags = defaultTags[normalizedTopic] || defaultTags.crypto;

  const finalTags = [];

  for (const tag of selectedTags) {
    if (finalTags.length >= MAX_HASHTAGS) {
      break;
    }

    if (
      !finalTags.some(
        (existing) => existing.toLowerCase() === tag.toLowerCase(),
      )
    ) {
      finalTags.push(tag);
    }
  }

  const fallbackTags = ["#Crypto", "#Binance", "#Blockchain"];

  for (const tag of fallbackTags) {
    if (finalTags.length >= MAX_HASHTAGS) {
      break;
    }

    if (
      !finalTags.some(
        (existing) => existing.toLowerCase() === tag.toLowerCase(),
      )
    ) {
      finalTags.push(tag);
    }
  }

  text = text.replace(/Not financial advice\.\s*$/i, "").trim();

  return `${text}\n\n${finalTags.join(" ")}\n\nNot financial advice.`;
}

/* =======================================================
   FALLBACK POST
======================================================= */

function buildFallbackPost(selectedTopic, fallbackTopic) {
  const topic = selectedTopic?.title || fallbackTopic;

  const newsIntro = selectedTopic
    ? `People are talking about this right now: "${topic}"\n\n`
    : `Here's something worth thinking about today: ${topic}.\n\n`;

  const templates = [
    `${newsIntro}Most people react to crypto news by asking what it means for price. That's usually the wrong first question.

The better question is why this particular story is getting attention right now, and whether it changes anything for people who are actually building or using this technology.

Prices move for a hundred reasons. Understanding shifts for far fewer.

What's your read on this one?`,

    `${newsIntro}Here's a pattern worth noticing: the stories that move markets are rarely the ones people expected a week earlier.

That's not a reason to panic or to chase headlines. It's a reason to pay attention to what's actually changing versus what's just noise.

So, is this signal or noise to you?`,

    `${newsIntro}A lot of people skim past stories like this because it doesn't come with a price target attached.

But the things that actually move this space long term rarely show up as a single dramatic number. They show up as small shifts that compound.

Curious how you're reading this one.`,
  ];

  const content = templates[Math.floor(Math.random() * templates.length)];

  return {
    title: String(topic).slice(0, 60),

    topic: "crypto",

    content: ensureHashtags(content, "crypto"),

    qualityScore: 7,

    newsUsed: Boolean(selectedTopic),

    catalystConfidence: selectedTopic ? "LOW" : "NONE",

    skip: false,

    skipReason: "",
  };
}

/* =======================================================
   SELECT TOPIC
======================================================= */

async function selectTopic(newsResearch) {
  const stored = await pullTrendingTopic();

  if (stored) {
    return {
      title: stored.title,

      description: stored.description,

      publishedAt: stored.publishedAt,

      source: stored.source,

      fromDb: true,
    };
  }

  if (Array.isArray(newsResearch) && newsResearch.length > 0) {
    const picked =
      newsResearch[Math.floor(Math.random() * newsResearch.length)];

    return {
      ...picked,
      fromDb: false,
    };
  }

  return null;
}

/* =======================================================
   GENERATE POST
======================================================= */

async function generatePost(newsResearch) {
  const recentPosts = getRecentPostMemory();

  const selectedTopic = await selectTopic(newsResearch);

  const fallbackTopic = getRandomTopic();

  console.log("\n🎯 Selected topic:");

  if (selectedTopic) {
    console.log(`   📰 ${selectedTopic.title}`);

    console.log(
      `   🗄️ Source: ${
        selectedTopic.fromDb ? "MongoDB trending store" : "live RSS"
      }`,
    );
  } else {
    console.log(`   💡 ${fallbackTopic}`);
  }

  let researchBlock = "NO CURRENT WEB RESEARCH AVAILABLE.";

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
CURRENT WEB RESEARCH:

${researchBlock}

FALLBACK TOPIC:

${fallbackTopic}

RECENT POSTS:

${recentPosts || "None"}

TASK:

Create exactly ONE Binance Square crypto post.

If current web research exists:
- Use it as the seed.
- Do not add unsupported facts.
- Treat the headline as reported information.

If current web research is unavailable:
- Use the fallback topic.
- Find an interesting angle.

Set newsUsed to true only when current web research was actually used.
Set skip to false unless there is genuinely no usable way to create a post.
`;

  try {
    const post = await callGeneration(prompt, GENERATION_MAX_TOKENS, 3);

    post.content = ensureHashtags(post.content, post.topic);

    post.content = forceDisclaimer(post.content);

    return post;
  } catch (error) {
    console.error("⚠️ Groq generation failed:", error.message);

    console.log("↪️ Building fallback post.");

    return buildFallbackPost(selectedTopic, fallbackTopic);
  }
}

/* =======================================================
   FORCE DISCLAIMER
======================================================= */

function forceDisclaimer(content) {
  let text = String(content || "").trim();

  text = text.replace(/not financial advice\.?/gi, "").trim();

  return `${text}\n\nNot financial advice.`;
}

/* =======================================================
   VALIDATION
======================================================= */

function validatePost(post) {
  const reasons = [];

  if (!post) {
    return {
      valid: false,
      reasons: ["empty post"],
    };
  }

  const content = String(post.content || "").trim();

  if (content.length < 100) {
    reasons.push("post is too short");
  }

  if (content.length > 5000) {
    reasons.push("post is too long");
  }

  const lower = content.toLowerCase();

  const forbidden = [
    "guaranteed profit",
    "guaranteed return",
    "guaranteed returns",
    "risk free",
    "risk-free",
    "100% profit",
    "double your money",
    "can't lose",
    "cannot lose",
    "buy now",
    "sell now",
    "easy money",
    "guaranteed gains",
    "no risk",
    "zero risk",
    "don't miss out",
    "last chance",
    "before it's too late",
  ];

  for (const phrase of forbidden) {
    if (lower.includes(phrase)) {
      reasons.push(`forbidden phrase: ${phrase}`);
    }
  }

  const hashtags = content.match(/#[a-zA-Z0-9_]+/g) || [];

  if (hashtags.length < 3) {
    reasons.push(`hashtags count: ${hashtags.length}`);
  }

  if (!lower.includes("not financial advice")) {
    reasons.push("missing disclaimer");
  }

  const suspiciousPatterns = [
    /\$\d[\d,.]*\s*(?:today|now|currently)/i,

    /\d+(?:\.\d+)?%\s*(?:today|now|currently)/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(content)) {
      reasons.push("contains an unsupported live-market claim");

      break;
    }
  }

  return {
    valid: reasons.length === 0,

    reasons,
  };
}

/* =======================================================
   DUPLICATE CHECK
======================================================= */

function isDuplicate() {
  return {
    duplicate: false,
    score: 0,
  };
}

/* =======================================================
   IMAGE PROMPT
======================================================= */

/*
Creates a clean prompt specifically for
Cloudflare's image model.

IMPORTANT:

We deliberately tell the model:

- no text
- no logos
- no watermarks
- no UI
- no charts containing fake numbers

This makes the image more suitable for
Binance Square.
*/

function buildImagePrompt(post) {
  const topic = String(post?.topic || "crypto").toLowerCase();

  const title = String(post?.title || "").slice(0, 250);

  const content = String(post?.content || "")
    .replace(/#[a-zA-Z0-9_]+/g, "")
    .replace(/Not financial advice\./gi, "")
    .slice(0, 700);

  return `
Create a high-quality editorial crypto illustration for a Binance Square social media post.

Main topic: ${topic}

Headline:
${title}

Context:
${content}

Visual direction:
- modern premium crypto editorial artwork
- cinematic composition
- visually striking but realistic
- professional financial media aesthetic
- strong depth and lighting
- clean composition
- suitable for a social media feed
- focus on the main crypto concept
- visually communicate the idea of the post
- no unnecessary clutter

STRICT NEGATIVE REQUIREMENTS:
- no text
- no letters
- no words
- no numbers
- no captions
- no logos
- no brand logos
- no Binance logo
- no watermarks
- no UI screenshots
- no fake price charts
- no readable cryptocurrency symbols
- no signatures
- no borders
- no image frames
`;
}

/* =======================================================
   CLOUDFLARE IMAGE GENERATION
======================================================= */

async function generateImageWithCloudflare(post) {
  console.log("\n🎨 Generating related image with Cloudflare Workers AI...");

  const prompt = buildImagePrompt(post);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/${CLOUDFLARE_IMAGE_MODEL}`;
  try {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,

          "Content-Type": "application/json",
        },

        body: JSON.stringify({
          prompt,
        }),
      },

      120000,
    );

    if (!response.ok) {
      const errorText = await response.text();

      throw new Error(`Cloudflare API error ${response.status}: ${errorText}`);
    }

    const contentType = response.headers.get("content-type") || "";

    let imageBuffer;

    /*
    Most Workers AI image models return
    the generated image directly as binary.

    Some configurations may return JSON.
    We support both.
    */

    if (contentType.includes("application/json")) {
      const json = await response.json();

      let base64Image =
        json?.result?.image ||
        json?.result?.output ||
        json?.image ||
        json?.output;

      if (Array.isArray(base64Image)) {
        base64Image = base64Image[0];
      }

      if (typeof base64Image !== "string") {
        throw new Error(
          "Cloudflare returned JSON but no image data was found.",
        );
      }

      /*
      Remove data URI prefix if present.
      */

      base64Image = base64Image.replace(/^data:image\/[^;]+;base64,/i, "");

      imageBuffer = Buffer.from(base64Image, "base64");
    } else {
      const arrayBuffer = await response.arrayBuffer();

      imageBuffer = Buffer.from(arrayBuffer);
    }

    if (!imageBuffer || imageBuffer.length < 1000) {
      throw new Error("Cloudflare returned an empty or invalid image.");
    }

    await fs.mkdir(GENERATED_IMAGE_DIR, {
      recursive: true,
    });

    const timestamp = Date.now();

    const random = Math.random().toString(36).slice(2, 8);

    const imagePath = path.join(
      GENERATED_IMAGE_DIR,
      `binance-${timestamp}-${random}.png`,
    );

    await fs.writeFile(imagePath, imageBuffer);

    console.log(`   ✅ Image generated: ${imagePath}`);

    console.log(
      `   📦 Image size: ${(imageBuffer.length / 1024).toFixed(1)} KB`,
    );

    return imagePath;
  } catch (error) {
    console.error("❌ Cloudflare image generation failed:", error.message);

    throw error;
  }
}

/* =======================================================
   CLEAN GENERATED IMAGE
======================================================= */

async function cleanupGeneratedImage(imagePath) {
  if (!imagePath) return;

  try {
    await fs.unlink(imagePath);

    console.log("🧹 Temporary image deleted.");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("⚠️ Could not delete temporary image:", error.message);
    }
  }
}

/* =======================================================
   PUBLISH TEXT TO BINANCE
======================================================= */

function publishTextToSquare(content) {
  return new Promise((resolve, reject) => {
    console.log("\n📡 Publishing text to Binance Square...");

    if (DRY_RUN) {
      console.log("🧪 DRY_RUN=true");

      console.log("\n----- GENERATED POST -----\n");

      console.log(content);

      console.log("\n--------------------------\n");

      resolve({
        success: true,

        dryRun: true,

        id: null,

        link: null,
      });

      return;
    }

    fs.access(SQUARE_TEXT_SCRIPT)
      .then(() => {
        const child = spawn("node", [SQUARE_TEXT_SCRIPT, "--text", content], {
          cwd: path.join(__dirname, ".agents", "skills", "square-post"),

          env: {
            ...process.env,

            BINANCE_SQUARE_OPENAPI_KEY,
          },

          shell: false,

          windowsHide: true,
        });

        let stdout = "";

        let stderr = "";

        let settled = false;

        const finishReject = (error) => {
          if (settled) return;

          settled = true;

          reject(error);
        };

        const finishResolve = (value) => {
          if (settled) return;

          settled = true;

          resolve(value);
        };

        child.stdout.on("data", (data) => {
          const text = data.toString();

          stdout += text;

          process.stdout.write(text);
        });

        child.stderr.on("data", (data) => {
          const text = data.toString();

          stderr += text;

          process.stderr.write(text);
        });

        child.on("error", (error) => {
          finishReject(error);
        });

        child.on("close", (code) => {
          if (code !== 0) {
            finishReject(
              new Error(`Square publisher exited with code ${code}\n${stderr}`),
            );

            return;
          }

          const id = stdout.match(/ID:\s*(.+)/i)?.[1]?.trim() || null;

          const link = stdout.match(/Link:\s*(.+)/i)?.[1]?.trim() || null;

          finishResolve({
            success: true,

            dryRun: false,

            id,

            link,

            stdout,
          });
        });
      })
      .catch((error) => {
        reject(
          new Error(
            `Binance Square publisher script not found: ${error.message}`,
          ),
        );
      });
  });
}

/* =======================================================
   PUBLISH IMAGE TO BINANCE
======================================================= */

function publishImageToSquare(content, imagePath) {
  return new Promise((resolve, reject) => {
    console.log("\n📡 Publishing image post to Binance Square...");

    if (DRY_RUN) {
      console.log("🧪 DRY_RUN=true");

      console.log("\n----- GENERATED POST -----\n");

      console.log(content);

      console.log("\n🖼️ Image:");

      console.log(imagePath);

      console.log("\n--------------------------\n");

      resolve({
        success: true,

        dryRun: true,

        id: null,

        link: null,
      });

      return;
    }

    fs.access(SQUARE_IMAGE_SCRIPT)
      .then(() => {
        const child = spawn(
          "node",
          [SQUARE_IMAGE_SCRIPT, "--text", content, "--images", imagePath],
          {
            cwd: path.join(__dirname, ".agents", "skills", "square-post"),

            env: {
              ...process.env,

              BINANCE_SQUARE_OPENAPI_KEY,
            },

            shell: false,

            windowsHide: true,
          },
        );

        let stdout = "";

        let stderr = "";

        let settled = false;

        const finishReject = (error) => {
          if (settled) return;

          settled = true;

          reject(error);
        };

        const finishResolve = (value) => {
          if (settled) return;

          settled = true;

          resolve(value);
        };

        child.stdout.on("data", (data) => {
          const text = data.toString();

          stdout += text;

          process.stdout.write(text);
        });

        child.stderr.on("data", (data) => {
          const text = data.toString();

          stderr += text;

          process.stderr.write(text);
        });

        child.on("error", (error) => {
          finishReject(error);
        });

        child.on("close", (code) => {
          if (code !== 0) {
            finishReject(
              new Error(
                `Square image publisher exited with code ${code}\n${stderr}`,
              ),
            );

            return;
          }

          const id = stdout.match(/ID:\s*(.+)/i)?.[1]?.trim() || null;

          const link = stdout.match(/Link:\s*(.+)/i)?.[1]?.trim() || null;

          finishResolve({
            success: true,

            dryRun: false,

            id,

            link,

            stdout,
          });
        });
      })
      .catch((error) => {
        reject(
          new Error(
            `Binance Square image publisher script not found: ${error.message}`,
          ),
        );
      });
  });
}

/* =======================================================
   GENERATE + PUBLISH IMAGE
======================================================= */

async function generateAndPublishImage(post) {
  let imagePath = null;

  try {
    imagePath = await generateImageWithCloudflare(post);

    const result = await publishImageToSquare(post.content, imagePath);

    return {
      ...result,

      imageGenerated: true,
    };
  } finally {
    await cleanupGeneratedImage(imagePath);
  }
}

/* =======================================================
   SAVE POST
======================================================= */

async function savePost(post, result) {
  state.history.push({
    id: result?.id || null,

    title: post.title || null,

    topic: post.topic || "crypto",

    text: post.content,

    qualityScore: post.qualityScore,

    newsUsed: Boolean(post.newsUsed),

    catalystConfidence: post.catalystConfidence,

    imageGenerated: Boolean(post.imageGenerated),

    imageGenerationFailed: Boolean(post.imageGenerationFailed),

    publishedAt: new Date().toISOString(),

    dryRun: Boolean(result?.dryRun),
  });

  if (!result?.dryRun) {
    state.postsToday++;

    state.totalPosts++;

    state.lastPostAt = new Date().toISOString();
  }

  await saveState();

  await storePostHistory(post, result);
}

/* =======================================================
   MAIN POST CYCLE
======================================================= */

async function runCycle() {
  resetDailyCounter();

  console.log("\n================================================");

  console.log("🚀 BINANCE SQUARE AI BOT V8.0.0");

  console.log("================================================");

  console.log(
    `🕐 ${new Date().toLocaleString("en-US", {
      timeZone: BOT_TIMEZONE,
    })}`,
  );

  console.log(`🌍 Timezone: ${BOT_TIMEZONE}`);

  console.log(`📅 Posts: ${state.postsToday}/${MAX_POSTS_PER_DAY}`);

  if (state.postsToday >= MAX_POSTS_PER_DAY) {
    console.log("\n🛑 Daily limit reached.");

    state.totalSkipped++;

    await saveState();

    return {
      success: false,

      skipped: true,

      reason: "daily_limit",
    };
  }

  try {
    /*
    ===============================================
    STEP 1
    ===============================================
    */

    const news = await researchWeb();

    console.log(`\n📰 Research items available: ${news.length}`);

    pruneStaleTopics().catch(() => {});

    /*
    ===============================================
    STEP 2
    ===============================================
    */

    const post = await generatePost(news);

    console.log("\n📝 Topic:", post.topic);

    console.log("⭐ Quality:", `${post.qualityScore}/10`);

    console.log("📰 Web research used:", post.newsUsed);

    console.log("🎯 Catalyst confidence:", post.catalystConfidence);

    if (post.skip) {
      console.log("\n⏭️ AI skipped this cycle.");

      console.log("Reason:", post.skipReason || "No reason provided.");

      state.totalSkipped++;

      await saveState();

      return {
        success: false,

        skipped: true,

        reason: post.skipReason || "ai_skip",
      };
    }

    /*
    ===============================================
    STEP 3
    VALIDATION
    ===============================================
    */

    console.log("\n🛡️ Running safety validation...");

    const validation = validatePost(post);

    if (!validation.valid) {
      console.error("❌ Post rejected by safety validation.");

      for (const reason of validation.reasons) {
        console.error(`   • ${reason}`);
      }

      state.totalSkipped++;

      await saveState();

      return {
        success: false,

        skipped: true,

        reason: "validation_failed",

        validation: validation.reasons,
      };
    }

    console.log("   ✓ Safety validation passed.");

    /*
    ===============================================
    STEP 4
    DUPLICATE CHECK
    ===============================================
    */

    const duplicate = isDuplicate();

    if (duplicate.duplicate) {
      console.log("⏭️ Duplicate detected.");

      state.totalSkipped++;

      await saveState();

      return {
        success: false,

        skipped: true,

        reason: "duplicate",
      };
    }

    console.log("   ✓ Duplicate protection disabled.");

    /*
    ===============================================
    STEP 5
    IMAGE GENERATION
    ===============================================
    */

    let result;

    try {
      console.log("\n🎨 IMAGE PIPELINE STARTING");

      result = await generateAndPublishImage(post);

      post.imageGenerated = true;

      post.imageGenerationFailed = false;

      console.log("\n🖼️ Image post published successfully.");
    } catch (imageError) {
      /*
      IMPORTANT:

      If Cloudflare temporarily fails,
      we DO NOT lose the entire post.

      The bot falls back to a normal
      text post.
      */

      console.error("\n⚠️ Image pipeline failed:", imageError.message);

      console.log("↪️ Falling back to text-only Binance Square post.");

      post.imageGenerated = false;

      post.imageGenerationFailed = true;

      result = await publishTextToSquare(post.content);
    }

    /*
    ===============================================
    STEP 6
    SAVE
    ===============================================
    */

    await savePost(post, result);

    console.log("\n╔══════════════════════════════════════════╗");

    console.log("║        ✅ CYCLE COMPLETED               ║");

    console.log("╚══════════════════════════════════════════╝");

    if (result.id) {
      console.log(`🆔 ID: ${result.id}`);
    }

    if (result.link) {
      console.log(`🔗 ${result.link}`);
    }

    if (result.dryRun) {
      console.log("🧪 DRY RUN — not published.");
    }

    console.log(`🖼️ Image generated: ${Boolean(post.imageGenerated)}`);

    return {
      success: true,

      id: result.id || null,

      link: result.link || null,

      dryRun: Boolean(result.dryRun),

      imageGenerated: Boolean(post.imageGenerated),
    };
  } catch (error) {
    state.totalFailures++;

    await saveState();

    console.error("\n❌ Cycle error:");

    console.error(error?.stack || error?.message || error);

    return {
      success: false,

      error: error?.message || "Unknown error",
    };
  }
}

/* =======================================================
   SAFE CYCLE WRAPPER
======================================================= */

let cycleRunning = false;

async function safeRunCycle() {
  if (cycleRunning) {
    console.log("⚠️ Previous cycle is still running.");

    return {
      success: false,

      error: "A post cycle is already running.",
    };
  }

  cycleRunning = true;

  try {
    return await runCycle();
  } catch (error) {
    console.error(
      "❌ Unexpected cycle error:",
      error?.stack || error?.message || error,
    );

    return {
      success: false,

      error: error?.message || "Unexpected cycle error",
    };
  } finally {
    cycleRunning = false;
  }
}

/* =======================================================
   AUTHORIZATION
======================================================= */

function isAuthorized(req) {
  const authorization = req.headers.authorization;

  if (typeof authorization !== "string") {
    return false;
  }

  const expected = `Bearer ${POST_TRIGGER_SECRET}`;

  return authorization === expected;
}

/* =======================================================
   REQUEST BODY
======================================================= */

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    let finished = false;

    const finishReject = (error) => {
      if (finished) return;

      finished = true;

      reject(error);
    };

    const finishResolve = () => {
      if (finished) return;

      finished = true;

      resolve(body);
    };

    req.on("data", (chunk) => {
      body += chunk.toString();

      if (body.length > 10000) {
        finishReject(new Error("Request body too large."));

        req.destroy();
      }
    });

    req.on("end", finishResolve);

    req.on("error", finishReject);
  });
}

/* =======================================================
   JSON RESPONSE
======================================================= */

function sendJSON(res, statusCode, data) {
  if (res.headersSent) return;

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",

    "Cache-Control": "no-store",

    "X-Content-Type-Options": "nosniff",
  });

  res.end(JSON.stringify(data, null, 2));
}

/* =======================================================
   HTTP SERVER
======================================================= */

let httpServer = null;

async function startServer() {
  httpServer = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        resetDailyCounter();

        return sendJSON(res, 200, {
          status: "alive",

          service: "binance-square-ai-bot",

          version: "8.0.0",

          timezone: BOT_TIMEZONE,

          localDate: getLocalDate(),

          postsToday: state.postsToday,

          maxPostsPerDay: MAX_POSTS_PER_DAY,

          totalPosts: state.totalPosts,

          totalFailures: state.totalFailures,

          totalSkipped: state.totalSkipped,

          uptime: process.uptime(),

          lastPostAt: state.lastPostAt,

          lastTriggerAt: state.lastTriggerAt,

          lastTriggerResult: state.lastTriggerResult,

          cycleRunning,

          dryRun: DRY_RUN,

          mongoConnected: Boolean(mongoClient),

          imageGeneration: "Cloudflare Workers AI",

          imageModel: CLOUDFLARE_IMAGE_MODEL,
        });
      }

      if (req.method === "POST" && req.url === "/post") {
        console.log("\n📥 POST trigger received.");

        if (!isAuthorized(req)) {
          console.log("❌ Unauthorized POST trigger.");

          return sendJSON(res, 401, {
            success: false,

            error: "Unauthorized.",
          });
        }

        if (cycleRunning) {
          console.log("⚠️ Post cycle already running.");

          return sendJSON(res, 409, {
            success: false,

            error: "A post cycle is already running.",
          });
        }

        try {
          await readRequestBody(req);
        } catch (error) {
          console.warn("⚠️ Request body warning:", error.message);

          return sendJSON(res, 400, {
            success: false,

            error: error.message,
          });
        }

        state.lastTriggerAt = new Date().toISOString();

        await saveState();

        console.log("🚀 Starting requested post cycle...");

        const result = await safeRunCycle();

        state.lastTriggerResult = result;

        await saveState();

        if (result.success) {
          return sendJSON(res, 200, {
            success: true,

            message: "Post cycle completed.",

            result,

            postsToday: state.postsToday,

            totalPosts: state.totalPosts,

            lastPostAt: state.lastPostAt,
          });
        }

        if (result.skipped) {
          return sendJSON(res, 200, {
            success: false,

            skipped: true,

            reason: result.reason,

            validation: result.validation || undefined,

            postsToday: state.postsToday,

            totalPosts: state.totalPosts,

            totalSkipped: state.totalSkipped,
          });
        }

        return sendJSON(res, 500, {
          success: false,

          message: "Post cycle failed.",

          error: result.error || "Unknown error",

          postsToday: state.postsToday,

          totalPosts: state.totalPosts,

          totalFailures: state.totalFailures,
        });
      }

      return sendJSON(res, 404, {
        success: false,

        error: "Route not found.",

        availableRoutes: ["GET /", "GET /health", "POST /post"],
      });
    } catch (error) {
      console.error("❌ HTTP request error:", error?.stack || error);

      if (!res.headersSent) {
        return sendJSON(res, 500, {
          success: false,

          error: "Internal server error.",
        });
      }

      res.end();
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);

    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`🟢 HTTP server running on port ${PORT}`);

      console.log(`🌍 Timezone: ${BOT_TIMEZONE}`);

      console.log("🚀 Production server ready.");

      resolve();
    });
  });
}

/* =======================================================
   SHUTDOWN
======================================================= */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`\n\n🛑 ${signal} received.`);

  console.log("💾 Saving state...");

  try {
    await saveState();
  } catch (error) {
    console.error("⚠️ Final state save failed:", error.message);
  }

  await disconnectMongo();

  if (httpServer) {
    httpServer.close(() => {
      console.log("👋 HTTP server closed.");

      process.exit(0);
    });

    setTimeout(() => {
      console.log("⚠️ Forced shutdown.");

      process.exit(0);
    }, 10000).unref();
  } else {
    console.log("👋 Bot stopped safely.");

    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

/* =======================================================
   STARTUP
======================================================= */

async function startBotAndServer() {
  await connectMongo();

  await loadState();

  console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║       🤖 BINANCE SQUARE AI BOT V8.0.0           ║
║                                                  ║
║       ⚡ HTTP TRIGGER ARCHITECTURE               ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);

  console.log(`🧠 Provider: Groq`);

  console.log(`🧠 Model: ${GROQ_MODEL}`);

  console.log(`🌐 Web research: Google News RSS`);

  console.log(`💾 Trending topic storage: MongoDB (${MONGODB_DB_NAME})`);

  console.log(`📊 Binance market API: DISABLED`);

  console.log(`📈 Technical analysis: DISABLED`);

  console.log(`📰 Live news research: ENABLED`);

  console.log(`🛡️ Safety validation: ENABLED`);

  console.log(`🔎 Duplicate protection: DISABLED`);

  console.log(`📡 Binance Square: ENABLED`);

  console.log(`🎨 Image generation: ENABLED`);

  console.log(`🎨 Image provider: Cloudflare Workers AI`);

  console.log(`🎨 Image model: ${CLOUDFLARE_IMAGE_MODEL}`);

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`);

  console.log(`❓ Topic pool: ${TOPICS.length}`);

  console.log(`🔐 POST authentication: ENABLED`);

  console.log(`⏱️ Internal interval: DISABLED`);

  console.log(`📡 External scheduling: ENABLED`);

  console.log(`🌍 Bot timezone: ${BOT_TIMEZONE}`);

  await startServer();

  console.log("\n🟢 Bot is waiting for external triggers.");

  console.log("📡 POST /post → creates exactly ONE post.");

  console.log("🎨 Every post attempts to generate a related image.");

  console.log("💤 No internal timer is running.");

  console.log("⏰ External scheduler controls posting times.");
}

/* =======================================================
   APPLICATION START
======================================================= */

startBotAndServer().catch(async (error) => {
  console.error("💥 Fatal startup error:", error?.stack || error);

  try {
    await saveState();
  } catch {}

  await disconnectMongo();

  process.exit(1);
});

/* =======================================================
   UTILITIES
======================================================= */

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
