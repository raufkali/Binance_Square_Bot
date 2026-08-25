import Groq from "groq-sdk";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import http from "http";
import crypto from "crypto";
import { MongoClient } from "mongodb";

dotenv.config();

/*
=========================================================
UNIFIED CRYPTO AI BOT
=========================================================

BINANCE
-------
POST /post

LINKEDIN
--------
GET  /auth/linkedin
GET  /auth/linkedin/callback
POST /linkedin/post

HEALTH
------
GET /health

=========================================================
IMPORTANT
=========================================================

This file contains BOTH bots.

There is only ONE HTTP server.

Do NOT create BinanceBot.js.
Do NOT create LinkedInBot.js.
Do NOT use LINKEDIN_PORT.

Render supplies PORT automatically.

=========================================================
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================================================
   ENVIRONMENT
======================================================= */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const BINANCE_SQUARE_OPENAPI_KEY = process.env.BINANCE_SQUARE_OPENAPI_KEY;

const POST_TRIGGER_SECRET = process.env.POST_TRIGGER_SECRET;

const LINKEDIN_POST_TRIGGER_SECRET = process.env.LINKEDIN_POST_TRIGGER_SECRET;

const MONGODB_URI = process.env.MONGODB_URI;

const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "crypto-content-bot";

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const CLOUDFLARE_IMAGE_MODEL =
  process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

/* =======================================================
   LINKEDIN CONFIGURATION
======================================================= */

const LINKEDIN_CLIENT_ID = process.env.LINKEDIN_CLIENT_ID;

const LINKEDIN_CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET;

const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI;

const LINKEDIN_VERSION = process.env.LINKEDIN_VERSION || "202603";

const LINKEDIN_MAX_POSTS_PER_DAY = parsePositiveInteger(
  process.env.LINKEDIN_MAX_POSTS_PER_DAY,
  3,
);

const LINKEDIN_DRY_RUN =
  String(process.env.LINKEDIN_DRY_RUN || "false").toLowerCase() === "true";

/* =======================================================
   GENERAL CONFIG
======================================================= */

const MAX_POSTS_PER_DAY = parsePositiveInteger(
  process.env.MAX_POSTS_PER_DAY,
  36,
);

const MAX_HISTORY = parsePositiveInteger(process.env.MAX_HISTORY, 200);

const LINKEDIN_MAX_HISTORY = parsePositiveInteger(
  process.env.LINKEDIN_MAX_HISTORY,
  150,
);

const REQUEST_TIMEOUT_MS = parsePositiveInteger(
  process.env.REQUEST_TIMEOUT_MS,
  30000,
);

const PORT = parsePositiveInteger(process.env.PORT, 3000);

const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Asia/Karachi";

const GENERATION_MAX_TOKENS = parsePositiveInteger(
  process.env.GENERATION_MAX_TOKENS,
  1800,
);

const TRENDING_TOPIC_MAX_AGE_HOURS = parsePositiveInteger(
  process.env.TRENDING_TOPIC_MAX_AGE_HOURS,
  36,
);

/* =======================================================
   FILES
======================================================= */

const STATE_FILE = path.join(__dirname, "bot-state.json");

const STATE_BACKUP_FILE = path.join(__dirname, "bot-state.backup.json");

const LINKEDIN_STATE_FILE = path.join(__dirname, "linkedin-state.json");

const LINKEDIN_STATE_BACKUP_FILE = path.join(
  __dirname,
  "linkedin-state.backup.json",
);

const GENERATED_IMAGE_DIR = path.join(__dirname, "generated-images");

/* =======================================================
   BINANCE SQUARE SCRIPTS
======================================================= */

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

/* =======================================================
   VALIDATION
======================================================= */

function requireEnv(name, value) {
  if (!value) {
    console.error(`❌ ${name} is missing.`);
    process.exit(1);
  }
}

requireEnv("GROQ_API_KEY", GROQ_API_KEY);
requireEnv("BINANCE_SQUARE_OPENAPI_KEY", BINANCE_SQUARE_OPENAPI_KEY);
requireEnv("POST_TRIGGER_SECRET", POST_TRIGGER_SECRET);
requireEnv("LINKEDIN_POST_TRIGGER_SECRET", LINKEDIN_POST_TRIGGER_SECRET);
requireEnv("MONGODB_URI", MONGODB_URI);
requireEnv("CLOUDFLARE_ACCOUNT_ID", CLOUDFLARE_ACCOUNT_ID);
requireEnv("CLOUDFLARE_API_TOKEN", CLOUDFLARE_API_TOKEN);
requireEnv("LINKEDIN_CLIENT_ID", LINKEDIN_CLIENT_ID);
requireEnv("LINKEDIN_CLIENT_SECRET", LINKEDIN_CLIENT_SECRET);
requireEnv("LINKEDIN_REDIRECT_URI", LINKEDIN_REDIRECT_URI);

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
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(new Date());
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
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

/* =======================================================
   MONGODB
======================================================= */

let mongoClient = null;
let db = null;

let trendingTopicsCollection = null;
let postHistoryCollection = null;
let linkedinHistoryCollection = null;
let linkedinAuthCollection = null;

async function connectMongo() {
  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 10,
  });

  await mongoClient.connect();

  db = mongoClient.db(MONGODB_DB_NAME);

  trendingTopicsCollection = db.collection("trending_topics");

  postHistoryCollection = db.collection("post_history");

  linkedinHistoryCollection = db.collection("linkedin_post_history");

  linkedinAuthCollection = db.collection("linkedin_auth");

  await trendingTopicsCollection.createIndex(
    {
      fingerprint: 1,
    },
    {
      unique: true,
    },
  );

  await trendingTopicsCollection.createIndex({
    used: 1,
    fetchedAt: -1,
  });

  await postHistoryCollection.createIndex({
    publishedAt: -1,
  });

  await linkedinHistoryCollection.createIndex({
    publishedAt: -1,
  });

  console.log("💾 MongoDB connected.");
}

