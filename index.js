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
BINANCE SQUARE AI BOT V9.2.0
=========================================================

NEW IN V9.2
-----------

- Posts are now very short (200-400 characters).
- Focus on curiosity, storytelling, and FOMO.
- No technical overload – just one simple signal.
- All V9.1 features (hot coin, PNL images) retained.

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
*/

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const CLOUDFLARE_IMAGE_MODEL =
  process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

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

/*
Market data – dynamic hot coin
*/
const SMA_SHORT = 9;
const SMA_LONG = 21;
const RSI_PERIOD = 14;

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

      signal: post.signal || null,
      signalConfidence: post.signalConfidence || null,

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
   BINANCE MARKET DATA – DYNAMIC HOT COIN
======================================================= */

async function getMarketData() {
  console.log("\n📊 Fetching hottest trending coin from Binance...");
  try {
    const tickerRes = await fetchWithTimeout(
      "https://api.binance.com/api/v3/ticker/24hr",
      {},
      10000,
    );
    if (!tickerRes.ok) throw new Error(`Ticker HTTP ${tickerRes.status}`);
    const allTickers = await tickerRes.json();

    const stablecoins = new Set([
      "USDCUSDT",
      "TUSDUSDT",
      "DAIUSDT",
      "FDUSDUSDT",
      "BUSDUSDT",
    ]);
    const candidates = allTickers.filter((t) => {
      if (!t.symbol.endsWith("USDT")) return false;
      if (stablecoins.has(t.symbol)) return false;
      const vol = parseFloat(t.quoteVolume);
      return vol > 1_000_000;
    });

    if (candidates.length === 0) {
      throw new Error("No valid USDT pairs with sufficient volume.");
    }

    candidates.sort(
      (a, b) =>
        parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent),
    );

    const hot = candidates[0];
    const symbol = hot.symbol;
    const baseAsset = symbol.replace("USDT", "");
    console.log(`   🔥 Hot coin: ${symbol} (${hot.priceChangePercent}%)`);

    const klinesRes = await fetchWithTimeout(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=100`,
      {},
      10000,
    );
    if (!klinesRes.ok) throw new Error(`Klines HTTP ${klinesRes.status}`);
    const klines = await klinesRes.json();

    const closes = klines.map((candle) => parseFloat(candle[4]));

    const smaShort = movingAverage(closes, SMA_SHORT);
    const smaLong = movingAverage(closes, SMA_LONG);
    const rsi = computeRSI(closes, RSI_PERIOD);

    const lastPrice = parseFloat(hot.lastPrice);
    const priceChange = parseFloat(hot.priceChangePercent);
    const volume = parseFloat(hot.volume);
    const high = parseFloat(hot.highPrice);
    const low = parseFloat(hot.lowPrice);

    const signal = generateSignal({
      lastPrice,
      priceChange,
      smaShort: smaShort[smaShort.length - 1],
      smaLong: smaLong[smaLong.length - 1],
      rsi: rsi[rsi.length - 1],
    });

    console.log(`   ✅ ${symbol} $${lastPrice.toFixed(4)} (${priceChange}%)`);
    console.log(`   📈 Signal: ${signal.direction} (${signal.confidence})`);

    return {
      symbol,
      baseAsset,
      lastPrice,
      priceChangePercent: priceChange,
      volume,
      high,
      low,
      signal,
      smaShort: smaShort[smaShort.length - 1],
      smaLong: smaLong[smaLong.length - 1],
      rsi: rsi[rsi.length - 1],
    };
  } catch (error) {
    console.warn(`   ⚠️ Hot coin fetch failed: ${error.message}`);
    console.log("   ↪️ Falling back to BTCUSDT.");

    // ---- FALLBACK: BTCUSDT ----
    try {
      const tickerRes = await fetchWithTimeout(
        "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
        {},
        10000,
      );
      if (!tickerRes.ok) throw new Error(`BTC ticker HTTP ${tickerRes.status}`);
      const ticker = await tickerRes.json();

      const klinesRes = await fetchWithTimeout(
        "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100",
        {},
        10000,
      );
      if (!klinesRes.ok) throw new Error(`BTC klines HTTP ${klinesRes.status}`);
      const klines = await klinesRes.json();

      const closes = klines.map((candle) => parseFloat(candle[4]));
      const smaShort = movingAverage(closes, SMA_SHORT);
      const smaLong = movingAverage(closes, SMA_LONG);
      const rsi = computeRSI(closes, RSI_PERIOD);

      const lastPrice = parseFloat(ticker.lastPrice);
      const priceChange = parseFloat(ticker.priceChangePercent);
      const volume = parseFloat(ticker.volume);
      const high = parseFloat(ticker.highPrice);
      const low = parseFloat(ticker.lowPrice);

      const signal = generateSignal({
        lastPrice,
        priceChange,
        smaShort: smaShort[smaShort.length - 1],
        smaLong: smaLong[smaLong.length - 1],
        rsi: rsi[rsi.length - 1],
      });

      console.log(
        `   ✅ FALLBACK: BTCUSDT $${lastPrice.toFixed(2)} (${priceChange}%)`,
      );

      return {
        symbol: "BTCUSDT",
        baseAsset: "Bitcoin",
        lastPrice,
        priceChangePercent: priceChange,
        volume,
        high,
        low,
        signal,
        smaShort: smaShort[smaShort.length - 1],
        smaLong: smaLong[smaLong.length - 1],
        rsi: rsi[rsi.length - 1],
      };
    } catch (fallbackError) {
      console.error(
        "❌ Fallback to BTCUSDT also failed:",
        fallbackError.message,
      );
      return null;
    }
  }
}

// ---- Helpers for indicators ----
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
  if (data.length < period + 1) return data.map(() => 50);
  const gains = [],
    losses = [];
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
  while (rsi.length < data.length) rsi.unshift(50);
  return rsi;
}

function generateSignal({ lastPrice, priceChange, smaShort, smaLong, rsi }) {
  let direction = "NEUTRAL";
  let confidence = "LOW";
  let reason = "";

  if (smaShort > smaLong && rsi < 70 && priceChange > 0) {
    direction = "BULLISH";
    confidence = "HIGH";
    reason = "SMA crossover bullish, RSI not overbought, positive momentum.";
  } else if (smaShort < smaLong && rsi > 30 && priceChange < 0) {
    direction = "BEARISH";
    confidence = "HIGH";
    reason = "SMA crossover bearish, RSI not oversold, negative momentum.";
  } else if (smaShort > smaLong) {
    direction = "BULLISH";
    confidence = "MEDIUM";
    reason = "Short-term SMA above long-term SMA.";
  } else if (smaShort < smaLong) {
    direction = "BEARISH";
    confidence = "MEDIUM";
    reason = "Short-term SMA below long-term SMA.";
  } else {
    reason = "No clear trend.";
    confidence = "LOW";
  }

  if (rsi > 80) {
    direction = "BEARISH";
    confidence = "HIGH";
    reason = "RSI overbought, potential pullback.";
  } else if (rsi < 20) {
    direction = "BULLISH";
    confidence = "HIGH";
    reason = "RSI oversold, potential bounce.";
  }

  return { direction, confidence, reason };
}

/* =======================================================
   GOOGLE NEWS RESEARCH
======================================================= */

async function researchWeb() {
  console.log("\n🌐 Searching Google News RSS...");
  let news = [];
  try {
    const response = await fetchWithTimeout(GOOGLE_NEWS_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 BinanceSquareAI/9.2",
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
  } catch (error) {
    console.warn(`   ⚠️ Research failed: ${error.message}`);
    console.log("   ↪️ Will rely on stored trending topics / topic pool.");
    news = [];
  }

  const marketData = await getMarketData();

  return { news, marketData };
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
    title: { type: "string" },
    topic: {
      type: "string",
      enum: ["bitcoin", "ethereum", "bnb", "solana", "xrp", "market", "crypto"],
    },
    content: { type: "string" },
    qualityScore: { type: "number" },
    newsUsed: { type: "boolean" },
    catalystConfidence: {
      type: "string",
      enum: ["LOW", "MEDIUM", "HIGH", "NONE"],
    },
    signal: { type: "string", enum: ["BULLISH", "BEARISH", "NEUTRAL", "NONE"] },
    signalConfidence: {
      type: "string",
      enum: ["LOW", "MEDIUM", "HIGH", "NONE"],
    },
    skip: { type: "boolean" },
    skipReason: { type: "string" },
  },

  required: [
    "title",
    "topic",
    "content",
    "qualityScore",
    "newsUsed",
    "catalystConfidence",
    "signal",
    "signalConfidence",
    "skip",
    "skipReason",
  ],

  additionalProperties: false,
};

/* =======================================================
   GROQ GENERATION (V9.2 – short & punchy)
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
You are a crypto insider posting on Binance Square. You are not an AI – you sound like a real trader sharing a hot tip.

GOAL

Write a **very short** post (200-400 characters) that makes readers stop scrolling.
It must feel like a secret insight – something that gives them an edge.

VOICE & STYLE

- Plain, everyday language (B2 English or easier).
- Short sentences. Very short paragraphs (1-2 lines).
- No emojis, no hashtags inside the body.
- No AI phrases, no hype words, no ALL CAPS.
- First line **must** be a killer headline.
- End with one question that keeps them thinking.

STRUCTURE

- Headline: a bold, curious statement (e.g., "This pattern printed money 3 times before").
- One or two lines of context – a tiny story or observation.
- A subtle hint at a trading move (e.g., "smart money is watching the $1.50 level").
- Close with a question (e.g., "Would you take that trade?").

HARD RULES

- Use the market data if available – but only mention the price, change %, or a single signal (BULLISH/BEARISH).
- Do not list SMA, RSI, or multiple indicators – they are boring.
- Do not promise profits – say "some traders" or "smart money".
- Must include exactly 3 hashtags at the end.
- Must end with "Not financial advice."
- Length: 200-400 characters only – if it's longer, trim it.

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

    signal: String(post?.signal || "NEUTRAL").toUpperCase(),
    signalConfidence: String(post?.signalConfidence || "LOW").toUpperCase(),

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

  const allowedSignals = new Set(["BULLISH", "BEARISH", "NEUTRAL", "NONE"]);
  if (!allowedSignals.has(normalized.signal)) {
    normalized.signal = "NEUTRAL";
  }
  if (
    !["LOW", "MEDIUM", "HIGH", "NONE"].includes(normalized.signalConfidence)
  ) {
    normalized.signalConfidence = "LOW";
  }

  return normalized;
}

/* =======================================================
   HASHTAGS & DISCLAIMER
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

  // Remove any existing disclaimer to avoid duplication
  text = text.replace(/Not financial advice\.\s*$/i, "").trim();

  // Ensure we stay within length limit (roughly)
  if (text.length > 350) {
    // Truncate intelligently – keep the last sentence if possible
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    let truncated = "";
    for (const sent of sentences) {
      if ((truncated + sent).length > 330) break;
      truncated += sent;
    }
    text = truncated.trim();
    if (!text.endsWith(".")) text += ".";
  }

  return `${text}\n\n${finalTags.join(" ")}\n\nNot financial advice.`;
}

/* =======================================================
   FALLBACK POST (short version)
======================================================= */

function buildFallbackPost(selectedTopic, fallbackTopic) {
  const topic = selectedTopic?.title || fallbackTopic;

  const templates = [
    `This pattern printed money 3 times before. Traders who caught it made 10x. Same setup flashing now. Smart money is accumulating. Will you watch or act? #Crypto #Binance #Trading\n\nNot financial advice.`,

    `One trader I know turned $500 into $15k with this move. It's happening again – but most people will ignore it. Don't be most people. Are you ready? #Crypto #Binance #Gains\n\nNot financial advice.`,

    `Everyone thinks it's too late. That's exactly when the real move starts. History shows this level is a springboard. Question is – are you loading up? #Crypto #Binance #Bullish\n\nNot financial advice.`,
  ];

  const content = templates[Math.floor(Math.random() * templates.length)];

  return {
    title: String(topic).slice(0, 60),

    topic: "crypto",

    content: content,

    qualityScore: 7,

    newsUsed: Boolean(selectedTopic),

    catalystConfidence: selectedTopic ? "LOW" : "NONE",

    signal: "NEUTRAL",
    signalConfidence: "LOW",

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
   GENERATE POST (short prompt)
======================================================= */

async function generatePost(newsResearch, marketData) {
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

  let marketBlock = "NO MARKET DATA AVAILABLE.";
  let coinName = "crypto";
  if (marketData) {
    const { symbol, baseAsset, lastPrice, priceChangePercent, signal } =
      marketData;
    coinName = baseAsset || symbol.replace("USDT", "");
    marketBlock = `
Coin: ${symbol} (${baseAsset})
Price: $${lastPrice.toFixed(4)}
24h Change: ${priceChangePercent}%
Signal: ${signal.direction} (${signal.confidence})
`;
  }

  const prompt = `
CURRENT WEB RESEARCH:
${researchBlock}

MARKET DATA (HOTTEST BINANCE COIN):
${marketBlock}

FALLBACK TOPIC:
${fallbackTopic}

RECENT POSTS:
${recentPosts || "None"}

TASK:

Write a **short, punchy** post (200-400 characters) about the coin above.

- If market data is available, mention the coin name, its price, and the signal.
- Give a one‑sentence trading idea (e.g., "accumulate on dips").
- Do NOT list technical indicators – just state the signal and why (one short reason).
- Use a relatable story or "smart money" hook.
- End with a question.
- Keep it under 400 characters.
- Must include 3 hashtags and disclaimer at the end.

Set skip to false unless there is genuinely no usable way to create a post.
`;

  try {
    const post = await callGeneration(prompt, GENERATION_MAX_TOKENS, 3);

    post.content = ensureHashtags(post.content, post.topic);

    return post;
  } catch (error) {
    console.error("⚠️ Groq generation failed:", error.message);

    console.log("↪️ Building fallback post.");

    return buildFallbackPost(selectedTopic, fallbackTopic);
  }
}

/* =======================================================
   FORCE DISCLAIMER (kept for safety)
======================================================= */

function forceDisclaimer(content) {
  let text = String(content || "").trim();

  text = text.replace(/not financial advice\.?/gi, "").trim();

  return `${text}\n\nNot financial advice.`;
}

/* =======================================================
   VALIDATION (still requires disclaimer)
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
    "easy money",
    "guaranteed gains",
    "no risk",
    "zero risk",
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

  return {
    valid: reasons.length === 0,

    reasons,
  };
}

/* =======================================================
   DUPLICATE CHECK (disabled)
======================================================= */

function isDuplicate() {
  return {
    duplicate: false,
    score: 0,
  };
}

/* =======================================================
   IMAGE PROMPT (unchanged)
======================================================= */

function buildImagePrompt(post, marketData) {
  const topic = String(post?.topic || "crypto").toLowerCase();

  const title = String(post?.title || "").slice(0, 250);

  const content = String(post?.content || "")
    .replace(/#[a-zA-Z0-9_]+/g, "")
    .replace(/Not financial advice\./gi, "")
    .slice(0, 700);

  let priceInfo = "";
  let direction = "bullish";
  let coinLabel = "Crypto";
  if (marketData) {
    const { symbol, baseAsset, lastPrice, priceChangePercent, signal } =
      marketData;
    coinLabel = baseAsset || symbol.replace("USDT", "");
    priceInfo = `${symbol} at $${lastPrice.toFixed(4)}, 24h change: ${priceChangePercent}%. Signal: ${signal.direction}.`;
    direction = signal.direction.toLowerCase();
  }

  return `
Create a high-impact crypto trading visual for Binance Square.

Coin: ${coinLabel}
Topic: ${topic}
Headline: ${title}
Context: ${content}
Market context: ${priceInfo}

Visual requirements (MAKE IT LOOK LIKE A REAL PNL DASHBOARD OR CHART):
- A sleek dark theme background (like a trading terminal).
- A large, glowing green (if bullish) or red (if bearish) upward/downward arrow.
- A stylised line chart showing a sharp move in the ${direction} direction.
- Overlay a big text "PNL" with a dollar amount (e.g., "+$12,450" or "-$3,200").
- Include subtle candlestick patterns or volume bars.
- A "Profit" or "Loss" badge with a percentage (e.g., "+18.5%").
- Elements like a stop-loss and take-profit level markers.
- Cinematic lighting with a glow effect.

STRICT NEGATIVE REQUIREMENTS:
- NO readable real ticker symbols or exchange logos.
- NO human faces.
- NO explicit price numbers that could be misinterpreted as exact market prices.
- Keep it artistic but clearly a crypto trading dashboard.
`;
}

/* =======================================================
   CLOUDFLARE IMAGE GENERATION (with optional Sharp)
======================================================= */

let sharp = null;
try {
  const module = await import("sharp");
  sharp = module.default;
} catch {
  // Sharp not installed – skip overlay
}

async function generateImageWithCloudflare(post, marketData) {
  console.log("\n🎨 Generating related image with Cloudflare Workers AI...");

  const prompt = buildImagePrompt(post, marketData);
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

      base64Image = base64Image.replace(/^data:image\/[^;]+;base64,/i, "");

      imageBuffer = Buffer.from(base64Image, "base64");
    } else {
      const arrayBuffer = await response.arrayBuffer();

      imageBuffer = Buffer.from(arrayBuffer);
    }

    if (!imageBuffer || imageBuffer.length < 1000) {
      throw new Error("Cloudflare returned an empty or invalid image.");
    }

    // ---- Optional Sharp overlay ----
    if (sharp) {
      console.log("   🖌️ Applying Sharp overlay (PNL label)");
      try {
        let pnlAmount = "";
        let pnlPercent = "";
        if (marketData && marketData.signal) {
          const direction = marketData.signal.direction;
          const randomBase = 2000 + Math.floor(Math.random() * 8000);
          const sign = direction === "BEARISH" ? "-" : "+";
          pnlAmount = `${sign}$${randomBase.toLocaleString()}`;
          pnlPercent = `${sign}${(Math.random() * 20 + 5).toFixed(1)}%`;
        } else {
          pnlAmount = "+$4,250";
          pnlPercent = "+12.3%";
        }

        const svg = `
          <svg width="600" height="200" xmlns="http://www.w3.org/2000/svg">
            <rect x="20" y="20" width="560" height="160" rx="12" fill="rgba(0,0,0,0.6)" stroke="rgba(255,255,255,0.2)" stroke-width="2"/>
            <text x="40" y="70" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="#4CAF50">PNL</text>
            <text x="180" y="70" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="#FFFFFF">${pnlAmount}</text>
            <text x="40" y="120" font-family="Arial, sans-serif" font-size="24" fill="#AAAAAA">24h Change</text>
            <text x="280" y="120" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="${pnlPercent.startsWith("+") ? "#4CAF50" : "#FF5252"}">${pnlPercent}</text>
            <circle cx="530" cy="100" r="30" fill="${pnlPercent.startsWith("+") ? "#4CAF50" : "#FF5252"}" opacity="0.3"/>
            <text x="520" y="110" font-family="Arial, sans-serif" font-size="24" fill="#FFFFFF">${pnlPercent.startsWith("+") ? "▲" : "▼"}</text>
          </svg>
        `;

        const overlay = Buffer.from(svg);

        imageBuffer = await sharp(imageBuffer)
          .composite([{ input: overlay, gravity: "southwest" }])
          .png()
          .toBuffer();

        console.log("   ✅ Sharp overlay applied.");
      } catch (sharpError) {
        console.warn(
          "   ⚠️ Sharp overlay failed, using original image:",
          sharpError.message,
        );
      }
    } else {
      console.log("   ℹ️ Sharp not installed – skipping overlay.");
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

async function generateAndPublishImage(post, marketData) {
  let imagePath = null;

  try {
    imagePath = await generateImageWithCloudflare(post, marketData);

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

    signal: post.signal || null,
    signalConfidence: post.signalConfidence || null,

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

  console.log("🚀 BINANCE SQUARE AI BOT V9.2.0 (Short & Punchy)");

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
    const { news, marketData } = await researchWeb();

    console.log(`\n📰 Research items available: ${news.length}`);

    pruneStaleTopics().catch(() => {});

    const post = await generatePost(news, marketData);

    console.log("\n📝 Topic:", post.topic);

    console.log("⭐ Quality:", `${post.qualityScore}/10`);

    console.log("📰 Web research used:", post.newsUsed);

    console.log("🎯 Catalyst confidence:", post.catalystConfidence);

    console.log("📈 Signal:", post.signal, `(${post.signalConfidence})`);

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

    let result;

    try {
      console.log("\n🎨 IMAGE PIPELINE STARTING");

      result = await generateAndPublishImage(post, marketData);

      post.imageGenerated = true;

      post.imageGenerationFailed = false;

      console.log("\n🖼️ Image post published successfully.");
    } catch (imageError) {
      console.error("\n⚠️ Image pipeline failed:", imageError.message);

      console.log("↪️ Falling back to text-only Binance Square post.");

      post.imageGenerated = false;

      post.imageGenerationFailed = true;

      result = await publishTextToSquare(post.content);
    }

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

          version: "9.2.0",

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

          imageGeneration: "Cloudflare + optional Sharp overlay",

          imageModel: CLOUDFLARE_IMAGE_MODEL,

          strategy: "Dynamically targets #1 hottest USDT pair by 24h gain",
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
║       🤖 BINANCE SQUARE AI BOT V9.2.0           ║
║          (SHORT & PUNCHY)                       ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);

  console.log(`🧠 Provider: Groq`);

  console.log(`🧠 Model: ${GROQ_MODEL}`);

  console.log(`🔥 Strategy: Dynamically picks #1 hottest USDT pair`);

  console.log(`🌐 Web research: Google News RSS`);

  console.log(`📊 Market data: Binance (real-time)`);

  console.log(`💾 Trending topic storage: MongoDB (${MONGODB_DB_NAME})`);

  console.log(`📈 Signal generation: SMA, RSI (internal)`);

  console.log(`📰 Live news research: ENABLED`);

  console.log(`🛡️ Safety validation: ENABLED`);

  console.log(`🔎 Duplicate protection: DISABLED`);

  console.log(`📡 Binance Square: ENABLED`);

  console.log(`🎨 Image generation: ENABLED`);

  console.log(`🎨 Image provider: Cloudflare Workers AI`);

  console.log(`🎨 Image model: ${CLOUDFLARE_IMAGE_MODEL}`);

  if (sharp) {
    console.log(`🖌️ Sharp overlay: ENABLED (PNL labels added)`);
  } else {
    console.log(`🖌️ Sharp overlay: DISABLED (install sharp for labels)`);
  }

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`);

  console.log(`❓ Topic pool: ${TOPICS.length}`);

  console.log(`🔐 POST authentication: ENABLED`);

  console.log(`⏱️ Internal interval: DISABLED`);

  console.log(`📡 External scheduling: ENABLED`);

  console.log(`🌍 Bot timezone: ${BOT_TIMEZONE}`);

  console.log(`📝 Post length: 200-400 characters (short & punchy)`);

  await startServer();

  console.log("\n🟢 Bot is waiting for external triggers.");

  console.log(
    "📡 POST /post → analyses the hottest coin and posts a short, addictive insight.",
  );

  console.log(
    "📊 Posts include clear direction + one trading idea – no boring numbers.",
  );

  console.log("🎨 Images show realistic PNL dashboards.");

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
