import Groq from "groq-sdk";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { MongoClient } from "mongodb";

dotenv.config();

/*
=========================================================
BINANCE SQUARE AI BOT V10.0.0 – PERSUASIVE EDITION
MODULE EDITION – LOW‑CAP FOCUS (FIXED)
=========================================================
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================================================
   CONFIG
======================================================= */

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
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

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_IMAGE_MODEL =
  process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
const GENERATED_IMAGE_DIR = path.join(__dirname, "generated-images");

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

const GOOGLE_NEWS_URL =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(
    "crypto OR bitcoin OR ethereum OR binance OR solana OR XRP OR PEPE OR SHIB OR DOGE",
  ) +
  "&hl=en-US&gl=US&ceid=US:en";

const SMA_SHORT = 9;
const SMA_LONG = 21;
const RSI_PERIOD = 14;

/* =======================================================
   LOW-PRICE COIN LIST (100 coins)
======================================================= */

const LOW_PRICE_COINS = [
  "XRP",
  "ADA",
  "DOGE",
  "TRX",
  "POL",
  "PEPE",
  "SHIB",
  "XLM",
  "VET",
  "HBAR",
  "ALGO",
  "SAND",
  "MANA",
  "GRT",
  "GALA",
  "FLOKI",
  "BONK",
  "JASMY",
  "CHZ",
  "IOTA",
  "VTHOR",
  "BAT",
  "ONE",
  "IOST",
  "COTI",
  "ENJ",
  "ZIL",
  "ZRX",
  "ONT",
  "ONG",
  "SNT",
  "CVC",
  "REQ",
  "SKL",
  "CTSI",
  "STORJ",
  "LRC",
  "CKB",
  "RVN",
  "DGB",
  "IDEX",
  "CHR",
  "SYS",
  "ARPA",
  "DENT",
  "HOT",
  "WIN",
  "LSK",
  "API3",
  "ANKR",
  "STEEM",
  "HIVE",
  "AERGO",
  "PUNDIX",
  "XEC",
  "PROM",
  "ZK",
  "STRK",
  "ZKL",
  "ZRO",
  "ENA",
  "SUI",
  "SEI",
  "INJ",
  "APT",
  "ARB",
  "OP",
  "ATOM",
  "EOS",
  "XTZ",
  "KAVA",
  "CELO",
  "IOTX",
  "MASK",
  "MAGIC",
  "IMX",
  "AXS",
  "APE",
  "RENDER",
  "FET",
  "OCEAN",
  "AGIX",
  "TRAC",
  "RLC",
  "PHA",
  "NMR",
  "LPT",
  "GNO",
  "SAFE",
  "ZETA",
  "HMSTR",
  "NOT",
  "WIF",
  "BABYDOGE",
  "BRETT",
  "TURBO",
  "TOSHI",
];

/* =======================================================
   HELPER FUNCTIONS
======================================================= */

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) return number;
  return fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/* =======================================================
   ENVIRONMENT VALIDATION
======================================================= */

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY is missing.");
  throw new Error("GROQ_API_KEY is missing.");
}
if (!BINANCE_SQUARE_OPENAPI_KEY) {
  console.error("❌ BINANCE_SQUARE_OPENAPI_KEY is missing.");
  throw new Error("BINANCE_SQUARE_OPENAPI_KEY is missing.");
}
if (!POST_TRIGGER_SECRET) {
  console.error("❌ POST_TRIGGER_SECRET is missing.");
  throw new Error("POST_TRIGGER_SECRET is missing.");
}
if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI is missing.");
  throw new Error("MONGODB_URI is missing.");
}
if (!CLOUDFLARE_ACCOUNT_ID) {
  console.error("❌ CLOUDFLARE_ACCOUNT_ID is missing.");
  throw new Error("CLOUDFLARE_ACCOUNT_ID is missing.");
}
if (!CLOUDFLARE_API_TOKEN) {
  console.error("❌ CLOUDFLARE_API_TOKEN is missing.");
  throw new Error("CLOUDFLARE_API_TOKEN is missing.");
}