async function disconnectMongo() {
  try {
    if (mongoClient) {
      await mongoClient.close();
    }

    console.log("💾 MongoDB connection closed.");
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

  const operations = newsItems.map((item) => ({
    updateOne: {
      filter: {
        fingerprint: fingerprintTopic(item.title),
      },

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
    await trendingTopicsCollection.bulkWrite(operations, {
      ordered: false,
    });
  } catch (error) {
    console.warn("⚠️ Trending storage failed:", error.message);
  }
}

async function pullTrendingTopic() {
  const cutoff = new Date(
    Date.now() - TRENDING_TOPIC_MAX_AGE_HOURS * 60 * 60 * 1000,
  );

  try {
    const result = await trendingTopicsCollection.findOneAndUpdate(
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

    return result || null;
  } catch (error) {
    console.warn("⚠️ Pulling topic failed:", error.message);

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
  } catch {}
}

/* =======================================================
   TOPICS
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

function getRandomTopic() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
}

/* =======================================================
   BINANCE STATE
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
      const temp = `${STATE_FILE}.tmp`;

      await fs.writeFile(temp, JSON.stringify(state, null, 2), "utf8");

      try {
        await fs.copyFile(STATE_FILE, STATE_BACKUP_FILE);
      } catch {}

      await fs.rename(temp, STATE_FILE);
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

/* =======================================================
   LINKEDIN STATE
======================================================= */

function createLinkedInState() {
  return {
    date: getLocalDate(),
    postsToday: 0,
    totalPosts: 0,
    totalFailures: 0,
    lastPostAt: null,
    lastTriggerAt: null,
    lastTriggerResult: null,
    history: [],
  };
}

let linkedinState = createLinkedInState();

async function loadLinkedInState() {
  let loaded = false;

  try {
    const raw = await fs.readFile(LINKEDIN_STATE_FILE, "utf8");

    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object") {
      linkedinState = {
        ...createLinkedInState(),
        ...parsed,
      };

      loaded = true;
    }
  } catch {}

  if (!loaded) {
    try {
      const raw = await fs.readFile(LINKEDIN_STATE_BACKUP_FILE, "utf8");

      const parsed = JSON.parse(raw);

      if (parsed && typeof parsed === "object") {
        linkedinState = {
          ...createLinkedInState(),
          ...parsed,
        };

        loaded = true;
      }
    } catch {}
  }

  normalizeLinkedInState();
  resetLinkedInDailyCounter();

  if (!loaded) {
    await saveLinkedInState();
  }
}

function normalizeLinkedInState() {
  if (typeof linkedinState.date !== "string") {
    linkedinState.date = getLocalDate();
  }

  if (!Number.isFinite(linkedinState.postsToday)) {
    linkedinState.postsToday = 0;
  }

  if (!Number.isFinite(linkedinState.totalPosts)) {
    linkedinState.totalPosts = 0;
  }

  if (!Number.isFinite(linkedinState.totalFailures)) {
    linkedinState.totalFailures = 0;
  }

  if (!Array.isArray(linkedinState.history)) {
    linkedinState.history = [];
  }

  if (linkedinState.history.length > LINKEDIN_MAX_HISTORY) {
    linkedinState.history = linkedinState.history.slice(-LINKEDIN_MAX_HISTORY);
  }
}

let linkedinSaveRunning = Promise.resolve();

async function saveLinkedInState() {
  linkedinSaveRunning = linkedinSaveRunning
    .catch(() => {})
    .then(async () => {
      const temp = `${LINKEDIN_STATE_FILE}.tmp`;

      await fs.writeFile(temp, JSON.stringify(linkedinState, null, 2), "utf8");

      try {
        await fs.copyFile(LINKEDIN_STATE_FILE, LINKEDIN_STATE_BACKUP_FILE);
      } catch {}

      await fs.rename(temp, LINKEDIN_STATE_FILE);
    });

  return linkedinSaveRunning;
}

function resetLinkedInDailyCounter() {
  const today = getLocalDate();

  if (linkedinState.date !== today) {
    linkedinState.date = today;

    linkedinState.postsToday = 0;

    saveLinkedInState().catch(() => {});
  }
}

/* =======================================================
   XML
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
   GOOGLE NEWS
======================================================= */

const GOOGLE_NEWS_URL =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(
    "crypto OR bitcoin OR ethereum OR binance OR solana OR XRP",
  ) +
  "&hl=en-US&gl=US&ceid=US:en";

async function researchWeb() {
  console.log("\n🌐 Google News research...");

  let news = [];

  try {
    const response = await fetchWithTimeout(GOOGLE_NEWS_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 CryptoAI/10.0",
        Accept: "application/rss+xml",
      },
    });

    if (!response.ok) {
      throw new Error(`Google News HTTP ${response.status}`);
    }

    const xml = await response.text();

    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

    for (const match of items.slice(0, 20)) {
      const item = match[1];

      const title = getXmlTag(item, "title");

      if (!title) continue;

      news.push({
        title: title.slice(0, 300),

        description: getXmlTag(item, "description").slice(0, 700),

        publishedAt: getXmlTag(item, "pubDate"),

        source: getXmlTag(item, "source"),
      });
    }

    shuffleArray(news);

    await storeTrendingTopics(news);

    console.log(`   ✅ ${news.length} news items.`);
  } catch (error) {
    console.warn("⚠️ News research failed:", error.message);
  }

  const marketData = await getMarketData();

  return {
    news,
    marketData,
  };
}

/* =======================================================
   MARKET DATA
======================================================= */

const SMA_SHORT = 9;
const SMA_LONG = 21;
const RSI_PERIOD = 14;

function movingAverage(data, period) {
  const result = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);

    result.push(sum / period);
  }

  return result;
}

