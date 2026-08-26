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
BINANCE SQUARE AI BOT V10.3.0
TEXT ONLY – QUANTITATIVE CYCLE ANALYSIS
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

const SQUARE_TEXT_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-text.mjs",
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
   HELPERS
======================================================= */

function parsePositiveInteger(value, fallback) {
  const number = Number(value);

  if (Number.isInteger(number) && number > 0) {
    return number;
  }

  return fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/* =======================================================
   ENVIRONMENT VALIDATION
======================================================= */

if (!GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is missing.");
}

if (!BINANCE_SQUARE_OPENAPI_KEY) {
  throw new Error("BINANCE_SQUARE_OPENAPI_KEY is missing.");
}

if (!POST_TRIGGER_SECRET) {
  throw new Error("POST_TRIGGER_SECRET is missing.");
}

if (!MONGODB_URI) {
  throw new Error("MONGODB_URI is missing.");
}

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

let initialized = false;

async function connectMongo() {
  if (mongoClient) return;

  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 10000,
  });

  await mongoClient.connect();

  db = mongoClient.db(MONGODB_DB_NAME);

  trendingTopicsCollection = db.collection("trending_topics");

  postHistoryCollection = db.collection("post_history");

  try {
    await trendingTopicsCollection.createIndex({
      used: 1,
      fetchedAt: -1,
    });
  } catch {}

  try {
    await trendingTopicsCollection.createIndex(
      {
        fingerprint: 1,
      },
      {
        unique: true,
      },
    );
  } catch {}

  try {
    await postHistoryCollection.createIndex({
      publishedAt: -1,
    });
  } catch {}

  console.log("💾 [Binance] MongoDB connected.");
}