const groq = new Groq({ apiKey: GROQ_API_KEY });

/* =======================================================
   MONGODB
======================================================= */

let mongoClient = null;
let db = null;
let trendingTopicsCollection = null;
let postHistoryCollection = null;
let initialized = false;

async function connectMongo() {
  if (mongoClient) return;
  mongoClient = new MongoClient(MONGODB_URI, { maxPoolSize: 5 });
  await mongoClient.connect();
  db = mongoClient.db(MONGODB_DB_NAME);
  trendingTopicsCollection = db.collection("trending_topics");
  postHistoryCollection = db.collection("post_history");
  await trendingTopicsCollection.createIndex({ used: 1, fetchedAt: -1 });
  await trendingTopicsCollection.createIndex(
    { fingerprint: 1 },
    { unique: true },
  );
  await postHistoryCollection.createIndex({ publishedAt: -1 });
  console.log("💾 [Binance] MongoDB connected.");
}

async function disconnectMongo() {
  try {
    if (mongoClient) await mongoClient.close();
    mongoClient = null;
    db = null;
    trendingTopicsCollection = null;
    postHistoryCollection = null;
    console.log("💾 [Binance] MongoDB connection closed.");
  } catch (error) {
    console.warn("⚠️ [Binance] MongoDB close warning:", error.message);
  }
}

/* =======================================================
   TRENDING TOPICS (unchanged)
======================================================= */

function fingerprintTopic(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 180);
}

async function storeTrendingTopics(newsItems) {
  if (!Array.isArray(newsItems) || newsItems.length === 0) return;
  if (!trendingTopicsCollection) return;
  const operations = newsItems.map((item) => ({
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
  if (!trendingTopicsCollection) return null;
  const cutoff = new Date(
    Date.now() - TRENDING_TOPIC_MAX_AGE_HOURS * 60 * 60 * 1000,
  );
  try {
    const topic = await trendingTopicsCollection.findOneAndUpdate(
      { used: false, fetchedAt: { $gte: cutoff } },
      { $set: { used: true, usedAt: new Date() } },
      { sort: { fetchedAt: -1 }, returnDocument: "after" },
    );
    return topic || null;
  } catch (error) {
    console.warn("⚠️ Pulling trending topic failed:", error.message);
    return null;
  }
}

async function pruneStaleTopics() {
  if (!trendingTopicsCollection) return;
  const cutoff = new Date(
    Date.now() - TRENDING_TOPIC_MAX_AGE_HOURS * 4 * 60 * 60 * 1000,
  );
  try {
    await trendingTopicsCollection.deleteMany({ fetchedAt: { $lt: cutoff } });
  } catch (error) {
    console.warn("⚠️ Pruning stale topics failed:", error.message);
  }
}

async function storePostHistory(post, result) {
  if (!postHistoryCollection) return;
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
   STATE (unchanged)
======================================================= */

const STATE_FILE = path.join(__dirname, "bot-state.json");
const STATE_BACKUP_FILE = path.join(__dirname, "bot-state.backup.json");

function getLocalDate() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

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
  if (state.history.length > MAX_HISTORY)
    state.history = state.history.slice(-MAX_HISTORY);
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
    console.log(`📅 [Binance] New local day detected: ${today}`);
    state.date = today;
    state.postsToday = 0;
    saveState().catch((error) => {
      console.error("⚠️ Daily reset save failed:", error.message);
    });
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
      console.log("💾 [Binance] State loaded successfully.");
    }
  } catch {
    console.warn("⚠️ [Binance] Primary state unavailable.");
  }
  if (!loaded) {
    try {
      const raw = await fs.readFile(STATE_BACKUP_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        state = { ...createDefaultState(), ...parsed };
        loaded = true;
        console.log("♻️ [Binance] Backup state restored.");
      }
    } catch {
      console.log("ℹ️ [Binance] No usable state file found.");
    }
  }
  normalizeState();
  resetDailyCounter();
  if (!loaded) {
    await saveState();
    console.log("💾 [Binance] Fresh state created.");
  }
}

/* =======================================================
   FETCH WITH TIMEOUT (unchanged)
======================================================= */

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
   XML HELPERS (unchanged)
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
   BINANCE MARKET DATA (prioritises low‑price coins)
======================================================= */

async function getMarketData() {
  console.log("\n📊 [Binance] Fetching market data...");
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
      return vol > 500_000;
    });

    if (candidates.length === 0)
      throw new Error("No valid USDT pairs with sufficient volume.");

    const lowPriceSymbols = new Set(LOW_PRICE_COINS.map((c) => c + "USDT"));
    const lowCandidates = candidates.filter((t) =>
      lowPriceSymbols.has(t.symbol),
    );

    let selected;
    if (Math.random() < 0.8 && lowCandidates.length > 0) {
      selected =
        lowCandidates[Math.floor(Math.random() * lowCandidates.length)];
    } else {
      const pool = lowCandidates.length > 0 ? lowCandidates : candidates;
      pool.sort(
        (a, b) =>
          parseFloat(b.quoteVolume) * parseFloat(b.priceChangePercent) -
          parseFloat(a.quoteVolume) * parseFloat(a.priceChangePercent),
      );
      const top5 = pool.slice(0, 5);
      selected = top5[Math.floor(Math.random() * top5.length)];
    }

    const symbol = selected.symbol;
    const baseAsset = symbol.replace("USDT", "");
    console.log(`   🔥 Selected coin: ${symbol}`);

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

    const lastPrice = parseFloat(selected.lastPrice);
    const priceChange = parseFloat(selected.priceChangePercent);
    const volume = parseFloat(selected.volume);
    const high = parseFloat(selected.highPrice);
    const low = parseFloat(selected.lowPrice);

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
    console.warn(`   ⚠️ Market data fetch failed: ${error.message}`);
    // Instead of falling back to BTC, we return null so that generatePost picks a random coin.
    console.log("   ↪️ No market data – will use random low‑cap coin.");
    return null;
  }
}

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
    reason = "SMA crossover bullish, RSI not overbought.";
  } else if (smaShort < smaLong && rsi > 30 && priceChange < 0) {
    direction = "BEARISH";
    confidence = "HIGH";
    reason = "SMA crossover bearish, RSI not oversold.";
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
    reason = "RSI overbought.";
  } else if (rsi < 20) {
    direction = "BULLISH";
    confidence = "HIGH";
    reason = "RSI oversold.";
  }
  return { direction, confidence, reason };
}