function computeRSI(data, period = 14) {
  if (data.length < period + 1) {
    return data.map(() => 50);
  }

  const gains = [];
  const losses = [];

  for (let i = 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];

    gains.push(diff > 0 ? diff : 0);

    losses.push(diff < 0 ? -diff : 0);
  }

  const avgGain = movingAverage(gains, period);

  const avgLoss = movingAverage(losses, period);

  const rsi = [];

  for (let i = 0; i < avgGain.length; i++) {
    if (avgGain[i] === null || avgLoss[i] === null) {
      rsi.push(50);
      continue;
    }

    const rs = avgGain[i] / (avgLoss[i] || 0.001);

    rsi.push(100 - 100 / (1 + rs));
  }

  while (rsi.length < data.length) {
    rsi.unshift(50);
  }

  return rsi;
}

function generateSignal({ priceChange, smaShort, smaLong, rsi }) {
  let direction = "NEUTRAL";

  let confidence = "LOW";

  let reason = "No clear trend.";

  if (smaShort > smaLong && rsi < 70 && priceChange > 0) {
    direction = "BULLISH";

    confidence = "HIGH";

    reason = "Short-term trend is above the long-term trend.";
  } else if (smaShort < smaLong && rsi > 30 && priceChange < 0) {
    direction = "BEARISH";

    confidence = "HIGH";

    reason = "Short-term trend is below the long-term trend.";
  } else if (smaShort > smaLong) {
    direction = "BULLISH";

    confidence = "MEDIUM";

    reason = "Short-term SMA is above long-term SMA.";
  } else if (smaShort < smaLong) {
    direction = "BEARISH";

    confidence = "MEDIUM";

    reason = "Short-term SMA is below long-term SMA.";
  }

  if (rsi > 80) {
    direction = "BEARISH";

    confidence = "HIGH";

    reason = "RSI is overbought.";
  }

  if (rsi < 20) {
    direction = "BULLISH";

    confidence = "HIGH";

    reason = "RSI is oversold.";
  }

  return {
    direction,
    confidence,
    reason,
  };
}