async function disconnectMongo() {
  try {
    if (mongoClient) {
      await mongoClient.close();
    }

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
  if (
    !Array.isArray(newsItems) ||
    newsItems.length === 0 ||
    !trendingTopicsCollection
  ) {
    return;
  }

  const operations = newsItems
    .map((item) => {
      const fingerprint = fingerprintTopic(item.title);

      if (!fingerprint) return null;

      return {
        updateOne: {
          filter: {
            fingerprint,
          },
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
    })
    .filter(Boolean);

  if (operations.length === 0) return;

  try {
    const result = await trendingTopicsCollection.bulkWrite(operations, {
      ordered: false,
    });

    console.log(
      `   💾 Trending topics stored: ${result.upsertedCount || 0} new / ${newsItems.length} processed.`,
    );
  } catch (error) {
    console.warn("⚠️ Storing trending topics failed:", error.message);
  }
}

async function pullTrendingTopic() {
  if (!trendingTopicsCollection) {
    return null;
  }

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
  if (!trendingTopicsCollection) {
    return;
  }

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
  if (!postHistoryCollection) {
    return;
  }

  try {
    await postHistoryCollection.insertOne({
      id: result?.id || null,
      title: post.title || null,
      topic: post.topic || "crypto",
      text: post.content || "",
      qualityScore: Number(post.qualityScore) || 0,
      newsUsed: Boolean(post.newsUsed),
      catalystConfidence: post.catalystConfidence || "NONE",
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
   TOPICS
======================================================= */

const TOPICS = [
  "Bitcoin",
  "Ethereum",
  "BNB",
  "Solana",
  "XRP",
  "PEPE",
  "SHIB",
  "DOGE",
  "TUT",
  "WIF",
  "BONK",
  "FLOKI",
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

const MEME_COINS = ["PEPE", "SHIB", "DOGE", "WIF", "BONK", "FLOKI", "TUT"];

/* =======================================================
   STATE
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
      state = {
        ...createDefaultState(),
        ...parsed,
      };

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
        state = {
          ...createDefaultState(),
          ...parsed,
        };

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

  if (!match) {
    return "";
  }

  return decodeXml(stripHtml(match[1])).trim();
}

/* =======================================================
   MARKET DATA (BASIC & ADVANCED)
======================================================= */

async function getMarketData() {
  console.log("\n📊 [Binance] Fetching market data...");

  try {
    const tickerRes = await fetchWithTimeout(
      "https://api.binance.com/api/v3/ticker/24hr",
      {},
      10000,
    );

    if (!tickerRes.ok) {
      throw new Error(`Ticker HTTP ${tickerRes.status}`);
    }

    const allTickers = await tickerRes.json();

    if (!Array.isArray(allTickers)) {
      throw new Error("Invalid ticker response.");
    }

    const stablecoins = new Set([
      "USDCUSDT",
      "TUSDUSDT",
      "DAIUSDT",
      "FDUSDUSDT",
      "BUSDUSDT",
    ]);

    const candidates = allTickers.filter((ticker) => {
      if (!ticker?.symbol?.endsWith("USDT")) {
        return false;
      }

      if (stablecoins.has(ticker.symbol)) {
        return false;
      }

      const volume = Number(ticker.quoteVolume);

      return Number.isFinite(volume) && volume > 500_000;
    });

    if (candidates.length === 0) {
      throw new Error("No valid USDT pairs with sufficient volume.");
    }

    let selected = null;

    const memeCandidates = candidates.filter((ticker) =>
      MEME_COINS.some((meme) => ticker.symbol.startsWith(meme)),
    );

    if (Math.random() < 0.3 && memeCandidates.length > 0) {
      selected =
        memeCandidates[Math.floor(Math.random() * memeCandidates.length)];
    } else {
      const ranked = [...candidates].sort((a, b) => {
        const aVolume = Number(a.quoteVolume) || 0;

        const bVolume = Number(b.quoteVolume) || 0;

        const aChange = Number(a.priceChangePercent) || 0;

        const bChange = Number(b.priceChangePercent) || 0;

        return (
          bVolume * Math.max(bChange, 0.1) - aVolume * Math.max(aChange, 0.1)
        );
      });

      const topCandidates = ranked.slice(0, Math.min(10, ranked.length));

      selected =
        topCandidates[Math.floor(Math.random() * topCandidates.length)];
    }

    if (!selected) {
      throw new Error("Unable to select a market.");
    }

    const symbol = selected.symbol;
    const baseAsset = symbol.replace(/USDT$/i, "");

    console.log(`   🔥 Selected coin: ${symbol}`);

    const klinesRes = await fetchWithTimeout(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(
        symbol,
      )}&interval=1h&limit=100`,
      {},
      10000,
    );

    if (!klinesRes.ok) {
      throw new Error(`Klines HTTP ${klinesRes.status}`);
    }

    const klines = await klinesRes.json();

    if (!Array.isArray(klines) || klines.length < SMA_LONG) {
      throw new Error("Insufficient kline data.");
    }

    const closes = klines
      .map((candle) => Number(candle?.[4]))
      .filter(Number.isFinite);

    if (closes.length < SMA_LONG) {
      throw new Error("Insufficient valid closing prices.");
    }

    const smaShort = movingAverage(closes, SMA_SHORT);

    const smaLong = movingAverage(closes, SMA_LONG);

    const rsi = computeRSI(closes, RSI_PERIOD);

    const lastPrice = Number(selected.lastPrice);

    const priceChange = Number(selected.priceChangePercent);

    const volume = Number(selected.volume);

    const high = Number(selected.highPrice);

    const low = Number(selected.lowPrice);

    if (!Number.isFinite(lastPrice) || !Number.isFinite(priceChange)) {
      throw new Error("Invalid ticker numerical data.");
    }

    const latestSmaShort = smaShort[smaShort.length - 1];

    const latestSmaLong = smaLong[smaLong.length - 1];

    const latestRsi = rsi[rsi.length - 1];

    const signal = generateSignal({
      lastPrice,
      priceChange,
      smaShort: latestSmaShort,
      smaLong: latestSmaLong,
      rsi: latestRsi,
    });

    console.log(
      `   ✅ ${symbol} $${formatPrice(lastPrice)} (${priceChange.toFixed(2)}%)`,
    );

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
      smaShort: latestSmaShort,
      smaLong: latestSmaLong,
      rsi: latestRsi,
    };
  } catch (error) {
    console.warn(`   ⚠️ Market data fetch failed: ${error.message}`);

    console.log("   ↪️ Falling back to BTCUSDT.");

    return await getBTCFallback();
  }
}

async function getBTCFallback() {
  try {
    const tickerRes = await fetchWithTimeout(
      "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT",
      {},
      10000,
    );

    if (!tickerRes.ok) {
      throw new Error(`BTC ticker HTTP ${tickerRes.status}`);
    }

    const ticker = await tickerRes.json();

    const klinesRes = await fetchWithTimeout(
      "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=100",
      {},
      10000,
    );

    if (!klinesRes.ok) {
      throw new Error(`BTC klines HTTP ${klinesRes.status}`);
    }

    const klines = await klinesRes.json();

    const closes = klines
      .map((candle) => Number(candle?.[4]))
      .filter(Number.isFinite);

    const smaShort = movingAverage(closes, SMA_SHORT);

    const smaLong = movingAverage(closes, SMA_LONG);

    const rsi = computeRSI(closes, RSI_PERIOD);

    const lastPrice = Number(ticker.lastPrice);

    const priceChange = Number(ticker.priceChangePercent);

    const volume = Number(ticker.volume);

    const high = Number(ticker.highPrice);

    const low = Number(ticker.lowPrice);

    const signal = generateSignal({
      lastPrice,
      priceChange,
      smaShort: smaShort[smaShort.length - 1],
      smaLong: smaLong[smaLong.length - 1],
      rsi: rsi[rsi.length - 1],
    });

    console.log(
      `   ✅ FALLBACK: BTCUSDT $${formatPrice(
        lastPrice,
      )} (${priceChange.toFixed(2)}%)`,
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
  } catch (error) {
    console.error("❌ Fallback to BTCUSDT also failed:", error.message);

    return null;
  }
}

function formatPrice(price) {
  if (!Number.isFinite(Number(price))) {
    return "N/A";
  }

  const value = Number(price);

  if (value >= 1000) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  if (value >= 1) {
    return value.toFixed(4);
  }

  if (value >= 0.01) {
    return value.toFixed(6);
  }

  return value.toFixed(10);
}

function movingAverage(data, period) {
  const result = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    const window = data.slice(i - period + 1, i + 1);

    const sum = window.reduce((total, value) => total + value, 0);

    result.push(sum / period);
  }

  return result;
}

function computeRSI(data, period = 14) {
  if (!Array.isArray(data) || data.length < period + 1) {
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

    if (avgGain[i] === 0 && avgLoss[i] === 0) {
      rsi.push(50);
      continue;
    }

    if (avgLoss[i] === 0) {
      rsi.push(100);
      continue;
    }

    const rs = avgGain[i] / avgLoss[i];

    rsi.push(100 - 100 / (1 + rs));
  }

  while (rsi.length < data.length) {
    rsi.unshift(50);
  }

  return rsi;
}

function generateSignal({ lastPrice, priceChange, smaShort, smaLong, rsi }) {
  let direction = "NEUTRAL";
  let confidence = "LOW";
  let reason = "No clear trend.";

  if (
    Number.isFinite(smaShort) &&
    Number.isFinite(smaLong) &&
    Number.isFinite(rsi)
  ) {
    if (smaShort > smaLong && rsi < 70 && priceChange > 0) {
      direction = "BULLISH";
      confidence = "HIGH";
      reason =
        "Short-term trend is above the long-term trend with positive momentum.";
    } else if (smaShort < smaLong && rsi > 30 && priceChange < 0) {
      direction = "BEARISH";
      confidence = "HIGH";
      reason =
        "Short-term trend is below the long-term trend with negative momentum.";
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
      reason = "RSI indicates strongly overbought conditions.";
    } else if (rsi < 20) {
      direction = "BULLISH";
      confidence = "HIGH";
      reason = "RSI indicates strongly oversold conditions.";
    }
  }

  return {
    direction,
    confidence,
    reason,
  };
}

/* =======================================================
   ADVANCED CYCLE METRICS (NEW)
======================================================= */

async function getAdvancedMarketData(symbol = "BTCUSDT") {
  console.log("\n🧮 [Binance] Calculating advanced cycle metrics...");

  const klinesRes = await fetchWithTimeout(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1w&limit=1000`,
    {},
    15000,
  );
  if (!klinesRes.ok) {
    throw new Error(`Weekly klines HTTP ${klinesRes.status}`);
  }
  const klines = await klinesRes.json();

  const weekly = klines.map((c) => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5]),
  }));

  if (weekly.length < 200) {
    throw new Error("Insufficient weekly data.");
  }

  const closes = weekly.map((w) => w.close);

  // Calculate 50‑week SMA
  const sma50 = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < 49) {
      sma50.push(null);
      continue;
    }
    const window = closes.slice(i - 49, i + 1);
    sma50.push(window.reduce((a, b) => a + b, 0) / 50);
  }

  const currentPrice = closes[closes.length - 1];
  const currentSMA50 = sma50[sma50.length - 1];

  // Candle catalog: weekly >+20% while below 50W SMA
  const candleCatalog = [];
  for (let i = 1; i < weekly.length; i++) {
    const prevClose = weekly[i - 1].close;
    const currClose = weekly[i].close;
    const gain = (currClose - prevClose) / prevClose;
    const belowSMA = sma50[i] !== null && currClose < sma50[i];
    if (gain > 0.2 && belowSMA) {
      let futureLow = Infinity;
      for (let j = i + 1; j < weekly.length; j++) {
        if (weekly[j].low < futureLow) futureLow = weekly[j].low;
      }
      candleCatalog.push({
        date: new Date(weekly[i].time).toISOString().slice(0, 10),
        close: currClose,
        gainPercent: (gain * 100).toFixed(2),
        futureLow: futureLow === Infinity ? null : futureLow,
      });
    }
  }

  // Keep recent occurrences, but total count is important.
  const totalCandleCatalogCount = candleCatalog.length;
  const recentCandles = candleCatalog.slice(-5);

  // Cycle clock: days since last all-time high
  let peakIndex = 0;
  let peakPrice = -Infinity;
  for (let i = 0; i < weekly.length; i++) {
    if (weekly[i].high > peakPrice) {
      peakPrice = weekly[i].high;
      peakIndex = i;
    }
  }
  const peakDate = new Date(weekly[peakIndex].time);
  const daysSincePeak = Math.floor(
    (Date.now() - peakDate.getTime()) / 86400000,
  );

  // Historical bear market bottoms (approximate durations in days)
  const bearMarketDurations = [
    { name: "2013-2015", days: 410 },
    { name: "2017-2018", days: 364 },
    { name: "2021-2022", days: 406 },
  ];
  const bottomWindowStart = Math.min(...bearMarketDurations.map((b) => b.days));
  const bottomWindowEnd = Math.max(...bearMarketDurations.map((b) => b.days));

  // Critical level: 50‑week SMA (or could be previous swing low)
  const criticalLevel = currentSMA50;

  // Verdict window: based on historical bottom durations
  const verdictStart = new Date(
    peakDate.getTime() + bottomWindowStart * 86400000,
  );
  const verdictEnd = new Date(peakDate.getTime() + bottomWindowEnd * 86400000);
  const verdictWindow = `${verdictStart.toISOString().slice(0, 10)}..${verdictEnd.toISOString().slice(0, 10)}`;

  return {
    currentPrice,
    currentSMA50,
    candleCatalog: recentCandles,
    totalCandleCatalogCount,
    peakPrice,
    peakDate: peakDate.toISOString().slice(0, 10),
    daysSincePeak,
    bottomWindow: `${bottomWindowStart}-${bottomWindowEnd}`,
    verdictWindow,
    criticalLevel,
  };
}

function buildTechnicalNarrative(metrics) {
  const {
    currentPrice,
    currentSMA50,
    candleCatalog,
    totalCandleCatalogCount,
    peakPrice,
    peakDate,
    daysSincePeak,
    bottomWindow,
    verdictWindow,
    criticalLevel,
  } = metrics;

  let candleCatalogText = "";
  if (candleCatalog.length > 0) {
    candleCatalogText = candleCatalog
      .map(
        (c) =>
          `${c.date} (close $${c.close.toFixed(0)}, +${c.gainPercent}%, future low $${c.futureLow.toFixed(0)})`,
      )
      .join(", ");
  } else {
    candleCatalogText = "none in recent history";
  }

  return `
CYCLE & STRUCTURAL DATA (${metrics.symbol || "BTC"}):
- Current price: $${currentPrice.toFixed(0)}
- 50-week SMA: $${currentSMA50.toFixed(0)}
- Candle catalog (weekly +20% candles below 50W, last 15y): ${totalCandleCatalogCount} occurrences. Recent ones: ${candleCatalogText}
- Last all-time high: $${peakPrice.toFixed(0)} on ${peakDate}
- Days since peak: ${daysSincePeak}
- Historical bear market bottoms occurred ${bottomWindow} days after peak.
- Verdict window: ${verdictWindow}
- Critical level: $${criticalLevel.toFixed(0)}
`;
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
        "User-Agent": "Mozilla/5.0 BinanceSquareAI/10.3",
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

      if (!title) {
        continue;
      }

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

  return {
    news,
    marketData,
  };
}

function getRandomTopic() {
  return TOPICS[Math.floor(Math.random() * TOPICS.length)];
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
        .slice(0, 250);

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
      enum: [
        "bitcoin",
        "ethereum",
        "bnb",
        "solana",
        "xrp",
        "market",
        "meme",
        "defi",
        "web3",
        "crypto",
      ],
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

    signal: {
      type: "string",
      enum: ["BULLISH", "BEARISH", "NEUTRAL", "NONE"],
    },

    signalConfidence: {
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
    "signal",
    "signalConfidence",
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
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(
        `   🧠 Groq generation attempt ${attempt}/${retries} using ${GROQ_MODEL}...`,
      );

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,

        messages: [
          {
            role: "system",
            content: `
You are an expert quantitative cryptocurrency analyst writing a short Binance Square post.

Return ONLY valid JSON matching the supplied JSON schema.

The response must be JSON.

Do not wrap JSON in markdown.
Do not add commentary outside the JSON.

Create useful, factual, engaging crypto content.
Never claim guaranteed profits.
Never invent that the author personally bought a coin.
Never fabricate news, partnerships, listings, prices, targets, or events.
Use only the market data and research supplied in the user message.

If market data is available, accurately reference it.
If research is available, accurately summarize it.
If information is uncertain, use cautious wording.

Keep the actual social-media content concise, readable, and engaging.
Use short paragraphs.
Use relevant hashtags.
Do not use excessive hashtags.
                `.trim(),
          },

          {
            role: "user",
            content: `
JSON OUTPUT REQUIRED.

${prompt}
                `.trim(),
          },
        ],

        temperature: 0.7,

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
      } catch (error) {
        throw new Error(`Groq returned invalid JSON: ${error.message}`);
      }

      return normalizeGeneratedPost(parsed);
    } catch (error) {
      lastError = error;

      console.warn(`   ⚠️ Groq attempt ${attempt} failed: ${error.message}`);

      if (attempt < retries) {
        await sleep(1200 * attempt);
      }
    }
  }

  throw lastError || new Error("Groq generation failed.");
}