/* =======================================================
   GOOGLE NEWS RESEARCH
======================================================= */

async function researchWeb() {
  console.log("\n🌐 [Binance] Searching Google News RSS...");
  let news = [];
  try {
    const response = await fetchWithTimeout(GOOGLE_NEWS_URL, {
      headers: {
        "User-Agent": "Mozilla/5.0 BinanceSquareAI/10.0",
        Accept: "application/rss+xml, application/xml, text/xml",
      },
    });
    if (!response.ok) throw new Error(`Google News HTTP ${response.status}`);
    const xml = await response.text();
    if (!xml || xml.length < 100)
      throw new Error("Google News returned an empty response.");
    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];
    if (items.length === 0) throw new Error("No RSS items found.");
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
    if (news.length === 0) throw new Error("RSS contained no usable articles.");
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

function getRandomCoin() {
  return LOW_PRICE_COINS[Math.floor(Math.random() * LOW_PRICE_COINS.length)];
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

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
   POST SCHEMA – topic enum expanded with common coins?
   Actually we keep it as is, but we'll force AI to use one.
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
   GROQ GENERATION – now forces allowed topic & no BTC unless coin is BTC
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
You are a successful retail crypto trader sharing your personal trade experience on Binance Square.

Your goal is to create a highly persuasive, authentic-looking post that encourages readers to take action.

ABSOLUTE RULES:

- **Start with a unique, attention‑grabbing line** – never repeat the same opener. Examples:
  "If you don't buy $[TICKER] now, you will regret it in 24 hours."
  "Thank me later – this coin is about to explode."
  "The next 10x is here. Don't sleep on $[TICKER]."
  "I've been watching this one for weeks – now is the time."
  "Buy $[TICKER] or you'll wish you had."
- **State a clear prediction**: "I'm going LONG" / "SHORT" / "HOLD".
- **Give a specific price target** (e.g., "I see $0.05 in the next week").
- **Mention the current price** and a short reason (technical breakout, catalyst, momentum).
- **End with a question** to encourage comments (e.g., "Who's buying with me?").
- **Do NOT mention "Bitcoin", "BTC", or any other coin** – only talk about the given coin.
- **Include 3-4 relevant hashtags** at the end (e.g., #PEPE #Memecoin #Breakout). Do NOT use generic ones like #Crypto or #Profit unless they are truly relevant to the post.
- **DO NOT** use generic disclaimers like "not financial advice".
- **Topic field:** Must be one of: "bitcoin", "ethereum", "bnb", "solana", "xrp", "market", "crypto". If the coin is not one of the first five, use "crypto". Always pick one of these exact strings.
- Use short, punchy sentences.
- Make each post unique by varying the structure and wording.

TARGET LENGTH: 150-300 characters.

CONTEXT:

${prompt}
`,
          },
        ],
        temperature: 0.9,
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
      if (!raw) throw new Error("Groq returned empty content.");
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
      if (attempt >= retries) throw error;
      await sleep(1500 * attempt);
    }
  }
  throw new Error("Groq generation failed.");
}

function normalizeGeneratedPost(post) {
  const normalized = {
    title: String(post?.title || "Crypto Trade Setup")
      .trim()
      .slice(0, 120),
    topic: String(post?.topic || "crypto")
      .toLowerCase()
      .trim(),
    content: String(post?.content || "").trim(),
    qualityScore: Number.isFinite(Number(post?.qualityScore))
      ? Number(post.qualityScore)
      : 8,
    newsUsed: Boolean(post?.newsUsed),
    catalystConfidence: String(
      post?.catalystConfidence || "NONE",
    ).toUpperCase(),
    signal: String(post?.signal || "BULLISH").toUpperCase(),
    signalConfidence: String(post?.signalConfidence || "HIGH").toUpperCase(),
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
  if (!allowedTopics.has(normalized.topic)) normalized.topic = "crypto";
  if (
    !["LOW", "MEDIUM", "HIGH", "NONE"].includes(normalized.catalystConfidence)
  )
    normalized.catalystConfidence = "NONE";
  const allowedSignals = new Set(["BULLISH", "BEARISH", "NEUTRAL", "NONE"]);
  if (!allowedSignals.has(normalized.signal)) normalized.signal = "BULLISH";
  if (!["LOW", "MEDIUM", "HIGH", "NONE"].includes(normalized.signalConfidence))
    normalized.signalConfidence = "HIGH";
  return normalized;
}

/* =======================================================
   HASHTAGS – removed; AI generates its own
======================================================= */

// No ensureHashtags function.

/* =======================================================
   FALLBACK POST – uses random coin, not BTC
======================================================= */

function buildFallbackPost(selectedTopic, fallbackCoin, marketData = null) {
  const tick = fallbackCoin; // already a symbol like "ATOM"
  const price = marketData?.lastPrice;
  const priceText = Number.isFinite(price)
    ? `$${price.toFixed(4)}`
    : "current levels";
  const targetMultiplier = 1.15 + Math.random() * 0.15;
  const targetPrice = Number.isFinite(price) ? price * targetMultiplier : null;
  const targetText = targetPrice ? `$${targetPrice.toFixed(4)}` : "higher";

  const openers = [
    `If you don't buy $${tick} now, you will regret it in 24 hours.`,
    `Thank me later – $${tick} is about to explode.`,
    `The next 10x is here. Don't sleep on $${tick}.`,
    `I've been watching $${tick} for weeks – now is the time.`,
    `Buy $${tick} or you'll wish you had.`,
  ];
  const opener = openers[Math.floor(Math.random() * openers.length)];
  const direction = Math.random() > 0.3 ? "LONG" : "HOLD";
  const tags = [`#${tick}`, "#Crypto", "#Trade"].join(" ");
  const content = `${opener} Current price: ${priceText}. I'm going **${direction}** with a target of ${targetText}. Momentum is building – who's with me?\n\n${tags}`;
  return {
    title: `$${tick} breakout?`,
    topic: "crypto",
    content,
    qualityScore: 8,
    newsUsed: Boolean(selectedTopic),
    catalystConfidence: selectedTopic ? "LOW" : "NONE",
    signal: direction === "LONG" ? "BULLISH" : "NEUTRAL",
    signalConfidence: "HIGH",
    skip: false,
    skipReason: "",
  };
}

/* =======================================================
   SELECT TOPIC (unchanged)
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
    return { ...picked, fromDb: false };
  }
  return null;
}

/* =======================================================
   GENERATE POST – always uses a coin from LOW_PRICE_COINS
======================================================= */

async function generatePost(newsResearch, marketData) {
  const recentPosts = getRecentPostMemory();
  const selectedTopic = await selectTopic(newsResearch);

  // Determine the coin to talk about
  let coinSymbol;
  if (marketData) {
    coinSymbol = marketData.symbol.replace("USDT", "");
  } else {
    coinSymbol = getRandomCoin();
  }

  console.log("\n🎯 [Binance] Selected topic:");
  if (selectedTopic) {
    console.log(`   📰 ${selectedTopic.title}`);
    console.log(
      `   🗄️ Source: ${
        selectedTopic.fromDb ? "MongoDB trending store" : "live RSS"
      }`,
    );
  } else {
    console.log(`   💡 ${coinSymbol}`);
  }

  let researchBlock = "NO CURRENT WEB RESEARCH AVAILABLE.";
  if (selectedTopic) {
    researchBlock = `
Headline: ${selectedTopic.title}
Description: ${selectedTopic.description || ""}
Published: ${selectedTopic.publishedAt || ""}
Source: ${selectedTopic.source || "Unknown"}
`;
  }

  let marketBlock = "NO MARKET DATA AVAILABLE.";
  if (marketData) {
    const { symbol, baseAsset, lastPrice, priceChangePercent, signal } =
      marketData;
    marketBlock = `
Coin: ${symbol} (${baseAsset})
Price: $${lastPrice.toFixed(4)}
24h Change: ${priceChangePercent}%
Signal: ${signal.direction} (${signal.confidence}) - ${signal.reason}
`;
  }

  const prompt = `
CURRENT WEB RESEARCH:

${researchBlock}

MARKET DATA:

${marketBlock}

COIN TO TALK ABOUT: ${coinSymbol}

RECENT POSTS:

${recentPosts || "None"}

TASK:

Write a persuasive, urgent Binance Square post about the coin ${coinSymbol}.

- Use the market data accurately if available.
- Make the post sound like a real trader sharing a high‑conviction trade.
- Be specific, urgent, and engaging.
- Do not include any disclaimer.
- Include a clear prediction (LONG/SHORT/HOLD) and a price target.
- Start with a unique opening line (do not repeat).
- **Do NOT mention "Bitcoin", "BTC", or any other coin** – only talk about ${coinSymbol}.
- **Include 3-4 relevant hashtags** at the end, unique to this coin and the message.
- **Topic field:** Must be one of: "bitcoin", "ethereum", "bnb", "solana", "xrp", "market", "crypto". Use "crypto" if the coin doesn't fit the others.

The coin is ${coinSymbol}.
`;
  try {
    const post = await callGeneration(prompt, GENERATION_MAX_TOKENS, 3);
    return post;
  } catch (error) {
    console.error("⚠️ Groq generation failed:", error.message);
    console.log("↪️ Building fallback post.");
    return buildFallbackPost(selectedTopic, coinSymbol, marketData);
  }
}

/* =======================================================
   VALIDATION – relaxed
======================================================= */

function validatePost(post) {
  const reasons = [];
  if (!post) return { valid: false, reasons: ["empty post"] };
  const content = String(post.content || "").trim();
  if (content.length < 60) reasons.push("post is too short");
  if (content.length > 5000) reasons.push("post is too long");
  const lower = content.toLowerCase();
  const forbidden = [
    "guaranteed profit",
    "guaranteed return",
    "risk free",
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
    if (lower.includes(phrase)) reasons.push(`forbidden phrase: ${phrase}`);
  }
  return { valid: reasons.length === 0, reasons };
}

function isDuplicate() {
  return { duplicate: false, score: 0 };
}

/* =======================================================
   IMAGE PROMPT – clean 1:1, uses correct coin
======================================================= */

function buildImagePrompt(marketData, coinSymbol) {
  const ticker = coinSymbol || "BTC";
  const price = marketData?.lastPrice?.toFixed(4) || "0.00";
  const direction = marketData?.signal?.direction?.toLowerCase() || "bullish";
  const arrow =
    direction === "bullish" ? "⬆️" : direction === "bearish" ? "⬇️" : "➡️";
  let target = "";
  if (marketData?.lastPrice) {
    const multiplier = 1.15 + Math.random() * 0.2;
    const targetPrice = marketData.lastPrice * multiplier;
    target = `Target: $${targetPrice.toFixed(4)}`;
  } else {
    target = "Target: higher";
  }

  return `
Generate a **simple, clean, 1:1 square image** for a crypto social media post.

**Style**: Minimalist, dark theme, neon accents (like a trading terminal).
**Content**:
- Large coin symbol: $${ticker} (centered)
- Current price: $${price}
- A bold arrow (${arrow}) indicating the predicted direction
- A subtle price target label: "${target}"

**Requirements**:
- Aspect ratio: **1:1** (square)
- No human faces, no text paragraphs, no wallet UI.
- Use a sleek gradient background (dark blue/purple to black).
- Keep it **clean** – only the elements listed above.
- No fake PNL or percentage gains.
`;
}

/* =======================================================
   CLOUDFLARE IMAGE GENERATION
======================================================= */

async function generateImageWithCloudflare(marketData, coinSymbol) {
  console.log("\n🎨 [Binance] Generating image with Cloudflare Workers AI...");

  const prompt = buildImagePrompt(marketData, coinSymbol);
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
        body: JSON.stringify({ prompt }),
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
      if (Array.isArray(base64Image)) base64Image = base64Image[0];
      if (typeof base64Image !== "string")
        throw new Error("Cloudflare returned JSON but no image data.");
      base64Image = base64Image.replace(/^data:image\/[^;]+;base64,/i, "");
      imageBuffer = Buffer.from(base64Image, "base64");
    } else {
      const arrayBuffer = await response.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    }

    if (!imageBuffer || imageBuffer.length < 1000)
      throw new Error("Cloudflare returned an empty or invalid image.");

    console.log("   ✅ Image generated.");

    await fs.mkdir(GENERATED_IMAGE_DIR, { recursive: true });
    const timestamp = Date.now();
    const random = Math.random().toString(36).slice(2, 8);
    const imagePath = path.join(
      GENERATED_IMAGE_DIR,
      `coin-${timestamp}-${random}.png`,
    );
    await fs.writeFile(imagePath, imageBuffer);
    console.log(`   ✅ Image saved: ${imagePath}`);
    console.log(
      `   📦 Image size: ${(imageBuffer.length / 1024).toFixed(1)} KB`,
    );
    return imagePath;
  } catch (error) {
    console.error("❌ Cloudflare image generation failed:", error.message);
    throw error;
  }
}