async function getMarketData() {
  try {
    const response = await fetchWithTimeout(
      "https://api.binance.com/api/v3/ticker/24hr",
      {},
      10000,
    );

    if (!response.ok) {
      throw new Error(`Ticker HTTP ${response.status}`);
    }

    const tickers = await response.json();

    const stablecoins = new Set([
      "USDCUSDT",
      "TUSDUSDT",
      "DAIUSDT",
      "FDUSDUSDT",
      "BUSDUSDT",
    ]);

    const candidates = tickers.filter((t) => {
      if (!t.symbol.endsWith("USDT")) {
        return false;
      }

      if (stablecoins.has(t.symbol)) {
        return false;
      }

      return parseFloat(t.quoteVolume) > 1000000;
    });

    if (candidates.length === 0) {
      throw new Error("No suitable market pairs.");
    }

    candidates.sort((a, b) => {
      const scoreA =
        parseFloat(a.quoteVolume) * parseFloat(a.priceChangePercent);

      const scoreB =
        parseFloat(b.quoteVolume) * parseFloat(b.priceChangePercent);

      return scoreB - scoreA;
    });

    const hot = candidates[0];

    const symbol = hot.symbol;

    const baseAsset = symbol.replace("USDT", "");

    const klineResponse = await fetchWithTimeout(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=100`,
      {},
      10000,
    );

    if (!klineResponse.ok) {
      throw new Error(`Klines HTTP ${klineResponse.status}`);
    }

    const klines = await klineResponse.json();

    const closes = klines.map((candle) => parseFloat(candle[4]));

    const smaShort = movingAverage(closes, SMA_SHORT);

    const smaLong = movingAverage(closes, SMA_LONG);

    const rsi = computeRSI(closes, RSI_PERIOD);

    const lastPrice = parseFloat(hot.lastPrice);

    const priceChange = parseFloat(hot.priceChangePercent);

    const signal = generateSignal({
      priceChange,
      smaShort: smaShort[smaShort.length - 1],
      smaLong: smaLong[smaLong.length - 1],
      rsi: rsi[rsi.length - 1],
    });

    return {
      symbol,
      baseAsset,
      lastPrice,
      priceChangePercent: priceChange,
      volume: parseFloat(hot.volume),
      high: parseFloat(hot.highPrice),
      low: parseFloat(hot.lowPrice),
      signal,
      smaShort: smaShort[smaShort.length - 1],
      smaLong: smaLong[smaLong.length - 1],
      rsi: rsi[rsi.length - 1],
    };
  } catch (error) {
    console.warn("⚠️ Market data failed:", error.message);

    return await getBTCFallback();
  }
}

async function getBTCFallback() {
  try {
    const tickerResponse = await fetchWithTimeout(
      "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
      {},
      10000,
    );

    const ticker = await tickerResponse.json();

    const klinesResponse = await fetchWithTimeout(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100",
      {},
      10000,
    );

    const klines = await klinesResponse.json();

    const closes = klines.map((candle) => parseFloat(candle[4]));

    const smaShort = movingAverage(closes, SMA_SHORT);

    const smaLong = movingAverage(closes, SMA_LONG);

    const rsi = computeRSI(closes, RSI_PERIOD);

    const lastPrice = parseFloat(ticker.lastPrice);

    const priceChange = parseFloat(ticker.priceChangePercent);

    const signal = generateSignal({
      priceChange,
      smaShort: smaShort[smaShort.length - 1],
      smaLong: smaLong[smaLong.length - 1],
      rsi: rsi[rsi.length - 1],
    });

    return {
      symbol: "BTCUSDT",
      baseAsset: "Bitcoin",
      lastPrice,
      priceChangePercent: priceChange,
      volume: parseFloat(ticker.volume),
      high: parseFloat(ticker.highPrice),
      low: parseFloat(ticker.lowPrice),
      signal,
      smaShort: smaShort[smaShort.length - 1],
      smaLong: smaLong[smaLong.length - 1],
      rsi: rsi[rsi.length - 1],
    };
  } catch {
    return null;
  }
}

/* =======================================================
   RECENT MEMORY
======================================================= */

function getRecentPostMemory() {
  return state.history
    .slice(-12)
    .map((post) => {
      return `${post.topic}: ${String(post.text || "")
        .replace(/\s+/g, " ")
        .slice(0, 200)}`;
    })
    .join("\n");
}

function getRecentLinkedInMemory() {
  return linkedinState.history
    .slice(-10)
    .map((post) => {
      return String(post.text || "")
        .replace(/\s+/g, " ")
        .slice(0, 300);
    })
    .join("\n");
}

/* =======================================================
   GROQ
======================================================= */

async function groqGenerate(system, prompt, maxTokens = 1200) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,

        messages: [
          {
            role: "system",
            content: system,
          },
          {
            role: "user",
            content: prompt,
          },
        ],

        temperature: 0.8,

        max_completion_tokens: maxTokens,
      });

      const content = response?.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error("Groq returned empty content.");
      }

      return content.trim();
    } catch (error) {
      console.warn(`⚠️ Groq attempt ${attempt} failed: ${error.message}`);

      if (attempt === 3) {
        throw error;
      }

      await sleep(attempt * 1500);
    }
  }
}

/* =======================================================
   BINANCE CONTENT
======================================================= */

async function generateBinancePost(news, market) {
  const topic = news?.[0] || {
    title: getRandomTopic(),
    description: "",
  };

  const marketText = market
    ? `
Coin: ${market.symbol}
Price: $${market.lastPrice}
24h Change: ${market.priceChangePercent}%
Signal: ${market.signal.direction}
Confidence: ${market.signal.confidence}
Reason: ${market.signal.reason}
`
    : "Market data unavailable.";

  const recent = getRecentPostMemory();

  const prompt = `
Create a short Binance Square crypto post.

CURRENT MARKET:
${marketText}

NEWS:
${topic.title}
${topic.description || ""}

RECENT POSTS:
${recent || "None"}

RULES:
- Mention the exact $TICKER immediately.
- Mention current price.
- Do not fabricate facts.
- Do not claim guaranteed profit.
- State an observation or trading setup.
- Give one concrete level to watch.
- Keep it punchy.
- Maximum 3 short paragraphs.
- Use 2 hashtags.
- End with "Not financial advice."
`;

  const content = await groqGenerate(
    `
You are a responsible crypto market commentator.
You write concise, data-grounded Binance Square content.
Never guarantee profits.
Never fabricate market events.
`,
    prompt,
    900,
  );

  const ticker = market?.symbol?.replace("USDT", "") || "BTC";

  let finalContent = content
    .replace(/#[a-zA-Z0-9_]+/g, "")
    .replace(/Not financial advice\.?/gi, "")
    .trim();

  if (!finalContent.includes(`$${ticker}`)) {
    finalContent = `$${ticker} ${finalContent}`;
  }

  finalContent += `\n\n#${ticker} #Crypto\n\nNot financial advice.`;

  return {
    title: `${ticker} Market Setup`,
    topic: "crypto",
    content: finalContent,
    qualityScore: 8,
    newsUsed: Boolean(news?.length),
    signal: market?.signal?.direction || "NEUTRAL",
    signalConfidence: market?.signal?.confidence || "LOW",
  };
}

/* =======================================================
   CLOUDFLARE IMAGE
======================================================= */

function buildImagePrompt(post, market) {
  const ticker = market?.symbol || "BTCUSDT";

  const price = market?.lastPrice || 0;

  const direction = market?.signal?.direction || "NEUTRAL";

  return `
Create a realistic cryptocurrency trading-terminal style image.

Asset: ${ticker}
Current price: $${price}
Market direction: ${direction}

Create a dark professional chart interface with:
- realistic candlesticks
- volume bars
- support/resistance
- natural market movement
- professional trading-terminal appearance

No people.
No fake profits.
No PNL.
No logos.
No misleading text.
16:9 landscape.
`;
}

async function generateImageWithCloudflare(post, market) {
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
        prompt: buildImagePrompt(post, market),
      }),
    },
    120000,
  );

  if (!response.ok) {
    throw new Error(
      `Cloudflare HTTP ${response.status}: ${await response.text()}`,
    );
  }

  const type = response.headers.get("content-type") || "";

  let buffer;

  if (type.includes("application/json")) {
    const json = await response.json();

    let image =
      json?.result?.image ||
      json?.result?.output ||
      json?.image ||
      json?.output;

    if (Array.isArray(image)) {
      image = image[0];
    }

    if (typeof image !== "string") {
      throw new Error("Cloudflare returned no image.");
    }

    image = image.replace(/^data:image\/[^;]+;base64,/i, "");

    buffer = Buffer.from(image, "base64");
  } else {
    buffer = Buffer.from(await response.arrayBuffer());
  }

  if (!buffer || buffer.length < 1000) {
    throw new Error("Invalid generated image.");
  }

  await fs.mkdir(GENERATED_IMAGE_DIR, {
    recursive: true,
  });

  const filename = `binance-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.png`;

  const imagePath = path.join(GENERATED_IMAGE_DIR, filename);

  await fs.writeFile(imagePath, buffer);

  return imagePath;
}