function normalizeGeneratedPost(post) {
  const normalized = {
    title: String(post?.title || "Crypto Market Update")
      .trim()
      .slice(0, 120),

    topic: String(post?.topic || "crypto")
      .toLowerCase()
      .trim(),

    content: String(post?.content || "").trim(),

    qualityScore: Number.isFinite(Number(post?.qualityScore))
      ? Math.max(0, Math.min(10, Number(post.qualityScore)))
      : 7,

    newsUsed: Boolean(post?.newsUsed),

    catalystConfidence: String(
      post?.catalystConfidence || "NONE",
    ).toUpperCase(),

    signal: String(post?.signal || "NONE").toUpperCase(),

    signalConfidence: String(post?.signalConfidence || "NONE").toUpperCase(),

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
    "meme",
    "defi",
    "web3",
    "crypto",
  ]);

  if (!allowedTopics.has(normalized.topic)) {
    normalized.topic = "crypto";
  }

  const allowedConfidence = new Set(["LOW", "MEDIUM", "HIGH", "NONE"]);

  if (!allowedConfidence.has(normalized.catalystConfidence)) {
    normalized.catalystConfidence = "NONE";
  }

  const allowedSignals = new Set(["BULLISH", "BEARISH", "NEUTRAL", "NONE"]);

  if (!allowedSignals.has(normalized.signal)) {
    normalized.signal = "NONE";
  }

  if (!allowedConfidence.has(normalized.signalConfidence)) {
    normalized.signalConfidence = "NONE";
  }

  return normalized;
}