async function cleanupGeneratedImage(imagePath) {
  if (!imagePath) return;
  try {
    await fs.unlink(imagePath);
    console.log("🧹 Temporary image deleted.");
  } catch (error) {
    if (error.code !== "ENOENT")
      console.warn("⚠️ Could not delete temporary image:", error.message);
  }
}

/* =======================================================
   PUBLISHERS (unchanged)
======================================================= */

function publishTextToSquare(content) {
  return new Promise((resolve, reject) => {
    console.log("\n📡 [Binance] Publishing text to Binance Square...");
    if (DRY_RUN) {
      console.log("🧪 DRY_RUN=true");
      console.log("\n----- GENERATED POST -----\n");
      console.log(content);
      console.log("\n--------------------------\n");
      resolve({ success: true, dryRun: true, id: null, link: null });
      return;
    }
    fs.access(SQUARE_TEXT_SCRIPT)
      .then(() => {
        const child = spawn("node", [SQUARE_TEXT_SCRIPT, "--text", content], {
          cwd: path.join(__dirname, ".agents", "skills", "square-post"),
          env: { ...process.env, BINANCE_SQUARE_OPENAPI_KEY },
          shell: false,
          windowsHide: true,
        });
        let stdout = "",
          stderr = "",
          settled = false;
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
        child.on("error", finishReject);
        child.on("close", (code) => {
          if (code !== 0) {
            finishReject(
              new Error(`Square publisher exited with code ${code}\n${stderr}`),
            );
            return;
          }
          const id = stdout.match(/ID:\s*(.+)/i)?.[1]?.trim() || null;
          const link = stdout.match(/Link:\s*(.+)/i)?.[1]?.trim() || null;
          finishResolve({ success: true, dryRun: false, id, link, stdout });
        });
      })
      .catch((error) =>
        reject(
          new Error(
            `Binance Square publisher script not found: ${error.message}`,
          ),
        ),
      );
  });
}

