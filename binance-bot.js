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
BINANCE SQUARE AI BOT V11.0.0
MULTI-COIN MARKET ANALYSIS
NATURAL BINANCE SQUARE CONTENT
=========================================================

REAL-WORLD CHANGES:

1. No longer BTC-only.
2. Rotates across multiple crypto assets.
3. Binance REST market data is NOT used for analysis.
   This avoids HTTP 451 geo/restriction failures.
4. CoinGecko is used for public market data.
5. Technical analysis works across supported coins.
6. AI receives real price, momentum, RSI, SMA,
   drawdown, ATH, volume and market-cap information.
7. AI writes natural market commentary instead of
   rigid quantitative-cycle posts.
8. Strong bullish/bearish reasoning is required.
9. Posts can discuss:
   - pumps
   - pullbacks
   - momentum
   - resistance
   - support
   - overbought/oversold
   - chasing risk
   - possible continuation
   - possible reversal
   - news catalysts
   - liquidations when evidence supports it
10. If market data fails, the bot DOES NOT publish.
11. Duplicate protection remains enabled.
12. MongoDB trending topics remain enabled.
13. Binance Square publishing remains enabled.
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

/*
=========================================================
COINGECKO
=========================================================
*/

const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

/*
=========================================================
BINANCE SQUARE PUBLISHER
=========================================================
*/

const SQUARE_TEXT_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-text.mjs",
);

/*
=========================================================
SUPPORTED COINS
=========================================================

The bot rotates through these instead of forcing BTC.

You can add more CoinGecko IDs here.
=========================================================
*/

const COIN_POOL = [
  {
    id: "bitcoin",
    symbol: "BTC",
    name: "Bitcoin",
  },
  {
    id: "ethereum",
    symbol: "ETH",
    name: "Ethereum",
  },
  {
    id: "solana",
    symbol: "SOL",
    name: "Solana",
  },
  {
    id: "binancecoin",
    symbol: "BNB",
    name: "BNB",
  },
  {
    id: "xrp",
    symbol: "XRP",
    name: "XRP",
  },
  {
    id: "dogecoin",
    symbol: "DOGE",
    name: "Dogecoin",
  },
  {
    id: "shiba-inu",
    symbol: "SHIB",
    name: "Shiba Inu",
  },
  {
    id: "pepe",
    symbol: "PEPE",
    name: "PEPE",
  },
  {
    id: "official-trump",
    symbol: "TRUMP",
    name: "Official Trump",
  },
  {
    id: "bonk",
    symbol: "BONK",
    name: "Bonk",
  },
  {
    id: "dogwifcoin",
    symbol: "WIF",
    name: "dogwifhat",
  },
  {
    id: "floki",
    symbol: "FLOKI",
    name: "FLOKI",
  },
];

/*
=========================================================
NEWS
=========================================================
*/

const GOOGLE_NEWS_URL =
  "https://news.google.com/rss/search?q=" +
  encodeURIComponent(
    "crypto OR bitcoin OR ethereum OR binance OR solana OR XRP OR PEPE OR SHIB OR DOGE OR TRUMP OR altcoin",
  ) +
  "&hl=en-US&gl=US&ceid=US:en";

/*
=========================================================
TECHNICAL SETTINGS
=========================================================
*/

const SMA_SHORT = 9;
const SMA_LONG = 21;
const SMA_MEDIUM = 50;
const RSI_PERIOD = 14;

/*
=========================================================
VALIDATION
=========================================================
*/

if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing.");

if (!BINANCE_SQUARE_OPENAPI_KEY)
  throw new Error("BINANCE_SQUARE_OPENAPI_KEY is missing.");

if (!POST_TRIGGER_SECRET) throw new Error("POST_TRIGGER_SECRET is missing.");