async function cleanupImage(imagePath) {
  if (!imagePath) return;

  try {
    await fs.unlink(imagePath);
  } catch {}
}

/* =======================================================
   BINANCE PUBLISH
======================================================= */

function publishTextToSquare(content) {
  return new Promise((resolve, reject) => {
    if (DRY_RUN) {
      console.log("\n🧪 BINANCE DRY RUN\n", content);

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
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
          stdout += data.toString();

          process.stdout.write(data.toString());
        });

        child.stderr.on("data", (data) => {
          stderr += data.toString();

          process.stderr.write(data.toString());
        });

        child.on("error", reject);

        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(stderr || `Publisher exited ${code}`));

            return;
          }

          resolve({
            success: true,

            dryRun: false,

            id: stdout.match(/ID:\s*(.+)/i)?.[1]?.trim() || null,

            link: stdout.match(/Link:\s*(.+)/i)?.[1]?.trim() || null,
          });
        });
      })
      .catch(reject);
  });
}

function publishImageToSquare(content, imagePath) {
  return new Promise((resolve, reject) => {
    if (DRY_RUN) {
      console.log("\n🧪 BINANCE IMAGE DRY RUN");

      console.log(content);
      console.log(imagePath);

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
          },
        );

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (data) => {
          stdout += data.toString();

          process.stdout.write(data.toString());
        });

        child.stderr.on("data", (data) => {
          stderr += data.toString();

          process.stderr.write(data.toString());
        });

        child.on("error", reject);

        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(stderr || `Image publisher exited ${code}`));

            return;
          }

          resolve({
            success: true,

            dryRun: false,

            id: stdout.match(/ID:\s*(.+)/i)?.[1]?.trim() || null,

            link: stdout.match(/Link:\s*(.+)/i)?.[1]?.trim() || null,
          });
        });
      })
      .catch(reject);
  });
}

/* =======================================================
   BINANCE CYCLE
======================================================= */

let binanceRunning = false;

async function runBinanceCycle() {
  resetDailyCounter();

  if (state.postsToday >= MAX_POSTS_PER_DAY) {
    state.totalSkipped++;

    await saveState();

    return {
      success: false,
      skipped: true,
      reason: "daily_limit",
    };
  }

  try {
    console.log("\n🚀 BINANCE CYCLE");

    const { news, marketData } = await researchWeb();

    const selectedTopic = await pullTrendingTopic();

    const usableNews = selectedTopic
      ? [
          {
            title: selectedTopic.title,

            description: selectedTopic.description,
          },
        ]
      : news;

    const post = await generateBinancePost(usableNews, marketData);

    if (!post.content || post.content.length < 80) {
      throw new Error("Generated Binance content is too short.");
    }

    let result;

    let imagePath = null;

    try {
      imagePath = await generateImageWithCloudflare(post, marketData);

      result = await publishImageToSquare(post.content, imagePath);
    } catch (imageError) {
      console.warn("⚠️ Binance image failed:", imageError.message);

      result = await publishTextToSquare(post.content);
    } finally {
      await cleanupImage(imagePath);
    }

    state.history.push({
      id: result.id || null,

      title: post.title,

      topic: post.topic,

      text: post.content,

      signal: post.signal,

      signalConfidence: post.signalConfidence,

      publishedAt: new Date().toISOString(),

      dryRun: Boolean(result.dryRun),
    });

    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(-MAX_HISTORY);
    }

    if (!result.dryRun) {
      state.postsToday++;
      state.totalPosts++;
      state.lastPostAt = new Date().toISOString();
    }

    await saveState();

    try {
      await postHistoryCollection.insertOne({
        platform: "binance",

        title: post.title,

        text: post.content,

        signal: post.signal,

        publishedAt: new Date(),
      });
    } catch {}

    console.log("✅ Binance cycle completed.");

    return {
      success: true,
      id: result.id || null,
      link: result.link || null,
      dryRun: Boolean(result.dryRun),
      imageGenerated: Boolean(imagePath),
    };
  } catch (error) {
    state.totalFailures++;

    await saveState();

    console.error("❌ Binance cycle failed:", error.message);

    return {
      success: false,
      error: error.message,
    };
  }
}

/* =======================================================
   LINKEDIN OAUTH
======================================================= */

const LINKEDIN_AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";

const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

const LINKEDIN_POST_URL = "https://api.linkedin.com/rest/posts";

const LINKEDIN_SCOPES = ["openid", "profile", "email", "w_member_social"].join(
  " ",
);

async function createLinkedInStateToken() {
  const stateToken = crypto.randomBytes(32).toString("hex");

  await linkedinAuthCollection.updateOne(
    {
      type: "oauth_state",
    },

    {
      $set: {
        value: stateToken,

        createdAt: new Date(),
      },
    },

    {
      upsert: true,
    },
  );

  return stateToken;
}

async function verifyLinkedInState(value) {
  if (!value) {
    return false;
  }

  const record = await linkedinAuthCollection.findOne({
    type: "oauth_state",

    value,
  });

  if (!record) {
    return false;
  }

  await linkedinAuthCollection.deleteOne({
    _id: record._id,
  });

  const age = Date.now() - new Date(record.createdAt).getTime();

  return age < 10 * 60 * 1000;
}