function publishImageToSquare(content, imagePath) {
  return new Promise((resolve, reject) => {
    console.log("\n📡 [Binance] Publishing image post to Binance Square...");
    if (DRY_RUN) {
      console.log("🧪 DRY_RUN=true");
      console.log("\n----- GENERATED POST -----\n");
      console.log(content);
      console.log("\n🖼️ Image:", imagePath);
      console.log("\n--------------------------\n");
      resolve({ success: true, dryRun: true, id: null, link: null });
      return;
    }
    fs.access(SQUARE_IMAGE_SCRIPT)
      .then(() => {
        const child = spawn(
          "node",
          [SQUARE_IMAGE_SCRIPT, "--text", content, "--images", imagePath],
          {
            cwd: path.join(__dirname, ".agents", "skills", "square-post"),
            env: { ...process.env, BINANCE_SQUARE_OPENAPI_KEY },
            shell: false,
            windowsHide: true,
          },
        );
        let stdout = "",
          stderr = "",
          settled = false;
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
        child.on("error", finishReject);
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
          finishResolve({ success: true, dryRun: false, id, link, stdout });
        });
      })
      .catch((error) =>
        reject(
          new Error(
            `Binance Square image publisher script not found: ${error.message}`,
          ),
        ),
      );
  });
}

/* =======================================================
   IMAGE PIPELINE
======================================================= */