if (!MONGODB_URI) throw new Error("MONGODB_URI is missing.");

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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function shuffleArray(array) {
  const copy = [...array];

  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function formatPrice(price) {
  if (!Number.isFinite(Number(price))) return "N/A";

  const value = Number(price);

  if (value >= 1000) {
    return value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  if (value >= 1) return value.toFixed(4);

  if (value >= 0.01) return value.toFixed(6);

  return value.toFixed(10);
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return "N/A";

  const number = Number(value);

  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

function formatLargeNumber(value) {
  if (!Number.isFinite(Number(value))) return "N/A";

  const number = Number(value);

  if (number >= 1_000_000_000_000)
    return `${(number / 1_000_000_000_000).toFixed(2)}T`;

  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`;

  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;

  if (number >= 1_000) return `${(number / 1_000).toFixed(2)}K`;

  return number.toFixed(2);
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
    if (mongoClient) await mongoClient.close();

    mongoClient = null;
    db = null;
    trendingTopicsCollection = null;
    postHistoryCollection = null;

    console.log("💾 [Binance] MongoDB connection closed.");
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

  if (!operations.length) return;

  try {
    const result = await trendingTopicsCollection.bulkWrite(operations, {
      ordered: false,
    });

    console.log(
      `   💾 Trending topics stored: ${
        result.upsertedCount || 0
      } new / ${newsItems.length} processed.`,
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
  if (!trendingTopicsCollection) return;

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
  if (!postHistoryCollection) return;

  try {
    await postHistoryCollection.insertOne({
      id: result?.id || null,
      title: post.title || null,
      topic: post.topic || "crypto",
      symbol: post.symbol || null,
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
    console.warn("⚠️ Storing post history failed:", error.message);
  }
}

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
    lastCoin: null,
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
    console.log(`📅 New local day detected: ${today}`);

    state.date = today;
    state.postsToday = 0;

    saveState().catch((error) =>
      console.error("⚠️ Daily reset save failed:", error.message),
    );
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

/* =======================================================
   TECHNICAL ANALYSIS
======================================================= */

function movingAverage(data, period) {
  const result = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    const window = data.slice(i - period + 1, i + 1);

    result.push(window.reduce((a, b) => a + b, 0) / period);
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

function calculateDrawdown(currentPrice, ath) {
  if (!Number.isFinite(currentPrice) || !Number.isFinite(ath) || ath <= 0) {
    return null;
  }

  return ((currentPrice - ath) / ath) * 100;
}

function calculateRecentHigh(candles, count = 20) {
  const recent = candles.slice(-count);

  if (!recent.length) return null;

  return Math.max(...recent.map((item) => item.high));
}

function calculateRecentLow(candles, count = 20) {
  const recent = candles.slice(-count);

  if (!recent.length) return null;

  return Math.min(...recent.map((item) => item.low));
}

function detectCandleMomentum(candles) {
  if (!Array.isArray(candles) || candles.length < 3) {
    return {
      direction: "UNKNOWN",
      description: "Not enough candle data.",
    };
  }

  const recent = candles.slice(-3);

  const changes = recent.map(
    (candle) => ((candle.close - candle.open) / candle.open) * 100,
  );

  const positive = changes.filter((x) => x > 0).length;

  const negative = changes.filter((x) => x < 0).length;

  if (positive >= 2 && positive > negative) {
    return {
      direction: "BULLISH",
      description: "Recent candles show improving upward momentum.",
    };
  }

  if (negative >= 2 && negative > positive) {
    return {
      direction: "BEARISH",
      description: "Recent candles show increasing downside pressure.",
    };
  }

  return {
    direction: "MIXED",
    description:
      "Recent candles are mixed without a clean directional pattern.",
  };
}

function generateSignal(metrics) {
  const { rsi, sma9, sma21, sma50, price, change24h, change7d, change30d } =
    metrics;

  let bullishScore = 0;
  let bearishScore = 0;

  const reasonsBullish = [];
  const reasonsBearish = [];

  if (Number.isFinite(sma9) && Number.isFinite(sma21)) {
    if (sma9 > sma21) {
      bullishScore += 2;

      reasonsBullish.push("short-term trend is above the 21-period trend");
    } else {
      bearishScore += 2;

      reasonsBearish.push("short-term trend is below the 21-period trend");
    }
  }

  if (Number.isFinite(sma21) && Number.isFinite(sma50)) {
    if (sma21 > sma50) {
      bullishScore += 2;

      reasonsBullish.push(
        "medium-term trend remains above the 50-period trend",
      );
    } else {
      bearishScore += 2;

      reasonsBearish.push(
        "medium-term trend remains below the 50-period trend",
      );
    }
  }

  if (Number.isFinite(rsi)) {
    if (rsi >= 70) {
      bearishScore += 1;

      reasonsBearish.push("RSI is entering overbought territory");
    } else if (rsi <= 30) {
      bullishScore += 1;

      reasonsBullish.push("RSI is entering oversold territory");
    } else if (rsi >= 55) {
      bullishScore += 1;

      reasonsBullish.push("RSI still shows positive momentum");
    } else if (rsi <= 45) {
      bearishScore += 1;

      reasonsBearish.push("RSI shows weakening momentum");
    }
  }

  if (Number.isFinite(change24h)) {
    if (change24h > 3) {
      bullishScore += 1;

      reasonsBullish.push("the 24h move is strongly positive");
    }

    if (change24h < -3) {
      bearishScore += 1;

      reasonsBearish.push("the 24h move is under strong selling pressure");
    }
  }

  if (Number.isFinite(change7d)) {
    if (change7d > 8) {
      bullishScore += 2;

      reasonsBullish.push("weekly momentum is strong");
    }

    if (change7d < -8) {
      bearishScore += 2;

      reasonsBearish.push("weekly momentum is weak");
    }
  }

  if (Number.isFinite(price) && Number.isFinite(sma21)) {
    if (price > sma21) {
      bullishScore += 1;
    } else {
      bearishScore += 1;
    }
  }

  let direction = "NEUTRAL";

  if (bullishScore >= bearishScore + 3) {
    direction = "BULLISH";
  } else if (bearishScore >= bullishScore + 3) {
    direction = "BEARISH";
  }

  const total = bullishScore + bearishScore;

  const confidence = total >= 9 ? "HIGH" : total >= 6 ? "MEDIUM" : "LOW";

  let reason = "Signals are mixed.";

  if (direction === "BULLISH") {
    reason = reasonsBullish.slice(0, 3).join("; ");
  }

  if (direction === "BEARISH") {
    reason = reasonsBearish.slice(0, 3).join("; ");
  }

  return {
    direction,
    confidence,
    bullishScore,
    bearishScore,
    reason,
    bullishReasons: reasonsBullish,
    bearishReasons: reasonsBearish,
  };
}

/* =======================================================
   COINGECKO MARKET DATA
======================================================= */

async function getCoinMarketData(coin) {
  console.log(`\n📊 [Market] Fetching ${coin.symbol} market data...`);

  const url =
    `${COINGECKO_BASE_URL}/coins/${coin.id}` +
    `?localization=false` +
    `&tickers=false` +
    `&market_data=true` +
    `&community_data=false` +
    `&developer_data=false` +
    `&sparkline=false`;

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "BinanceSquareAI/11.0.0",
      },
    },
    15000,
  );

  if (!response.ok) {
    throw new Error(`CoinGecko market HTTP ${response.status}`);
  }

  const data = await response.json();

  const market = data?.market_data;

  if (!market) {
    throw new Error("CoinGecko returned no market_data.");
  }

  return {
    id: coin.id,
    symbol: String(market.symbol || coin.symbol).toUpperCase(),
    name: market.name || coin.name,

    price: Number(market.current_price?.usd),

    marketCap: Number(market.market_cap?.usd),

    volume24h: Number(market.total_volume?.usd),

    high24h: Number(market.high_24h?.usd),

    low24h: Number(market.low_24h?.usd),

    change24h: Number(market.price_change_percentage_24h),

    change7d: Number(market.price_change_percentage_7d),

    change14d: Number(market.price_change_percentage_14d),

    change30d: Number(market.price_change_percentage_30d),

    change1y: Number(market.price_change_percentage_1y),

    ath: Number(market.ath?.usd),

    athChange: Number(market.ath_change_percentage?.usd),

    athDate: market.ath_date?.usd || null,

    circulatingSupply: Number(market.circulating_supply),

    totalSupply: Number(market.total_supply),

    maxSupply: Number(market.max_supply),
  };
}

/* =======================================================
   COIN CANDLES
======================================================= */

async function getCoinCandles(coin) {
  const url =
    `${COINGECKO_BASE_URL}/coins/${coin.id}/market_chart` +
    `?vs_currency=usd&days=365&interval=daily`;

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "BinanceSquareAI/11.0.0",
      },
    },
    15000,
  );

  if (!response.ok) {
    throw new Error(`CoinGecko chart HTTP ${response.status}`);
  }

  const data = await response.json();

  const prices = Array.isArray(data?.prices) ? data.prices : [];

  if (prices.length < 60) {
    throw new Error("Insufficient historical candle data.");
  }

  /*
  CoinGecko free market_chart gives
  timestamp + price.

  We construct daily close-like candles
  from the available price series.
  */

  const candles = prices.map(([time, price]) => ({
    time,
    open: Number(price),
    high: Number(price),
    low: Number(price),
    close: Number(price),
  }));

  return candles.filter((candle) => Number.isFinite(candle.close));
}

/* =======================================================
   COMPLETE MARKET ANALYSIS
======================================================= */

async function getMarketData(coin) {
  const market = await getCoinMarketData(coin);

  const candles = await getCoinCandles(coin);

  const closes = candles.map((candle) => candle.close);

  const sma9 = movingAverage(closes, SMA_SHORT).at(-1);

  const sma21 = movingAverage(closes, SMA_LONG).at(-1);

  const sma50 = movingAverage(closes, SMA_MEDIUM).at(-1);

  const rsi = computeRSI(closes, RSI_PERIOD).at(-1);

  const recentHigh = calculateRecentHigh(candles, 30);

  const recentLow = calculateRecentLow(candles, 30);

  const momentum = detectCandleMomentum(candles);

  const drawdown = calculateDrawdown(market.price, market.ath);

  const signal = generateSignal({
    rsi,
    sma9,
    sma21,
    sma50,
    price: market.price,
    change24h: market.change24h,
    change7d: market.change7d,
    change30d: market.change30d,
  });

  /*
  Detect unusually large daily moves.
  This is used for natural language such as:
  "the recent candles are getting aggressive"
  rather than falsely claiming liquidations.
  */

  const recentMoves = candles
    .slice(-14)
    .map((candle) => ((candle.close - candle.open) / candle.open) * 100);

  const largestRecentMove = recentMoves.length
    ? Math.max(...recentMoves.map((value) => Math.abs(value)))
    : null;

  const pumpDetected =
    Number.isFinite(largestRecentMove) && largestRecentMove >= 15;

  /*
  Price position within recent range.
  */

  let rangePosition = "UNKNOWN";

  if (
    Number.isFinite(recentHigh) &&
    Number.isFinite(recentLow) &&
    recentHigh > recentLow
  ) {
    const position =
      ((market.price - recentLow) / (recentHigh - recentLow)) * 100;

    if (position >= 80) rangePosition = "NEAR_RECENT_HIGH";
    else if (position <= 20) rangePosition = "NEAR_RECENT_LOW";
    else rangePosition = "MID_RANGE";
  }

  console.log(`   ✅ ${market.symbol} $${formatPrice(market.price)}`);

  console.log(
    `   📈 24h: ${formatPercent(market.change24h)} | 7d: ${formatPercent(
      market.change7d,
    )} | 30d: ${formatPercent(market.change30d)}`,
  );

  console.log(
    `   📊 RSI: ${Number.isFinite(rsi) ? rsi.toFixed(2) : "N/A"} | Signal: ${
      signal.direction
    } (${signal.confidence})`,
  );

  return {
    ...market,

    candles,

    sma9,
    sma21,
    sma50,

    rsi,

    recentHigh,
    recentLow,

    drawdown,

    momentum,

    largestRecentMove,
    pumpDetected,

    rangePosition,

    signal,
  };
}

/* =======================================================
   NEWS RESEARCH
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

async function researchWeb() {
  console.log("\n🌐 [News] Searching Google News RSS...");

  let news = [];

  try {
    const response = await fetchWithTimeout(
      GOOGLE_NEWS_URL,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 BinanceSquareAI/11.0.0",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
      },
      15000,
    );

    if (!response.ok) {
      throw new Error(`Google News HTTP ${response.status}`);
    }

    const xml = await response.text();

    if (!xml || xml.length < 100) {
      throw new Error("Google News returned empty response.");
    }

    const items = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

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

    if (!news.length) throw new Error("RSS contained no usable articles.");

    shuffleArray(news);

    console.log(`   ✅ ${news.length} fresh news items found.`);

    await storeTrendingTopics(news);
  } catch (error) {
    console.warn(`   ⚠️ News research failed: ${error.message}`);

    news = [];
  }

  return news;
}

/* =======================================================
   COIN SELECTION
======================================================= */

function getRecentCoins() {
  return state.history
    .slice(-5)
    .map((item) => String(item.symbol || "").toUpperCase())
    .filter(Boolean);
}

function selectCoin() {
  const recent = getRecentCoins();

  const available = COIN_POOL.filter((coin) => !recent.includes(coin.symbol));

  const pool = available.length ? available : COIN_POOL;

  const selected = pool[Math.floor(Math.random() * pool.length)];

  return selected;
}

/* =======================================================
   NEWS MATCHING
======================================================= */

function findRelevantNews(news, marketData) {
  if (!Array.isArray(news) || !news.length) {
    return null;
  }

  const symbol = String(marketData.symbol || "").toLowerCase();

  const name = String(marketData.name || "").toLowerCase();

  const aliases = new Set([symbol, name]);

  if (symbol === "btc") {
    aliases.add("bitcoin");
  }

  if (symbol === "eth") {
    aliases.add("ethereum");
    aliases.add("ether");
  }

  if (symbol === "doge") {
    aliases.add("dogecoin");
  }

  if (symbol === "sol") {
    aliases.add("solana");
  }

  if (symbol === "bnb") {
    aliases.add("binance");
  }

  if (symbol === "xrp") {
    aliases.add("ripple");
  }

  const relevant = news.filter((item) => {
    const text = `${item.title} ${item.description}`.toLowerCase();

    return [...aliases].some((alias) => alias && text.includes(alias));
  });

  if (relevant.length) {
    return relevant[Math.floor(Math.random() * relevant.length)];
  }

  return null;
}

/* =======================================================
   RECENT POST MEMORY
======================================================= */

function getRecentPostMemory() {
  return state.history
    .slice(-10)
    .map((post) => {
      const symbol = String(post.symbol || "").toUpperCase();

      const text = String(post.text || "")
        .replace(/\s+/g, " ")
        .slice(0, 350);

      return `$${symbol}: ${text}`;
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
        "meme",
        "defi",
        "web3",
        "market",
        "crypto",
      ],
    },

    symbol: {
      type: "string",
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
    "symbol",
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
You are a highly experienced cryptocurrency market analyst and Binance Square creator.

Your job is NOT to write generic AI crypto posts.

You write natural, human-sounding market commentary similar to successful Binance Square creators.

The post should feel like a real trader/analyst looked at the chart and is explaining what is happening.

IMPORTANT:

- Never invent prices.
- Never invent partnerships.
- Never invent liquidations.
- Never invent whale activity.
- Never invent insider selling.
- Never invent news.
- Never claim certainty.
- Never promise profits.
- Never say a coin "will definitely pump".
- Never say a coin "will definitely dump".
- Never fabricate personal holdings.
- Never pretend the author bought or sold a coin.
- Use only supplied market data and research.

The goal is to explain:

1. What the coin has been doing.
2. Whether momentum is bullish, bearish or mixed.
3. What changed recently.
4. What could happen next if current conditions continue.
5. What would invalidate the bullish/bearish view.
6. Whether chasing the current move looks risky.
7. If news exists, explain how it could act as a catalyst.

Write naturally.

Avoid robotic phrases like:

"According to the data..."
"Based on the provided information..."
"As an AI..."
"Technical indicators suggest..."

Instead write like:

"$TRUMP is moving again 👀"

or:

"$PEPE has been getting interesting."

or:

"Looking at $BTC right now, I would not chase this move."

The tone can be conversational, confident and analytical.

Use paragraphs.

Use occasional emojis, but do not overuse them.

The post should generally be 400-900 characters.

2-4 hashtags maximum.

Return ONLY valid JSON.
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

        temperature: 0.8,

        max_completion_tokens: maxTokens,

        reasoning_effort: "low",

        reasoning_format: "hidden",

        response_format: {
          type: "json_schema",

          json_schema: {
            name: "binance_square_market_post",

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

    symbol: String(post?.symbol || "")
      .trim()
      .toUpperCase(),

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
    "meme",
    "defi",
    "web3",
    "market",
    "crypto",
  ]);

  if (!allowedTopics.has(normalized.topic)) {
    normalized.topic = "crypto";
  }

  const confidence = new Set(["LOW", "MEDIUM", "HIGH", "NONE"]);

  if (!confidence.has(normalized.catalystConfidence)) {
    normalized.catalystConfidence = "NONE";
  }

  const signals = new Set(["BULLISH", "BEARISH", "NEUTRAL", "NONE"]);

  if (!signals.has(normalized.signal)) {
    normalized.signal = "NONE";
  }

  if (!confidence.has(normalized.signalConfidence)) {
    normalized.signalConfidence = "NONE";
  }

  return normalized;
}

/* =======================================================
   HASHTAGS
======================================================= */

function ensureHashtags(content, symbol, topic) {
  let text = String(content || "").trim();

  /*
  Remove AI-generated hashtags first.
  We add our own controlled set.
  */

  text = text.replace(/#[a-zA-Z0-9_]+/g, "");

  text = text.replace(/\n{3,}/g, "\n\n").trim();

  const cleanSymbol = String(symbol || "")
    .replace(/USDT$/i, "")
    .toUpperCase();

  if (cleanSymbol && !text.includes(`$${cleanSymbol}`)) {
    text = `$${cleanSymbol} ${text}`;
  }

  const tags = [];

  if (cleanSymbol) {
    tags.push(`#${cleanSymbol}`);
  }

  tags.push("#Crypto");

  const normalizedTopic = String(topic || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();

  if (
    normalizedTopic &&
    normalizedTopic !== "crypto" &&
    normalizedTopic !== cleanSymbol.toLowerCase()
  ) {
    tags.push(`#${normalizedTopic}`);
  }

  return `${text}\n\n${tags.slice(0, 3).join(" ")}`.trim();
}

/* =======================================================
   GENERATE NATURAL POST
======================================================= */

async function generatePost(marketData, news) {
  const recentPosts = getRecentPostMemory();

  const relevantNews = findRelevantNews(news, marketData);

  const signal = marketData.signal;

  const researchBlock = relevantNews
    ? `
RELEVANT NEWS:

Headline:
${relevantNews.title}

Description:
${relevantNews.description || "None"}

Published:
${relevantNews.publishedAt || "Unknown"}

Source:
${relevantNews.source || "Unknown"}
`
    : `
NO DIRECTLY RELEVANT NEWS WAS FOUND FOR THIS COIN.

Do NOT pretend that general crypto news is specifically about this coin.
`;

  const marketBlock = `
COIN:
${marketData.name}

SYMBOL:
$${marketData.symbol}

CURRENT PRICE:
$${formatPrice(marketData.price)}

24H CHANGE:
${formatPercent(marketData.change24h)}

7D CHANGE:
${formatPercent(marketData.change7d)}

14D CHANGE:
${formatPercent(marketData.change14d)}

30D CHANGE:
${formatPercent(marketData.change30d)}

1Y CHANGE:
${formatPercent(marketData.change1y)}

24H HIGH:
$${formatPrice(marketData.high24h)}

24H LOW:
$${formatPrice(marketData.low24h)}

24H VOLUME:
$${formatLargeNumber(marketData.volume24h)}

MARKET CAP:
$${formatLargeNumber(marketData.marketCap)}

ALL-TIME HIGH:
$${formatPrice(marketData.ath)}

DISTANCE FROM ATH:
${formatPercent(marketData.athChange)}

30-DAY RECENT HIGH:
$${formatPrice(marketData.recentHigh)}

30-DAY RECENT LOW:
$${formatPrice(marketData.recentLow)}

PRICE POSITION:
${marketData.rangePosition}

SMA 9:
$${formatPrice(marketData.sma9)}

SMA 21:
$${formatPrice(marketData.sma21)}

SMA 50:
$${formatPrice(marketData.sma50)}

RSI 14:
${Number.isFinite(marketData.rsi) ? marketData.rsi.toFixed(2) : "N/A"}

RECENT CANDLE MOMENTUM:
${marketData.momentum.direction}

RECENT CANDLE DESCRIPTION:
${marketData.momentum.description}

LARGEST RECENT DAILY MOVE:
${
  Number.isFinite(marketData.largestRecentMove)
    ? `${marketData.largestRecentMove.toFixed(2)}%`
    : "N/A"
}

LARGE MOVE DETECTED:
${marketData.pumpDetected ? "YES" : "NO"}

TECHNICAL SIGNAL:
${signal.direction}

SIGNAL CONFIDENCE:
${signal.confidence}

BULLISH REASONS:
${signal.bullishReasons.join("; ")}

BEARISH REASONS:
${signal.bearishReasons.join("; ")}

PRIMARY SIGNAL REASON:
${signal.reason}
`;

  const prompt = `
Create ONE Binance Square post about $${marketData.symbol}.

The goal is to sound like a real crypto trader/analyst explaining what is happening.

STYLE REFERENCE:

"$TRUMP is moving again 👀

The token has jumped around 75% in a week, climbing from $1.39 to about $2.43 despite reports that insiders sold roughly $3.4M during the rally.

That’s a serious move, but I wouldn’t chase it blindly. After touching $3.28, $TRUMP has already pulled back hard.

Momentum is strong. Risk is too. Let’s see if buyers can reclaim the highs. 📈"

Your post should follow this type of structure:

HOOK:
Start directly with the coin.

Example:
"$PEPE is getting interesting 👀"

or:

"$DOGE has started showing some serious momentum."

or:

"Looking at $BTC right now, I would not chase this move."

THEN:

Explain what actually changed.

Use the real percentage moves supplied above.

Mention price when useful.

Explain whether the move looks bullish, bearish or mixed.

Then give the reader a clear interpretation.

For example:

- momentum is strong but price may be stretched
- buyers are gaining control
- sellers are starting to push back
- the coin is recovering from a deep drawdown
- the coin is near a recent high
- the coin has lost short-term momentum
- the current pump could continue if buyers hold the trend
- a rejection could send the price back toward recent support
- chasing after a large move carries higher reversal risk

IMPORTANT:

Do NOT invent support/resistance levels.

If discussing a level, only use the supplied recent high, recent low, current price, SMA values or other supplied numbers.

If the coin is strongly bullish, say WHY.

If it is bearish, say WHY.

If it is mixed, say that instead of forcing a prediction.

The conclusion should give a CONDITIONAL OUTLOOK.

Examples:

"Momentum is clearly bullish here, but I wouldn't chase a vertical move. If buyers keep price above the recent trend, another leg higher is possible. Lose that momentum and the pullback could get ugly."

or:

"I'd be careful here. The weekly move still looks weak, and unless buyers reclaim the short-term trend, another move lower would not surprise me."

or:

"This is the interesting part. The trend is improving, but the coin is already close to its recent highs. I'm watching whether buyers can actually break through rather than assuming the next pump is guaranteed."

NEWS:

Only use the news section if it is directly relevant to this coin.

If relevant news exists, connect it to the market move.

Do not copy the article.

Do not claim the news caused the price move unless the data clearly supports that conclusion.

Do not invent catalysts.

LIQUIDATIONS:

Only mention liquidations if actual liquidation information is supplied.

A large candle alone does NOT prove liquidations.

PERSONAL OPINION:

You may use natural phrases like:

"I wouldn't chase this move."

"I'm watching this one closely."

"I'd be careful here."

"I wouldn't be buying aggressively after a move like this."

But NEVER claim personal holdings or trades.

Do not say:
"My bags are up."

Do not say:
"I bought."

Do not say:
"I sold."

Do not pretend to be the user.

POST LENGTH:

Target approximately 450-900 characters before hashtags.

Do not exceed 1200 characters.

Do not make the post sound like a report.

Do not dump all indicators into the post.

Select the most interesting 2-4 facts.

The raw data is for your reasoning.

The final post should feel human.

CURRENT MARKET DATA:
${marketBlock}

NEWS:
${researchBlock}

RECENT POSTS:
${recentPosts || "None"}

FINAL REQUIREMENTS:

- Start with $${marketData.symbol}.
- Use actual supplied numbers.
- Clearly communicate bullish, bearish or mixed conditions.
- Give a conditional view of what could happen next.
- Mention risk when appropriate.
- Do not guarantee direction.
- Do not fabricate.
- Do not use more than 3 hashtags.
- Do not include markdown links.
- Do not create a title separate from the content.
- The content itself should be ready to publish.
`;

  const post = await callGeneration(prompt, GENERATION_MAX_TOKENS, 3);

  /*
  Force the actual analyzed coin.
  */

  post.symbol = marketData.symbol;

  /*
  Force the actual calculated signal.
  */

  post.signal = signal.direction;

  post.signalConfidence = signal.confidence;

  post.newsUsed = Boolean(relevantNews);

  post.content = ensureHashtags(post.content, marketData.symbol, post.topic);

  return post;
}

/* =======================================================
   VALIDATION
======================================================= */

function validatePost(post, marketData) {
  const reasons = [];

  if (!post) {
    return {
      valid: false,
      reasons: ["empty post"],
    };
  }

  if (!marketData) {
    reasons.push("market data unavailable");
  }

  const content = String(post.content || "").trim();

  if (content.length < 100) {
    reasons.push("post is too short");
  }

  if (content.length > 1500) {
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
    "definitely profit",
    "certain profit",
    "you will make",
    "you'll make",
    "guaranteed pump",
    "guaranteed dump",
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

  /*
  Make sure the post actually discusses
  the selected coin.
  */

  const symbol = `$${String(marketData?.symbol || "").toUpperCase()}`;

  if (symbol.length > 1 && !content.toUpperCase().includes(symbol)) {
    reasons.push("post does not mention selected coin");
  }

  /*
  Reject generic failure posts.
  */

  const failurePhrases = [
    "no market data",
    "data unavailable",
    "no cycle data",
    "unknown days since peak",
    "cannot confirm",
    "insufficient data",
    "cycle data unavailable",
  ];

  for (const phrase of failurePhrases) {
    if (lower.includes(phrase)) {
      reasons.push(`invalid fallback language: ${phrase}`);
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/* =======================================================
   DUPLICATE PROTECTION
======================================================= */

function normalizeForDuplicate(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/#[a-z0-9_]+/g, "")
    .replace(/[^a-z0-9\s$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarityScore(a, b) {
  if (!a || !b) return 0;

  if (a === b) return 1;

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

  const recent = state.history.slice(-30);

  let highestScore = 0;

  for (const item of recent) {
    const previous = normalizeForDuplicate(item?.text || "");

    if (!previous) continue;

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

/* =======================================================
   PUBLISH TO BINANCE SQUARE
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

async function savePost(post, result, marketData) {
  state.history.push({
    id: result?.id || null,

    title: post.title || null,

    topic: post.topic || "crypto",

    symbol: marketData?.symbol || post.symbol || null,

    text: post.content || "",

    qualityScore: Number(post.qualityScore) || 0,

    newsUsed: Boolean(post.newsUsed),

    catalystConfidence: post.catalystConfidence || "NONE",

    signal: post.signal || null,

    signalConfidence: post.signalConfidence || null,

    price: Number(marketData?.price) || null,

    change24h: Number(marketData?.change24h) || null,

    change7d: Number(marketData?.change7d) || null,

    change30d: Number(marketData?.change30d) || null,

    rsi: Number(marketData?.rsi) || null,

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

    state.lastCoin = marketData?.symbol || null;
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

  console.log("🚀 BINANCE SQUARE AI BOT V11.0.0");

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

  let selectedCoin = null;

  try {
    /*
    =====================================================
    1. SELECT COIN
    =====================================================
    */

    selectedCoin = selectCoin();

    console.log(
      `\n🎯 [Coin] Selected: $${selectedCoin.symbol} (${selectedCoin.name})`,
    );

    /*
    =====================================================
    2. FETCH MARKET DATA
    =====================================================
    */

    const marketData = await getMarketData(selectedCoin);

    /*
    NEVER continue without real data.
    */

    if (!marketData || !Number.isFinite(marketData.price)) {
      throw new Error("Market data incomplete. Publishing blocked.");
    }

    /*
    =====================================================
    3. NEWS
    =====================================================
    */

    const news = await researchWeb();

    console.log(`\n📰 Research items available: ${news.length}`);

    pruneStaleTopics().catch(() => {});

    /*
    =====================================================
    4. GENERATE POST
    =====================================================
    */

    const post = await generatePost(marketData, news);

    console.log("\n📝 Title:", post.title);

    console.log("🪙 Coin:", `$${marketData.symbol}`);

    console.log("⭐ Quality:", `${post.qualityScore}/10`);

    console.log("📰 Web research used:", post.newsUsed);

    console.log("🎯 Catalyst confidence:", post.catalystConfidence);

    console.log("📈 Signal:", post.signal, `(${post.signalConfidence})`);

    /*
    =====================================================
    5. AI SKIP
    =====================================================
    */

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
    =====================================================
    6. VALIDATION
    =====================================================
    */

    console.log("\n🛡️ Running validation...");

    const validation = validatePost(post, marketData);

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

    /*
    =====================================================
    7. DUPLICATE PROTECTION
    =====================================================
    */

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

    /*
    =====================================================
    8. FINAL POST
    =====================================================
    */

    console.log("\n📝 FINAL POST:");

    console.log("----------------------------------------");

    console.log(post.content);

    console.log("----------------------------------------");

    /*
    =====================================================
    9. PUBLISH
    =====================================================
    */

    const result = await publishTextToSquare(post.content);

    /*
    =====================================================
    10. SAVE
    =====================================================
    */

    await savePost(post, result, marketData);

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
      coin: marketData.symbol,
      signal: marketData.signal.direction,
    };
  } catch (error) {
    state.totalFailures++;

    await saveState();

    console.error("\n❌ Cycle error:");

    console.error(error?.stack || error?.message || error);

    return {
      success: false,
      error: error?.message || "Unknown error",
      coin: selectedCoin?.symbol || null,
    };
  }
}

/* =======================================================
   SAFE CYCLE
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
  if (initialized) return;

  console.log("\n==============================================");

  console.log("🤖 INITIALIZING BINANCE BOT");

  console.log("==============================================");

  await connectMongo();

  await loadState();

  console.log(`🧠 Provider: Groq (${GROQ_MODEL})`);

  console.log("🪙 Strategy: Multi-Coin Market Analysis");

  console.log(
    `🪙 Coin pool: ${COIN_POOL.map((coin) => coin.symbol).join(", ")}`,
  );

  console.log("📊 Market data: CoinGecko");

  console.log("📈 Analysis: SMA + RSI + Momentum + Drawdown + Range");

  console.log("🌐 Web research: Google News RSS");

  console.log(`💾 Trending topic storage: MongoDB (${MONGODB_DB_NAME})`);

  console.log("🛡️ Validation: ENABLED");

  console.log("🛡️ Duplicate protection: ENABLED");

  console.log("🎨 Image generation: DISABLED");

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`);

  console.log("🚫 Binance market REST API dependency: REMOVED");

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

    version: "11.0.0",

    provider: "Groq",

    model: GROQ_MODEL,

    marketDataProvider: "CoinGecko",

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

    lastCoin: state.lastCoin,

    cycleRunning,

    dryRun: DRY_RUN,

    mongoConnected: Boolean(mongoClient),

    imageGeneration: "Disabled",

    imageModel: "None",

    strategy: "Multi-Coin Natural Market Analysis",

    coins: COIN_POOL.map((coin) => coin.symbol),
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