/* =======================================================
   HASHTAGS
======================================================= */

function ensureHashtags(content, topic = "crypto", tickerSymbol = "BTC") {
  let text = String(content || "").trim();

  text = text.replace(/#[a-zA-Z0-9_]+/g, "").trim();

  const cleanTicker = String(tickerSymbol || "BTC")
    .replace(/USDT$/i, "")
    .toUpperCase();

  if (cleanTicker && !text.includes(`$${cleanTicker}`)) {
    text = `$${cleanTicker} ${text}`;
  }

  const topicTag = String(topic || "crypto").replace(/[^a-zA-Z0-9]/g, "");

  const tags = [`#${cleanTicker}`, "#Crypto"];

  if (
    topicTag &&
    topicTag.toLowerCase() !== "crypto" &&
    topicTag.toLowerCase() !== cleanTicker.toLowerCase()
  ) {
    tags.push(`#${topicTag}`);
  }

  return `${text}\n\n${tags.join(" ")}`.trim();
}

/* =======================================================
   FALLBACK POST
======================================================= */

function buildFallbackPost(
  selectedTopic,
  fallbackTopic,
  ticker = "BTC",
  marketData = null,
) {
  const tick = String(ticker || "BTC")
    .replace(/USDT$/i, "")
    .toUpperCase();

  const price = marketData?.lastPrice;

  const priceText = Number.isFinite(price)
    ? `$${formatPrice(price)}`
    : "current levels";

  const change = Number.isFinite(marketData?.priceChangePercent)
    ? marketData.priceChangePercent
    : 0;

  const signal = marketData?.signal?.direction || "NEUTRAL";

  const reason = marketData?.signal?.reason || "Market conditions are mixed.";

  let content;

  if (selectedTopic) {
    content = `$${tick} is at ${priceText}, with a 24h move of ${change.toFixed(
      2,
    )}%. Current signal: ${signal}. ${reason} News angle: ${selectedTopic.title}.`;
  } else {
    content = `$${tick} is at ${priceText}, moving ${change.toFixed(
      2,
    )}% over 24h. Current signal: ${signal}. ${reason} Topic: ${fallbackTopic}.`;
  }

  return {
    title: `$${tick} Market Update`,

    topic: detectTopic(tick, fallbackTopic),

    content: ensureHashtags(content, "crypto", ticker),

    qualityScore: 7,

    newsUsed: Boolean(selectedTopic),

    catalystConfidence: selectedTopic ? "LOW" : "NONE",

    signal,

    signalConfidence: marketData?.signal?.confidence || "LOW",

    skip: false,

    skipReason: "",
  };
}

function detectTopic(ticker, fallbackTopic) {
  const normalized = String(ticker || "").toUpperCase();

  if (normalized === "BTC") {
    return "bitcoin";
  }

  if (normalized === "ETH") {
    return "ethereum";
  }

  if (normalized === "BNB") {
    return "bnb";
  }

  if (normalized === "SOL") {
    return "solana";
  }

  if (normalized === "XRP") {
    return "xrp";
  }

  if (MEME_COINS.includes(normalized)) {
    return "meme";
  }

  if (
    String(fallbackTopic || "")
      .toLowerCase()
      .includes("defi")
  ) {
    return "defi";
  }

  if (
    String(fallbackTopic || "")
      .toLowerCase()
      .includes("web3")
  ) {
    return "web3";
  }

  return "crypto";
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
   GENERATE POST (MODIFIED)
======================================================= */

async function generatePost(newsResearch, marketData) {
  const recentPosts = getRecentPostMemory();

  const selectedTopic = await selectTopic(newsResearch);

  const fallbackTopic = getRandomTopic();

  console.log("\n🎯 [Binance] Selected topic:");

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
Headline: ${selectedTopic.title}
Description: ${selectedTopic.description || ""}
Published: ${selectedTopic.publishedAt || ""}
Source: ${selectedTopic.source || "Unknown"}
`;
  }

  let marketBlock = "NO MARKET DATA AVAILABLE.";

  let ticker = "BTC";

  if (marketData) {
    const {
      symbol,
      baseAsset,
      lastPrice,
      priceChangePercent,
      volume,
      high,
      low,
      smaShort,
      smaLong,
      rsi,
      signal,
    } = marketData;

    ticker = symbol;

    marketBlock = `
Coin: ${symbol}
Asset: ${baseAsset}
Current price: $${formatPrice(lastPrice)}
24h change: ${priceChangePercent.toFixed(2)}%
24h volume: ${Number(volume || 0).toLocaleString()}
24h high: $${formatPrice(high)}
24h low: $${formatPrice(low)}
SMA ${SMA_SHORT}: ${Number.isFinite(smaShort) ? formatPrice(smaShort) : "N/A"}
SMA ${SMA_LONG}: ${Number.isFinite(smaLong) ? formatPrice(smaLong) : "N/A"}
RSI ${RSI_PERIOD}: ${Number.isFinite(rsi) ? rsi.toFixed(2) : "N/A"}
Signal: ${signal?.direction || "NEUTRAL"}
Signal confidence: ${signal?.confidence || "LOW"}
Signal reason: ${signal?.reason || "No clear signal."}
`;
  }

  // NEW: Fetch advanced cycle metrics for the selected symbol
  let advancedBlock = "NO ADVANCED CYCLE DATA AVAILABLE.";

  if (marketData) {
    try {
      const advanced = await getAdvancedMarketData(marketData.symbol);
      advancedBlock = buildTechnicalNarrative({
        ...advanced,
        symbol: marketData.symbol,
      });
    } catch (err) {
      console.warn("⚠️ Advanced metrics failed:", err.message);
    }
  }

  const prompt = `
Create a concise Binance Square crypto market post using the exact analytical style shown in the example below.

EXAMPLE POST STYLE:
"$BTC - Our own instruments just crossed. Candle catalog: four +20% weeks below the 50W in 15 years - Jan-2015, Dec-2018, Apr-2019, Jan-2023, each at a turn, the low behind never broke: 152, 3,122, 15,479 held. Cycle clock: day 321 off the peak, and completed bears bottomed days 364-406. Yesterday printed candle #5. Verdict window: Oct-05..Nov-16 - break 57,735 and the clock wins, hold it and the candle does."

YOUR TASK:
Write a post that follows this structure and tone:
- Begin with "$BTC" (or the actual ticker).
- State a significant technical observation (e.g., "Our own instruments just crossed" or similar).
- Mention the "candle catalog" with actual numbers: total count, dates, and prices if available.
- State the current "cycle clock" (days since peak) and the historical bottom window.
- If relevant, mention "Yesterday printed candle #X" (you can infer if a new +20% candle occurred).
- Provide a "verdict window" with a critical price level.
- End with a strong conclusion that ties the breakout/hold to the cycle outcome.

DATA PROVIDED:
${advancedBlock}

CURRENT MARKET DATA:
${marketBlock}

CURRENT WEB RESEARCH:
${researchBlock}

RECENT POSTS (for style reference only):
${recentPosts || "None"}

REQUIREMENTS:
- Use ONLY the data provided. Do not invent numbers.
- Keep the total content under 700 characters.
- The post must sound like a quantitative analyst, not a generic news bot.
- Use the ticker and relevant hashtags (2-3 max).
- Set newsUsed to true only if web research is actually used; otherwise false.
- Set signal and signalConfidence from the market signal data.
- If there is insufficient information, set skip=true.

Return valid JSON only.
`;

  try {
    const post = await callGeneration(prompt, GENERATION_MAX_TOKENS, 3);

    post.content = ensureHashtags(post.content, post.topic, ticker);

    return post;
  } catch (error) {
    console.error("⚠️ Groq generation failed:", error.message);

    console.log("↪️ Building fallback post.");

    return buildFallbackPost(selectedTopic, fallbackTopic, ticker, marketData);
  }
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

  if (content.length < 60) {
    reasons.push("post is too short");
  }

  if (content.length > 5000) {
    reasons.push("post is too long");
  }

  const lower = content.toLowerCase();

  const forbidden = [
    "guaranteed profit",
    "guaranteed return",
    "risk free",
    "risk-free",
    "100% profit",
    "can't lose",
    "cannot lose",
    "easy money",
    "guaranteed gains",
    "no risk",
    "zero risk",
    "put $10 and get",
    "you will make",
    "you'll make",
    "definitely profit",
    "certain profit",
  ];

  for (const phrase of forbidden) {
    if (lower.includes(phrase)) {
      reasons.push(`forbidden phrase: ${phrase}`);
    }
  }

  const hashtags = content.match(/#[a-zA-Z0-9_]+/g) || [];

  if (hashtags.length < 2) {
    reasons.push(`hashtags count: ${hashtags.length}`);
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

function isDuplicate(post) {
  if (!post?.content) {
    return {
      duplicate: false,
      score: 0,
    };
  }

  const current = normalizeForDuplicate(post.content);

  if (!current) {
    return {
      duplicate: false,
      score: 0,
    };
  }

  const recent = state.history.slice(-20);

  let highestScore = 0;

  for (const item of recent) {
    const previous = normalizeForDuplicate(item?.text || "");

    if (!previous) {
      continue;
    }

    const score = similarityScore(current, previous);

    highestScore = Math.max(highestScore, score);

    if (score >= 0.82) {
      return {
        duplicate: true,
        score,
      };
    }
  }

  return {
    duplicate: false,
    score: highestScore,
  };
}

function normalizeForDuplicate(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/#[a-z0-9_]+/g, "")
    .replace(/[^a-z0-9\s$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarityScore(a, b) {
  if (!a || !b) {
    return 0;
  }

  if (a === b) {
    return 1;
  }

  const aWords = new Set(a.split(" ").filter(Boolean));

  const bWords = new Set(b.split(" ").filter(Boolean));

  if (aWords.size === 0 || bWords.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const word of aWords) {
    if (bWords.has(word)) {
      intersection++;
    }
  }

  const union = new Set([...aWords, ...bWords]).size;

  return union === 0 ? 0 : intersection / union;
}

/* =======================================================
   BINANCE SQUARE PUBLISHER
======================================================= */

function publishTextToSquare(content) {
  return new Promise((resolve, reject) => {
    console.log("\n📡 [Binance] Publishing text to Binance Square...");

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
          if (settled) {
            return;
          }

          settled = true;
          reject(error);
        };

        const finishResolve = (value) => {
          if (settled) {
            return;
          }

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

          finishResolve({
            success: true,
            dryRun: false,
            id,
            link,
            stdout,
          });
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

/* =======================================================
   SAVE POST
======================================================= */

async function savePost(post, result) {
  state.history.push({
    id: result?.id || null,

    title: post.title || null,

    topic: post.topic || "crypto",

    text: post.content || "",

    qualityScore: Number(post.qualityScore) || 0,

    newsUsed: Boolean(post.newsUsed),

    catalystConfidence: post.catalystConfidence || "NONE",

    signal: post.signal || null,

    signalConfidence: post.signalConfidence || null,

    publishedAt: new Date().toISOString(),

    dryRun: Boolean(result?.dryRun),
  });

  if (state.history.length > MAX_HISTORY) {
    state.history = state.history.slice(-MAX_HISTORY);
  }

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

async function runCycle() {
  resetDailyCounter();

  console.log("\n================================================");

  console.log("🚀 BINANCE SQUARE AI BOT V10.3.0");

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

    console.log("\n📝 Title:", post.title);

    console.log("📝 Topic:", post.topic);

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

    console.log("\n🛡️ Running validation...");

    const validation = validatePost(post);

    if (!validation.valid) {
      console.error("❌ Post rejected by validation.");

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

    console.log("   ✓ Validation passed.");

    const duplicate = isDuplicate(post);

    if (duplicate.duplicate) {
      console.log(
        `⏭️ Duplicate detected. Similarity: ${duplicate.score.toFixed(2)}`,
      );

      state.totalSkipped++;

      await saveState();

      return {
        success: false,
        skipped: true,
        reason: "duplicate",
        similarity: duplicate.score,
      };
    }

    console.log(
      `   ✓ Duplicate protection passed. Highest similarity: ${duplicate.score.toFixed(
        2,
      )}`,
    );

    console.log("\n📝 FINAL POST:");

    console.log("----------------------------------------");

    console.log(post.content);

    console.log("----------------------------------------");

    const result = await publishTextToSquare(post.content);

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

    return {
      success: true,
      id: result.id || null,
      link: result.link || null,
      dryRun: Boolean(result.dryRun),
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
   INITIALIZATION
======================================================= */

async function initializeBinanceBot() {
  if (initialized) {
    return;
  }

  console.log("\n==============================================");

  console.log("🤖 INITIALIZING BINANCE BOT");

  console.log("==============================================");

  await connectMongo();

  await loadState();

  console.log(`🧠 Provider: Groq (${GROQ_MODEL})`);

  console.log("🔥 Strategy: Quantitative Cycle + Market Analysis");

  console.log("🌐 Web research: Google News RSS");

  console.log("📊 Market data: Binance real-time");

  console.log(
    "📈 Advanced cycle metrics: Weekly SMA50, Candle Catalog, Cycle Clock",
  );

  console.log(`💾 Trending topic storage: MongoDB (${MONGODB_DB_NAME})`);

  console.log("🛡️ Validation: ENABLED");

  console.log("🎨 Image generation: DISABLED");

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`);

  console.log(`❓ Topic pool: ${TOPICS.length}`);

  initialized = true;

  console.log("✅ Binance bot initialized.");
}

/* =======================================================
   EXTERNAL ENTRY POINT
======================================================= */

async function runBinanceBot() {
  await initializeBinanceBot();

  return await safeRunCycle();
}

/* =======================================================
   STATUS
======================================================= */

function getBinanceStatus() {
  resetDailyCounter();

  return {
    service: "binance-square-ai-bot",

    version: "10.3.0",

    provider: "Groq",

    model: GROQ_MODEL,

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

    imageGeneration: "Disabled",

    imageModel: "None",

    advancedMetrics: "Enabled",
  };
}

/* =======================================================
   SHUTDOWN
======================================================= */

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

/* =======================================================
   EXPORTS
======================================================= */

export {
  runBinanceBot,
  safeRunCycle,
  runCycle,
  initializeBinanceBot,
  getBinanceStatus,
  shutdownBinanceBot,
  POST_TRIGGER_SECRET,
};