async function generateAndPublishImage(post, marketData, coinSymbol) {
  let imagePath = null;
  try {
    imagePath = await generateImageWithCloudflare(marketData, coinSymbol);
    const result = await publishImageToSquare(post.content, imagePath);
    return { ...result, imageGenerated: true };
  } finally {
    await cleanupGeneratedImage(imagePath);
  }
}

/* =======================================================
   SAVE POST (unchanged)
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
   MAIN CYCLE – now passes coinSymbol to image
======================================================= */

async function runCycle() {
  resetDailyCounter();

  console.log("\n================================================");
  console.log("🚀 BINANCE SQUARE AI BOT V10.0.0 – PERSUASIVE");
  console.log("================================================");
  console.log(
    `🕐 ${new Date().toLocaleString("en-US", { timeZone: BOT_TIMEZONE })}`,
  );
  console.log(`🌍 Timezone: ${BOT_TIMEZONE}`);
  console.log(`📅 Posts: ${state.postsToday}/${MAX_POSTS_PER_DAY}`);

  if (state.postsToday >= MAX_POSTS_PER_DAY) {
    console.log("\n🛑 Daily limit reached.");
    state.totalSkipped++;
    await saveState();
    return { success: false, skipped: true, reason: "daily_limit" };
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
      for (const reason of validation.reasons) console.error(`   • ${reason}`);
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
      return { success: false, skipped: true, reason: "duplicate" };
    }
    console.log("   ✓ Duplicate protection disabled.");

    let result;
    // Determine coin symbol for image
    let coinSymbol = "BTC";
    if (marketData) {
      coinSymbol = marketData.symbol.replace("USDT", "");
    } else {
      // fallback: extract from post content? we can get from prompt? easier: we stored it in generatePost but not returned.
      // We'll extract from post content (look for $[COIN])
      const match = post.content.match(/\$([A-Z]+)/);
      if (match) coinSymbol = match[1];
    }

    try {
      console.log("\n🎨 IMAGE PIPELINE STARTING (Square Image)");
      result = await generateAndPublishImage(post, marketData, coinSymbol);
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
    if (result.id) console.log(`🆔 ID: ${result.id}`);
    if (result.link) console.log(`🔗 ${result.link}`);
    if (result.dryRun) console.log("🧪 DRY RUN — not published.");
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
    return { success: false, error: error?.message || "Unknown error" };
  }
}