function getLinkedInAuthUrl(stateToken) {
  const url = new URL(LINKEDIN_AUTH_URL);

  url.searchParams.set("response_type", "code");

  url.searchParams.set("client_id", LINKEDIN_CLIENT_ID);

  url.searchParams.set("redirect_uri", LINKEDIN_REDIRECT_URI);

  url.searchParams.set("state", stateToken);

  url.searchParams.set("scope", LINKEDIN_SCOPES);

  return url.toString();
}

async function exchangeLinkedInCode(code) {
  const body = new URLSearchParams();

  body.set("grant_type", "authorization_code");

  body.set("code", code);

  body.set("client_id", LINKEDIN_CLIENT_ID);

  body.set("client_secret", LINKEDIN_CLIENT_SECRET);

  body.set("redirect_uri", LINKEDIN_REDIRECT_URI);

  const response = await fetchWithTimeout(
    LINKEDIN_TOKEN_URL,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },

      body: body.toString(),
    },
    30000,
  );

  const text = await response.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`LinkedIn token response: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`LinkedIn OAuth failed: ${text}`);
  }

  return json;
}

async function getLinkedInUser(accessToken) {
  const response = await fetchWithTimeout(
    LINKEDIN_USERINFO_URL,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    30000,
  );

  const text = await response.text();

  let json;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`LinkedIn userinfo invalid response: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`LinkedIn userinfo failed: ${text}`);
  }

  return json;
}

async function saveLinkedInToken(token, user) {
  const expiresAt = token.expires_in
    ? new Date(Date.now() + Number(token.expires_in) * 1000)
    : null;

  await linkedinAuthCollection.updateOne(
    {
      type: "member_token",
    },

    {
      $set: {
        accessToken: token.access_token,

        refreshToken: token.refresh_token || null,

        expiresAt,

        userId: user.sub,

        name: user.name || null,

        email: user.email || null,

        updatedAt: new Date(),
      },
    },

    {
      upsert: true,
    },
  );
}

async function getSavedLinkedInAuth() {
  return await linkedinAuthCollection.findOne({
    type: "member_token",
  });
}

async function getValidLinkedInToken() {
  const auth = await getSavedLinkedInAuth();

  if (!auth?.accessToken) {
    return null;
  }

  /*
  LinkedIn access tokens are normally long-lived.
  If the stored token is still available, use it.
  */

  if (
    auth.expiresAt &&
    new Date(auth.expiresAt).getTime() > Date.now() + 60000
  ) {
    return auth;
  }

  /*
  If LinkedIn supplied a refresh token,
  attempt refresh.
  */

  if (auth.refreshToken) {
    try {
      const body = new URLSearchParams();

      body.set("grant_type", "refresh_token");

      body.set("refresh_token", auth.refreshToken);

      body.set("client_id", LINKEDIN_CLIENT_ID);

      body.set("client_secret", LINKEDIN_CLIENT_SECRET);

      const response = await fetchWithTimeout(
        LINKEDIN_TOKEN_URL,
        {
          method: "POST",

          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },

          body: body.toString(),
        },
        30000,
      );

      if (response.ok) {
        const refreshed = await response.json();

        const user = {
          sub: auth.userId,

          name: auth.name,

          email: auth.email,
        };

        await saveLinkedInToken(refreshed, user);

        return await getSavedLinkedInAuth();
      }
    } catch (error) {
      console.warn("⚠️ LinkedIn refresh failed:", error.message);
    }
  }

  return null;
}

/* =======================================================
   LINKEDIN CONTENT
======================================================= */

async function generateLinkedInPost(news, market) {
  const marketText = market
    ? `
Coin: ${market.symbol}
Price: $${market.lastPrice}
24h Change: ${market.priceChangePercent}%
Signal: ${market.signal.direction}
Signal confidence: ${market.signal.confidence}
`
    : "Market data unavailable.";

  const newsText = news?.length
    ? news
        .slice(0, 3)
        .map((item) => `- ${item.title}`)
        .join("\n")
    : "No fresh news.";

  const recent = getRecentLinkedInMemory();

  const prompt = `
Create ONE LinkedIn post about cryptocurrency, AI, blockchain,
technology, or the current crypto market.

MARKET:
${marketText}

CURRENT NEWS:
${newsText}

RECENT LINKEDIN POSTS:
${recent || "None"}

Requirements:

- Professional but human.
- Written for LinkedIn, not Binance Square.
- Strong opening hook.
- Explain one useful insight.
- Avoid fake certainty.
- Avoid guaranteed profits.
- Do not pretend to have executed trades.
- Do not fabricate news.
- Use short paragraphs.
- 800-1300 characters.
- End with one genuine question.
- Use 3-5 relevant hashtags.
- No "Not financial advice" unless the post gives trading guidance.
`;

  return await groqGenerate(
    `
You are a professional technology and crypto creator on LinkedIn.

Your writing should sound like an experienced developer,
builder and market observer.

Never fabricate facts.
Never promise profits.
Never use manipulative financial claims.
`,
    prompt,
    1400,
  );
}

/* =======================================================
   LINKEDIN PUBLISH
======================================================= */