/* =======================================================
   SAFE CYCLE WRAPPER, INIT, STATUS, SHUTDOWN (unchanged)
======================================================= */

let cycleRunning = false;

async function safeRunCycle() {
  if (cycleRunning) {
    console.log("⚠️ Previous cycle is still running.");
    return { success: false, error: "A post cycle is already running." };
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

async function initializeBinanceBot() {
  if (initialized) return;

  console.log("\n==============================================");
  console.log("🤖 INITIALIZING BINANCE BOT (PERSUASIVE)");
  console.log("==============================================");

  await connectMongo();
  await loadState();

  console.log(`🧠 Provider: Groq (${GROQ_MODEL})`);
  console.log(`🔥 Strategy: Momentum + Low‑Cap Coin Focus`);
  console.log(`🌐 Web research: Google News RSS (expanded)`);
  console.log(`📊 Market data: Binance real-time`);
  console.log(`💾 Trending topic storage: MongoDB (${MONGODB_DB_NAME})`);
  console.log(`📈 Signal generation: SMA + RSI`);
  console.log(`🛡️ Safety validation: ENABLED (relaxed)`);
  console.log(`🎨 Image generation: ENABLED (clean 1:1 square)`);
  console.log(
    `🎨 Image provider: Cloudflare Workers AI (${CLOUDFLARE_IMAGE_MODEL})`,
  );
  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  console.log(`🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`);
  console.log(`🪙 Low‑price coin pool: ${LOW_PRICE_COINS.length} coins`);

  initialized = true;
  console.log("✅ Binance bot initialized.");
}

async function runBinanceBot() {
  await initializeBinanceBot();
  return await safeRunCycle();
}

function getBinanceStatus() {
  resetDailyCounter();
  return {
    service: "binance-square-ai-bot",
    version: "10.0.0",
    timezone: BOT_TIMEZONE,
    localDate: getLocalDate(),
    postsToday: state.postsToday,
    maxPostsPerDay: MAX_POSTS_PER_DAY,
    totalPosts: state.totalPosts,
    totalFailures: state.totalFailures,
    totalSkipped: state.totalSkipped,
    lastPostAt: state.lastPostAt,
    lastTriggerAt: state.lastTriggerAt,
    lastTriggerResult: state.lastTriggerResult,
    cycleRunning,
    dryRun: DRY_RUN,
    mongoConnected: Boolean(mongoClient),
    imageGeneration: "Cloudflare",
    imageModel: CLOUDFLARE_IMAGE_MODEL,
  };
}

async function shutdownBinanceBot() {
  console.log("🛑 Shutting down Binance bot...");
  try {
    await saveState();
  } catch (error) {
    console.error("⚠️ Final state save failed:", error.message);
  }
  await disconnectMongo();
  initialized = false;
  console.log("👋 Binance bot shutdown complete.");
}

export {
  runBinanceBot,
  safeRunCycle,
  runCycle,
  initializeBinanceBot,
  getBinanceStatus,
  shutdownBinanceBot,
  POST_TRIGGER_SECRET,
};