async function publishLinkedInPost(content, auth) {
  if (LINKEDIN_DRY_RUN) {
    console.log("\n🧪 LINKEDIN DRY RUN");

    console.log(content);

    return {
      success: true,
      dryRun: true,
      id: null,
    };
  }

  if (!auth?.accessToken || !auth?.userId) {
    throw new Error("LinkedIn is not connected. Open /auth/linkedin first.");
  }

  const author = `urn:li:person:${auth.userId}`;

  const payload = {
    author,

    commentary: content,

    visibility: "PUBLIC",

    distribution: {
      feedDistribution: "MAIN_FEED",

      targetEntities: [],

      thirdPartyDistributionChannels: [],
    },

    lifecycleState: "PUBLISHED",

    isReshareDisabledByAuthor: false,
  };

  const response = await fetchWithTimeout(
    LINKEDIN_POST_URL,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${auth.accessToken}`,

        "Content-Type": "application/json",

        "X-Restli-Protocol-Version": "2.0.0",

        "Linkedin-Version": LINKEDIN_VERSION,
      },

      body: JSON.stringify(payload),
    },
    30000,
  );

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(
      `LinkedIn post failed HTTP ${response.status}: ${responseText}`,
    );
  }

  return {
    success: true,

    dryRun: false,

    id: response.headers.get("x-restli-id") || null,

    response: responseText || null,
  };
}

/* =======================================================
   LINKEDIN CYCLE
======================================================= */

let linkedinRunning = false;

async function runLinkedInCycle() {
  resetLinkedInDailyCounter();

  if (linkedinState.postsToday >= LINKEDIN_MAX_POSTS_PER_DAY) {
    return {
      success: false,
      skipped: true,
      reason: "linkedin_daily_limit",
    };
  }

  try {
    console.log("\n💼 LINKEDIN CYCLE");

    const auth = await getValidLinkedInToken();

    if (!auth) {
      return {
        success: false,
        skipped: true,
        reason: "linkedin_not_authenticated",

        authorizationUrl: `${LINKEDIN_REDIRECT_URI.replace(
          "/auth/linkedin/callback",
          "",
        )}/auth/linkedin`,
      };
    }

    const { news, marketData } = await researchWeb();

    const content = await generateLinkedInPost(news, marketData);

    if (!content || content.length < 100) {
      throw new Error("LinkedIn content is too short.");
    }

    const result = await publishLinkedInPost(content, auth);

    if (!result.dryRun) {
      linkedinState.postsToday++;
      linkedinState.totalPosts++;
      linkedinState.lastPostAt = new Date().toISOString();
    }

    linkedinState.history.push({
      id: result.id || null,

      text: content,

      publishedAt: new Date().toISOString(),

      dryRun: Boolean(result.dryRun),
    });

    if (linkedinState.history.length > LINKEDIN_MAX_HISTORY) {
      linkedinState.history =
        linkedinState.history.slice(-LINKEDIN_MAX_HISTORY);
    }

    await saveLinkedInState();

    try {
      await linkedinHistoryCollection.insertOne({
        id: result.id || null,

        text: content,

        publishedAt: new Date(),
      });
    } catch {}

    console.log("✅ LinkedIn post published.");

    return {
      success: true,

      id: result.id || null,

      dryRun: Boolean(result.dryRun),

      text: content,
    };
  } catch (error) {
    linkedinState.totalFailures++;

    await saveLinkedInState();

    console.error("❌ LinkedIn cycle failed:", error.message);

    return {
      success: false,
      error: error.message,
    };
  }
}

/* =======================================================
   HTTP HELPERS
======================================================= */

function sendJSON(res, status, data) {
  if (res.headersSent) return;

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",

    "Cache-Control": "no-store",

    "X-Content-Type-Options": "nosniff",
  });

  res.end(JSON.stringify(data, null, 2));
}

function isAuthorized(req, secret) {
  const authorization = req.headers.authorization;

  return (
    typeof authorization === "string" && authorization === `Bearer ${secret}`
  );
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();

      if (body.length > 10000) {
        reject(new Error("Request body too large."));

        req.destroy();
      }
    });

    req.on("end", () => resolve(body));

    req.on("error", reject);
  });
}

/* =======================================================
   LINKEDIN OAUTH HTML
======================================================= */

function oauthSuccessHTML(user) {
  return `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>LinkedIn Connected</title>
<style>
body {
  font-family: Arial, sans-serif;
  background: #f5f7fa;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}
.card {
  background: white;
  padding: 40px;
  border-radius: 16px;
  max-width: 600px;
  text-align: center;
  box-shadow: 0 10px 40px rgba(0,0,0,.1);
}
h1 { color: #057642; }
</style>
</head>
<body>
<div class="card">
<h1>LinkedIn Connected Successfully</h1>
<p>Account: ${escapeHTML(user?.name || "LinkedIn member")}</p>
<p>You can close this window.</p>
</div>
</body>
</html>
`;
}

function escapeHTML(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/* =======================================================
   HTTP SERVER
======================================================= */

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    /* =================================================
           HEALTH
        ================================================= */

    if (
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      const linkedinAuth = await getSavedLinkedInAuth();

      return sendJSON(res, 200, {
        status: "alive",

        service: "binance-square-linkedin-bot",

        version: "10.0.0",

        timezone: BOT_TIMEZONE,

        uptime: process.uptime(),

        binance: {
          endpoint: "POST /post",

          running: binanceRunning,

          postsToday: state.postsToday,

          maxPostsPerDay: MAX_POSTS_PER_DAY,

          totalPosts: state.totalPosts,

          totalFailures: state.totalFailures,
        },

        linkedin: {
          endpoint: "POST /linkedin/post",

          auth: Boolean(linkedinAuth?.accessToken),

          running: linkedinRunning,

          postsToday: linkedinState.postsToday,

          maxPostsPerDay: LINKEDIN_MAX_POSTS_PER_DAY,

          totalPosts: linkedinState.totalPosts,

          totalFailures: linkedinState.totalFailures,
        },

        routes: [
          "GET /",
          "GET /health",
          "GET /auth/linkedin",
          "GET /auth/linkedin/callback",
          "POST /post",
          "POST /linkedin/post",
        ],
      });
    }

    /* =================================================
           LINKEDIN AUTH START
        ================================================= */

    if (req.method === "GET" && url.pathname === "/auth/linkedin") {
      const stateToken = await createLinkedInStateToken();

      const authUrl = getLinkedInAuthUrl(stateToken);

      res.writeHead(302, {
        Location: authUrl,
      });

      return res.end();
    }

    /* =================================================
           LINKEDIN AUTH CALLBACK
        ================================================= */

    if (req.method === "GET" && url.pathname === "/auth/linkedin/callback") {
      const code = url.searchParams.get("code");

      const oauthState = url.searchParams.get("state");

      const error = url.searchParams.get("error");

      if (error) {
        return sendJSON(res, 400, {
          success: false,

          error: url.searchParams.get("error_description") || error,
        });
      }

      if (!code || !oauthState) {
        return sendJSON(res, 400, {
          success: false,
          error: "Missing OAuth code or state.",
        });
      }

      const validState = await verifyLinkedInState(oauthState);

      if (!validState) {
        return sendJSON(res, 400, {
          success: false,
          error: "Invalid or expired OAuth state.",
        });
      }

      const token = await exchangeLinkedInCode(code);

      const user = await getLinkedInUser(token.access_token);

      await saveLinkedInToken(token, user);

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });

      return res.end(oauthSuccessHTML(user));
    }

    /* =================================================
           BINANCE POST
        ================================================= */

    if (req.method === "POST" && url.pathname === "/post") {
      if (!isAuthorized(req, POST_TRIGGER_SECRET)) {
        return sendJSON(res, 401, {
          success: false,
          service: "binance",
          error: "Unauthorized.",
        });
      }

      if (binanceRunning) {
        return sendJSON(res, 409, {
          success: false,
          service: "binance",
          error: "Binance cycle already running.",
        });
      }

      try {
        await readRequestBody(req);
      } catch (error) {
        return sendJSON(res, 400, {
          success: false,
          error: error.message,
        });
      }

      binanceRunning = true;

      state.lastTriggerAt = new Date().toISOString();

      await saveState();

      try {
        const result = await runBinanceCycle();

        state.lastTriggerResult = result;

        await saveState();

        return sendJSON(
          res,
          result.success ? 200 : result.skipped ? 200 : 500,
          {
            ...result,

            service: "binance",
          },
        );
      } finally {
        binanceRunning = false;
      }
    }

    /* =================================================
           LINKEDIN POST
        ================================================= */

    if (req.method === "POST" && url.pathname === "/linkedin/post") {
      if (!isAuthorized(req, LINKEDIN_POST_TRIGGER_SECRET)) {
        return sendJSON(res, 401, {
          success: false,
          service: "linkedin",
          error: "Unauthorized.",
        });
      }

      if (linkedinRunning) {
        return sendJSON(res, 409, {
          success: false,
          service: "linkedin",
          error: "LinkedIn cycle already running.",
        });
      }

      try {
        await readRequestBody(req);
      } catch (error) {
        return sendJSON(res, 400, {
          success: false,
          error: error.message,
        });
      }

      linkedinRunning = true;

      linkedinState.lastTriggerAt = new Date().toISOString();

      await saveLinkedInState();

      try {
        const result = await runLinkedInCycle();

        linkedinState.lastTriggerResult = result;

        await saveLinkedInState();

        return sendJSON(
          res,
          result.success ? 200 : result.skipped ? 200 : 500,
          {
            ...result,

            service: "linkedin",
          },
        );
      } finally {
        linkedinRunning = false;
      }
    }

    /* =================================================
           404
        ================================================= */

    return sendJSON(res, 404, {
      success: false,

      error: "Route not found.",

      routes: [
        "GET /",
        "GET /health",
        "GET /auth/linkedin",
        "GET /auth/linkedin/callback",
        "POST /post",
        "POST /linkedin/post",
      ],
    });
  } catch (error) {
    console.error("❌ HTTP error:", error?.stack || error?.message || error);

    return sendJSON(res, 500, {
      success: false,
      error: "Internal server error.",
    });
  }
});

/* =======================================================
   STARTUP
======================================================= */

async function startup() {
  await connectMongo();

  await loadState();

  await loadLinkedInState();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║        🤖 CRYPTO AI CONTENT BOT V10             ║
║                                                  ║
║        Binance Square + LinkedIn                ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);

    console.log(`🟢 HTTP server: ${PORT}`);

    console.log(`📡 Binance: POST /post`);

    console.log(`💼 LinkedIn: POST /linkedin/post`);

    console.log(`🔐 LinkedIn OAuth: /auth/linkedin`);

    console.log(`❤️ Health: /health`);

    console.log(`🧠 Groq: ${GROQ_MODEL}`);

    console.log(`🌍 Timezone: ${BOT_TIMEZONE}`);

    console.log(`📊 Binance max/day: ${MAX_POSTS_PER_DAY}`);

    console.log(`💼 LinkedIn max/day: ${LINKEDIN_MAX_POSTS_PER_DAY}`);

    console.log(`🧪 Binance dry-run: ${DRY_RUN}`);

    console.log(`🧪 LinkedIn dry-run: ${LINKEDIN_DRY_RUN}`);
  });
}

/* =======================================================
   SHUTDOWN
======================================================= */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`\n🛑 ${signal} received.`);

  try {
    await saveState();
  } catch {}

  try {
    await saveLinkedInState();
  } catch {}

  await disconnectMongo();

  server.close(() => {
    console.log("👋 Server closed.");

    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 10000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

startup().catch(async (error) => {
  console.error(
    "💥 Fatal startup error:",
    error?.stack || error?.message || error,
  );

  await disconnectMongo();

  process.exit(1);
});
