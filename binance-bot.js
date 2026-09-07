// ============================================================
// BINANCE SQUARE AI BOT V11.2.0
//
// API RESILIENCE EDITION
//
// FIXES:
// - Binance REST API endpoint fallback
// - Handles HTTP 418 IP bans
// - Handles HTTP 429 rate limits
// - Respects Retry-After
// - Endpoint-specific cooldowns
// - Exponential backoff
// - Handles Binance 403 WAF responses
// - Handles Binance 5xx responses
// - Handles network failures
// - Prevents hammering Binance after 418/429
// - One HTTP server only in index.js
// - Bot engine exports public functions
// - No server.listen() here
//
// CONTENT:
// - Mysterious market-data-driven title
// - Strong BUY/HOLD/SELL hook
// - Beginner-friendly A2-B1 English
// - 500-900 character target
// - Max 2 hashtags
// - Target/invalidation validation
// - Groq JSON normalization
// - Cloudflare image generation
// - Daily post limit
// - MongoDB history/state
// ============================================================

import Groq from "groq-sdk";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { MongoClient } from "mongodb";

dotenv.config();

// ============================================================
// PATHS
// ============================================================

const __filename = fileURLToPath(import.meta.url);

const __dirname = path.dirname(__filename);

const GENERATED_IMAGES_DIR = path.join(__dirname, "generated-images");

const STATE_FILE = path.join(__dirname, "bot-state.json");

const BACKUP_STATE_FILE = path.join(__dirname, "bot-state.backup.json");

const SQUARE_IMAGE_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-image.mjs",
);

// ============================================================
// ENVIRONMENT
// ============================================================

const {
  GROQ_API_KEY,

  GROQ_MODEL = "openai/gpt-oss-120b",

  BINANCE_SQUARE_OPENAPI_KEY,

  POST_TRIGGER_SECRET,

  MONGODB_URI,

  MONGODB_DB_NAME = "binance-square-bot",

  CLOUDFLARE_ACCOUNT_ID,

  CLOUDFLARE_API_TOKEN,

  CLOUDFLARE_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell",

  MAX_POSTS_PER_DAY = "8",

  MAX_HISTORY = "100",

  REQUEST_TIMEOUT_MS = "30000",

  GENERATION_MAX_TOKENS = "1200",

  DRY_RUN = "false",

  BOT_TIMEZONE = "Asia/Karachi",

  MIN_24H_VOLUME_USDT = "1000000",

  MAX_SCAN_COINS = "30",

  NEWS_ITEMS = "5",

  // Binance resilience settings

  BINANCE_MAX_ENDPOINT_ATTEMPTS = "6",

  BINANCE_MAX_RETRIES_PER_ENDPOINT = "2",

  BINANCE_BASE_BACKOFF_MS = "1500",

  BINANCE_MAX_BACKOFF_MS = "30000",

  BINANCE_DEFAULT_429_COOLDOWN_MS = "60000",

  BINANCE_DEFAULT_418_COOLDOWN_MS = "300000",

  BINANCE_DEFAULT_403_COOLDOWN_MS = "120000",

  BINANCE_DEFAULT_5XX_COOLDOWN_MS = "10000",

  BINANCE_ENDPOINT_TIMEOUT_MS = "20000",
} = process.env;

// ============================================================
// REQUIRED ENV
// ============================================================

const REQUIRED_ENV = [
  ["GROQ_API_KEY", GROQ_API_KEY],

  ["BINANCE_SQUARE_OPENAPI_KEY", BINANCE_SQUARE_OPENAPI_KEY],

  ["POST_TRIGGER_SECRET", POST_TRIGGER_SECRET],

  ["MONGODB_URI", MONGODB_URI],
];

for (const [name, value] of REQUIRED_ENV) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

// ============================================================
// CLIENTS
// ============================================================

const groq = new Groq({
  apiKey: GROQ_API_KEY,
});

let mongoClient = null;

let db = null;

// ============================================================
// CONSTANTS
// ============================================================

/*
 * Binance officially documents these Spot REST API
 * base endpoints.
 *
 * api1-api4 may have better performance but less stability.
 */
const BINANCE_API_ENDPOINTS = [
  "https://api.binance.com",

  "https://api-gcp.binance.com",

  "https://api1.binance.com",

  "https://api2.binance.com",

  "https://api3.binance.com",

  "https://api4.binance.com",
];

// Technical indicators

const SMA_SHORT = 9;

const SMA_LONG = 21;

const SMA_MEDIUM = 50;

const RSI_PERIOD = 14;

// Binance Square safety

const MAX_HASHTAGS = 2;

// Content target

const MIN_CONTENT_CHARS = 500;

const MAX_CONTENT_CHARS = 900;

// ============================================================
// BINANCE API RUNTIME STATE
// ============================================================

const binanceEndpointState = new Map();

for (const endpoint of BINANCE_API_ENDPOINTS) {
  binanceEndpointState.set(endpoint, {
    cooldownUntil: 0,

    failures: 0,

    lastStatus: null,

    lastError: null,

    lastUsedAt: null,

    totalRequests: 0,
  });
}

let preferredBinanceEndpointIndex = 0;

// Global cooldown is only used when Binance is
// clearly rate limiting the Render IP.
let binanceGlobalCooldownUntil = 0;

// ============================================================
// BOT STATE
// ============================================================

let state = {
  postsToday: 0,

  lastPostDate: null,

  lastCoin: null,

  lastPostAt: null,

  totalPosts: 0,

  totalFailures: 0,
};

// ============================================================
// UTILITY
// ============================================================

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function now() {
  return new Date();
}

function getDateKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BOT_TIMEZONE,
  }).format(new Date());
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function round(value, decimals = 4) {
  const number = safeNumber(value, 0);

  const multiplier = 10 ** decimals;

  return Math.round(number * multiplier) / multiplier;
}

function formatPercent(value) {
  const number = safeNumber(value);

  const absolute = Math.abs(number);

  if (absolute >= 100) {
    return number.toFixed(0);
  }

  if (absolute >= 10) {
    return number.toFixed(1);
  }

  return number.toFixed(2);
}

function formatPrice(price) {
  const number = safeNumber(price);

  if (number >= 1000) {
    return number.toFixed(0);
  }

  if (number >= 100) {
    return number.toFixed(2);
  }

  if (number >= 1) {
    return number.toFixed(3);
  }

  if (number >= 0.1) {
    return number.toFixed(4);
  }

  if (number >= 0.01) {
    return number.toFixed(5);
  }

  return number.toFixed(8);
}

// ============================================================
// GENERIC HTTP FETCH
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeout = Number(REQUEST_TIMEOUT_MS),
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

// ============================================================
// BINANCE RETRY HELPERS
// ============================================================

function parseRetryAfterMs(response, fallbackMs) {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return fallbackMs;
  }

  const numeric = Number(retryAfter);

  if (Number.isFinite(numeric) && numeric >= 0) {
    // Retry-After is normally seconds.
    return Math.max(1000, numeric * 1000);
  }

  const retryDate = Date.parse(retryAfter);

  if (Number.isFinite(retryDate)) {
    return Math.max(1000, retryDate - Date.now());
  }

  return fallbackMs;
}

function calculateBackoffMs(attempt) {
  const base = Number(BINANCE_BASE_BACKOFF_MS);

  const max = Number(BINANCE_MAX_BACKOFF_MS);

  const exponential = Math.min(max, base * 2 ** attempt);

  // Small jitter prevents synchronized retries.
  const jitter = Math.floor(Math.random() * Math.max(250, base));

  return Math.min(max, exponential + jitter);
}

function getEndpointState(endpoint) {
  return (
    binanceEndpointState.get(endpoint) || {
      cooldownUntil: 0,

      failures: 0,

      lastStatus: null,

      lastError: null,

      lastUsedAt: null,

      totalRequests: 0,
    }
  );
}

function setEndpointCooldown(endpoint, cooldownMs, reason) {
  const info = getEndpointState(endpoint);

  info.cooldownUntil = Date.now() + Math.max(1000, cooldownMs);

  info.lastError = reason;

  binanceEndpointState.set(endpoint, info);

  console.warn(`⏸️ Binance endpoint cooldown: ${endpoint}`);

  console.warn(`   Reason: ${reason}`);

  console.warn(`   Cooldown: ${Math.ceil(cooldownMs / 1000)}s`);
}

function isEndpointAvailable(endpoint) {
  const info = getEndpointState(endpoint);

  return Date.now() >= info.cooldownUntil;
}

function rotatePreferredEndpoint() {
  preferredBinanceEndpointIndex =
    (preferredBinanceEndpointIndex + 1) % BINANCE_API_ENDPOINTS.length;
}

function getOrderedBinanceEndpoints() {
  const endpoints = [];

  for (let i = 0; i < BINANCE_API_ENDPOINTS.length; i += 1) {
    const index =
      (preferredBinanceEndpointIndex + i) % BINANCE_API_ENDPOINTS.length;

    endpoints.push(BINANCE_API_ENDPOINTS[index]);
  }

  return endpoints;
}

function getEarliestEndpointCooldown() {
  let earliest = Infinity;

  for (const endpoint of BINANCE_API_ENDPOINTS) {
    const info = getEndpointState(endpoint);

    if (info.cooldownUntil < earliest) {
      earliest = info.cooldownUntil;
    }
  }

  return earliest;
}

// ============================================================
// BINANCE API ERROR
// ============================================================

class BinanceApiError extends Error {
  constructor(message, details = {}) {
    super(message);

    this.name = "BinanceApiError";

    Object.assign(this, details);
  }
}

// ============================================================
// BINANCE REQUEST
// ============================================================

async function requestBinance(apiPath, options = {}) {
  const endpoints = getOrderedBinanceEndpoints();

  const maxAttempts = Math.min(
    Number(BINANCE_MAX_ENDPOINT_ATTEMPTS) || endpoints.length,

    endpoints.length,
  );

  const maxRetriesPerEndpoint = Math.max(
    0,
    Number(BINANCE_MAX_RETRIES_PER_ENDPOINT) || 0,
  );

  // ----------------------------------------------------------
  // GLOBAL COOLDOWN
  // ----------------------------------------------------------

  if (Date.now() < binanceGlobalCooldownUntil) {
    const remaining = binanceGlobalCooldownUntil - Date.now();

    console.warn(
      `⏸️ Binance global cooldown active: ${Math.ceil(
        remaining / 1000,
      )}s remaining.`,
    );

    throw new BinanceApiError(
      `Binance API is rate limited. Global cooldown active for approximately ${Math.ceil(
        remaining / 1000,
      )} seconds.`,
      {
        status: 429,

        globalCooldown: true,

        retryAfterMs: remaining,

        path: apiPath,
      },
    );
  }

  let lastError = null;

  let attempted = 0;

  for (const endpoint of endpoints) {
    if (attempted >= maxAttempts) {
      break;
    }

    if (!isEndpointAvailable(endpoint)) {
      const info = getEndpointState(endpoint);

      console.log(
        `⏭️ Skipping cooled Binance endpoint: ${endpoint} (${Math.ceil(
          Math.max(0, info.cooldownUntil - Date.now()) / 1000,
        )}s)`,
      );

      continue;
    }

    attempted += 1;

    const url = `${endpoint}${apiPath}`;

    let retries = 0;

    while (retries <= maxRetriesPerEndpoint) {
      const info = getEndpointState(endpoint);

      info.totalRequests += 1;

      info.lastUsedAt = new Date().toISOString();

      binanceEndpointState.set(endpoint, info);

      try {
        console.log(`🌐 Binance request: ${url}`);

        const response = await fetchWithTimeout(
          url,
          {
            ...options,

            headers: {
              Accept: "application/json",

              "User-Agent": "BinanceSquareAIBot/11.2",

              ...(options.headers || {}),
            },
          },
          Number(BINANCE_ENDPOINT_TIMEOUT_MS),
        );

        // ------------------------------------------------------
        // SUCCESS
        // ------------------------------------------------------

        if (response.ok) {
          const data = await response.json();

          info.failures = 0;

          info.lastStatus = response.status;

          info.lastError = null;

          binanceEndpointState.set(endpoint, info);

          // Keep this endpoint preferred if it worked.
          const endpointIndex = BINANCE_API_ENDPOINTS.indexOf(endpoint);

          if (endpointIndex >= 0) {
            preferredBinanceEndpointIndex = endpointIndex;
          }

          console.log(`✅ Binance API success: ${endpoint}`);

          return data;
        }

        const status = response.status;

        info.lastStatus = status;

        let responseText = "";

        try {
          responseText = await response.text();
        } catch {
          responseText = "";
        }

        // ------------------------------------------------------
        // 418 - IP AUTO BAN
        // ------------------------------------------------------

        if (status === 418) {
          const cooldownMs = parseRetryAfterMs(
            response,
            Number(BINANCE_DEFAULT_418_COOLDOWN_MS),
          );

          info.failures += 1;

          info.lastError = responseText || "HTTP 418 IP auto-ban";

          binanceEndpointState.set(endpoint, info);

          setEndpointCooldown(
            endpoint,
            cooldownMs,
            `HTTP 418 - Binance IP auto-ban. ${
              responseText || "No response body."
            }`,
          );

          // Do NOT retry the same endpoint.
          // Move immediately to the next endpoint.
          rotatePreferredEndpoint();

          lastError = new BinanceApiError(
            `Binance returned HTTP 418 for ${endpoint}.`,
            {
              status,

              endpoint,

              responseText,

              retryAfterMs: cooldownMs,
            },
          );

          break;
        }

        // ------------------------------------------------------
        // 429 - RATE LIMIT
        // ------------------------------------------------------

        if (status === 429) {
          const cooldownMs = parseRetryAfterMs(
            response,
            Number(BINANCE_DEFAULT_429_COOLDOWN_MS),
          );

          info.failures += 1;

          info.lastError = responseText || "HTTP 429 rate limit";

          binanceEndpointState.set(endpoint, info);

          setEndpointCooldown(
            endpoint,
            cooldownMs,
            `HTTP 429 - Binance rate limit. ${
              responseText || "No response body."
            }`,
          );

          // Move to another endpoint rather than hammering
          // the rate-limited endpoint.
          rotatePreferredEndpoint();

          lastError = new BinanceApiError(
            `Binance rate limited endpoint ${endpoint}.`,
            {
              status,

              endpoint,

              responseText,

              retryAfterMs: cooldownMs,
            },
          );

          break;
        }

        // ------------------------------------------------------
        // 403 - WAF
        // ------------------------------------------------------

        if (status === 403) {
          const cooldownMs = Number(BINANCE_DEFAULT_403_COOLDOWN_MS);

          info.failures += 1;

          info.lastError = responseText || "HTTP 403 WAF rejection";

          binanceEndpointState.set(endpoint, info);

          setEndpointCooldown(
            endpoint,
            cooldownMs,
            `HTTP 403 - Binance WAF rejection. ${
              responseText || "No response body."
            }`,
          );

          rotatePreferredEndpoint();

          lastError = new BinanceApiError(
            `Binance rejected ${endpoint} with HTTP 403.`,
            {
              status,

              endpoint,

              responseText,

              retryAfterMs: cooldownMs,
            },
          );

          break;
        }

        // ------------------------------------------------------
        // 5XX - SERVER ERROR
        // ------------------------------------------------------

        if (status >= 500 && status <= 599) {
          info.failures += 1;

          info.lastError = responseText || `HTTP ${status}`;

          binanceEndpointState.set(endpoint, info);

          if (retries < maxRetriesPerEndpoint) {
            const backoff = calculateBackoffMs(retries);

            console.warn(
              `⚠️ Binance ${status} on ${endpoint}. Retrying in ${Math.ceil(
                backoff / 1000,
              )}s...`,
            );

            await sleep(backoff);

            retries += 1;

            continue;
          }

          setEndpointCooldown(
            endpoint,
            Number(BINANCE_DEFAULT_5XX_COOLDOWN_MS),
            `HTTP ${status}`,
          );

          rotatePreferredEndpoint();

          lastError = new BinanceApiError(`Binance server error ${status}.`, {
            status,

            endpoint,

            responseText,
          });

          break;
        }

        // ------------------------------------------------------
        // OTHER 4XX
        // ------------------------------------------------------

        info.failures += 1;

        info.lastError = responseText || `HTTP ${status}`;

        binanceEndpointState.set(endpoint, info);

        lastError = new BinanceApiError(`Binance API failed: HTTP ${status}`, {
          status,

          endpoint,

          responseText,
        });

        // Don't hammer a malformed/request error.
        break;
      } catch (error) {
        info.failures += 1;

        info.lastError = error?.message || String(error);

        binanceEndpointState.set(endpoint, info);

        lastError = error;

        console.warn(
          `⚠️ Binance network error on ${endpoint}: ${error?.message || error}`,
        );

        if (retries < maxRetriesPerEndpoint) {
          const backoff = calculateBackoffMs(retries);

          console.log(
            `🔁 Retrying Binance endpoint in ${Math.ceil(backoff / 1000)}s...`,
          );

          await sleep(backoff);

          retries += 1;

          continue;
        }

        // Move to another endpoint.
        rotatePreferredEndpoint();

        break;
      }
    }
  }

  // ----------------------------------------------------------
  // ALL ENDPOINTS FAILED
  // ----------------------------------------------------------

  const earliest = getEarliestEndpointCooldown();

  let retryAfterMs = Number(BINANCE_DEFAULT_429_COOLDOWN_MS);

  if (Number.isFinite(earliest) && earliest > Date.now()) {
    retryAfterMs = Math.max(retryAfterMs, earliest - Date.now());
  }

  // If every endpoint was rate-limited/banned, create a
  // global cooldown so the next bot call doesn't immediately
  // hammer Binance again.
  binanceGlobalCooldownUntil = Math.max(
    binanceGlobalCooldownUntil,
    Date.now() +
      Math.min(retryAfterMs, Number(BINANCE_DEFAULT_418_COOLDOWN_MS)),
  );

  throw new BinanceApiError(
    `Binance API unavailable after trying ${attempted} endpoint(s). Last error: ${
      lastError?.message || String(lastError)
    }`,
    {
      attemptedEndpoints: attempted,

      retryAfterMs,

      cause: lastError,
    },
  );
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");

    const parsed = JSON.parse(raw);

    state = {
      ...state,
      ...parsed,
    };

    console.log("📂 State loaded.");
  } catch {
    console.log("📂 No existing state found. Starting fresh.");
  }

  const today = getDateKey();

  if (state.lastPostDate !== today) {
    state.postsToday = 0;

    state.lastPostDate = today;

    await saveState();
  }
}

async function saveState() {
  try {
    await fs.writeFile(
      BACKUP_STATE_FILE,
      JSON.stringify(state, null, 2),
      "utf8",
    );

    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (error) {
    console.error("⚠️ Failed to save state:", error.message);
  }
}

// ============================================================
// MONGODB
// ============================================================

async function connectMongo() {
  try {
    mongoClient = new MongoClient(MONGODB_URI);

    await mongoClient.connect();

    db = mongoClient.db(MONGODB_DB_NAME);

    console.log(`🍃 MongoDB connected: ${MONGODB_DB_NAME}`);
  } catch (error) {
    console.error("⚠️ MongoDB connection failed:", error.message);

    db = null;
  }
}

async function saveHistory(record) {
  if (!db) {
    return;
  }

  try {
    await db.collection("post_history").insertOne({
      ...record,

      createdAt: new Date(),
    });

    const maxHistory = Number(MAX_HISTORY);

    const count = await db.collection("post_history").countDocuments();

    if (count > maxHistory) {
      const excess = count - maxHistory;

      const oldRecords = await db
        .collection("post_history")
        .find({})
        .sort({
          createdAt: 1,
        })
        .limit(excess)
        .project({
          _id: 1,
        })
        .toArray();

      if (oldRecords.length) {
        await db.collection("post_history").deleteMany({
          _id: {
            $in: oldRecords.map((item) => item._id),
          },
        });
      }
    }
  } catch (error) {
    console.error("⚠️ Mongo history save failed:", error.message);
  }
}

async function saveNews(coin, news) {
  if (!db || !news?.length) {
    return;
  }

  try {
    await db.collection("coin_news").updateOne(
      {
        coin,
      },
      {
        $set: {
          coin,

          news,

          updatedAt: new Date(),
        },
      },
      {
        upsert: true,
      },
    );
  } catch (error) {
    console.error("⚠️ Mongo news save failed:", error.message);
  }
}

// ============================================================
// BINANCE MARKET DATA
// ============================================================

async function fetch24hTickers() {
  return requestBinance("/api/v3/ticker/24hr");
}

async function fetchKlines(symbol) {
  const query = new URLSearchParams({
    symbol,

    interval: "1h",

    limit: "100",
  });

  return requestBinance(`/api/v3/klines?${query.toString()}`);
}

// ============================================================
// SELECT STRONGEST COIN
// ============================================================

async function selectStrongestCoin() {
  console.log("🔎 Scanning Binance USDT markets...");

  const tickers = await fetch24hTickers();

  if (!Array.isArray(tickers)) {
    throw new Error("Binance ticker API returned unexpected data.");
  }

  const minVolume = Number(MIN_24H_VOLUME_USDT);

  const candidates = tickers
    .filter((ticker) => {
      const symbol = String(ticker.symbol || "").toUpperCase();

      const priceChange = safeNumber(ticker.priceChangePercent);

      const volume = safeNumber(ticker.quoteVolume);

      return (
        symbol.endsWith("USDT") &&
        !symbol.includes("UPUSDT") &&
        !symbol.includes("DOWNUSDT") &&
        !symbol.includes("BULLUSDT") &&
        !symbol.includes("BEARUSDT") &&
        volume >= minVolume &&
        priceChange > 0
      );
    })
    .sort(
      (a, b) =>
        safeNumber(b.priceChangePercent) - safeNumber(a.priceChangePercent),
    )
    .slice(0, Number(MAX_SCAN_COINS));

  if (!candidates.length) {
    throw new Error("No suitable Binance USDT market found.");
  }

  const selected = candidates[0];

  const coin = selected.symbol.replace(/USDT$/i, "");

  console.log(
    `🏆 Selected ${coin} | 24h: ${formatPercent(
      selected.priceChangePercent,
    )}% | Volume: $${Number(selected.quoteVolume).toLocaleString()}`,
  );

  return {
    symbol: selected.symbol,

    coin,

    price: safeNumber(selected.lastPrice),

    priceChange24h: safeNumber(selected.priceChangePercent),

    volume24h: safeNumber(selected.quoteVolume),
  };
}

// ============================================================
// TECHNICAL INDICATORS
// ============================================================

function calculateSMA(values, period) {
  if (values.length < period) {
    return null;
  }

  const slice = values.slice(-period);

  const sum = slice.reduce((total, value) => total + value, 0);

  return sum / period;
}

function calculateRSI(values, period = RSI_PERIOD) {
  if (values.length <= period) {
    return null;
  }

  let gains = 0;

  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const difference = values[i] - values[i - 1];

    if (difference >= 0) {
      gains += difference;
    } else {
      losses += Math.abs(difference);
    }
  }

  let averageGain = gains / period;

  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const difference = values[i] - values[i - 1];

    const gain = difference > 0 ? difference : 0;

    const loss = difference < 0 ? Math.abs(difference) : 0;

    averageGain = (averageGain * (period - 1) + gain) / period;

    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

async function calculateIndicators(symbol) {
  console.log(`📊 Calculating indicators for ${symbol}...`);

  const klines = await fetchKlines(symbol);

  const closes = klines.map((candle) => safeNumber(candle[4]));

  const currentPrice = closes[closes.length - 1];

  const sma9 = calculateSMA(closes, SMA_SHORT);

  const sma21 = calculateSMA(closes, SMA_LONG);

  const sma50 = calculateSMA(closes, SMA_MEDIUM);

  const rsi = calculateRSI(closes, RSI_PERIOD);

  let trend = "MIXED";

  if (sma9 !== null && sma21 !== null && sma50 !== null) {
    if (currentPrice > sma9 && sma9 > sma21 && sma21 > sma50) {
      trend = "BULLISH";
    } else if (currentPrice < sma9 && sma9 < sma21 && sma21 < sma50) {
      trend = "BEARISH";
    }
  }

  console.log(
    `SMA9=${round(sma9, 6)} | SMA21=${round(sma21, 6)} | SMA50=${round(
      sma50,
      6,
    )} | RSI=${round(rsi, 2)} | Trend=${trend}`,
  );

  return {
    currentPrice,

    sma9,

    sma21,

    sma50,

    rsi,

    trend,
  };
}

// ============================================================
// GOOGLE NEWS
// ============================================================

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

async function fetchCoinNews(coin) {
  console.log(`📰 Fetching news for ${coin}...`);

  const query = encodeURIComponent(`"${coin}" crypto OR cryptocurrency`);

  const url =
    `https://news.google.com/rss/search?` +
    `q=${query}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      console.log("⚠️ Google News unavailable.");

      return [];
    }

    const xml = await response.text();

    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)];

    const news = items
      .slice(0, Number(NEWS_ITEMS))
      .map((match) => {
        const item = match[1];

        const title = item.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "";

        const link = item.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || "";

        const pubDate =
          item.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1] || "";

        return {
          title: stripHtml(title),

          link: link.trim(),

          pubDate: pubDate.trim(),
        };
      })
      .filter((item) => item.title);

    console.log(`📰 Found ${news.length} news items.`);

    await saveNews(coin, news);

    return news;
  } catch (error) {
    console.error("⚠️ News fetch failed:", error.message);

    return [];
  }
}

// ============================================================
// HASHTAG SANITIZATION
// ============================================================

function sanitizeHashtags(hashtags, coin) {
  const fallback = [`#${coin}`, "#CryptoAnalysis"];

  if (!Array.isArray(hashtags)) {
    return fallback;
  }

  const cleaned = hashtags
    .map((tag) => String(tag || "").trim())
    .map((tag) => {
      if (tag && !tag.startsWith("#")) {
        return `#${tag}`;
      }

      return tag;
    })
    .filter((tag) => /^#[A-Za-z0-9_]+$/.test(tag));

  const unique = [...new Set(cleaned)];

  if (!unique.length) {
    return fallback;
  }

  return unique.slice(0, MAX_HASHTAGS);
}

// ============================================================
// REMOVE INLINE HASHTAGS
// ============================================================

function removeInlineHashtags(content) {
  if (!content) {
    return "";
  }

  return String(content)
    .replace(/(^|\s)#[A-Za-z0-9_]+/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================
// TITLE
// ============================================================

function generateTitle(market, indicators = {}) {
  const coin = market.coin;

  const change = safeNumber(market.priceChange24h);

  const percentage = formatPercent(Math.abs(change));

  const rsi = safeNumber(indicators.rsi);

  const trend = String(indicators.trend || "MIXED").toUpperCase();

  // Strong move + overbought = curiosity/trap angle
  if (change >= 10 && rsi >= 70) {
    return `🚨 $${coin} IS UP ${percentage}% — BULLISH BREAKOUT OR TRAP? BUY, HOLD OR SELL?`;
  }

  // Strong move + bullish trend
  if (change >= 10 && trend === "BULLISH") {
    return `🔥 $${coin} JUST JUMPED ${percentage}% — IS THE BREAKOUT REAL? BUY, HOLD OR SELL?`;
  }

  // Strong move
  if (change >= 10) {
    return `🚨 $${coin} JUST EXPLODED ${percentage}% — WHAT HAPPENS NEXT? BUY, HOLD OR SELL?`;
  }

  // Normal positive move + bullish trend
  if (change > 1 && trend === "BULLISH") {
    return `📈 $${coin} IS UP ${percentage}% — IS THIS THE START OF SOMETHING BIG? BUY, HOLD OR SELL?`;
  }

  // Normal positive move
  if (change > 1) {
    return `👀 $${coin} IS UP ${percentage}% — BREAKOUT OR PULLBACK NEXT? BUY, HOLD OR SELL?`;
  }

  // Flat market
  if (change >= -1 && change <= 1) {
    return `⚠️ $${coin} IS AT A CRITICAL LEVEL — WHAT COMES NEXT? BUY, HOLD OR SELL?`;
  }

  // Negative move
  if (change < -10) {
    return `🔻 $${coin} IS DOWN ${percentage}% — BOTTOM OR MORE PAIN AHEAD? BUY, HOLD OR SELL?`;
  }

  return `⚠️ $${coin} IS DOWN ${percentage}% — REVERSAL OR CONTINUED DROP? BUY, HOLD OR SELL?`;
}

// ============================================================
// CONTENT OPENING
// ============================================================

function generateOpening(market, indicators = {}) {
  const coin = market.coin;

  const change = safeNumber(market.priceChange24h);

  const percentage = formatPercent(Math.abs(change));

  const rsi = safeNumber(indicators.rsi);

  const trend = String(indicators.trend || "MIXED").toUpperCase();

  if (change >= 10 && rsi >= 70) {
    return `$${coin} just jumped ${percentage}%, but the RSI is already overheated. Is this a real breakout or a trap?`;
  }

  if (change >= 10 && trend === "BULLISH") {
    return `$${coin} just exploded ${percentage}%, and the trend is still bullish. But can this move continue?`;
  }

  if (change >= 10) {
    return `$${coin} just exploded ${percentage}%. The move is getting attention, but what happens next?`;
  }

  if (change > 1 && trend === "BULLISH") {
    return `$${coin} is up ${percentage}% and the trend is looking strong. But is it too late to enter?`;
  }

  if (change > 1) {
    return `$${coin} is up ${percentage}%, but the real question is whether buyers can keep this move alive.`;
  }

  if (change < -10) {
    return `$${coin} is down ${percentage}%. The big question now: is this a buying opportunity or the start of another drop?`;
  }

  if (change < -1) {
    return `$${coin} is down ${percentage}%, but the next move could be more important than today's drop.`;
  }

  return `$${coin} is sitting near a key level. The next move could decide whether buyers or sellers take control.`;
}

// ============================================================
// FINAL CONTENT
// ============================================================

function buildFinalContent(title, content, hashtags, coin) {
  const cleanTitle = String(title || "")
    .replace(/#[A-Za-z0-9_]+/g, "")
    .trim();

  const cleanContent = removeInlineHashtags(content);

  const safeHashtags = sanitizeHashtags(hashtags, coin);

  return (
    `${cleanTitle}\n\n` +
    `${cleanContent}\n\n` +
    `${safeHashtags.join(" ")}`
  ).trim();
}

// ============================================================
// GROQ
// ============================================================

async function generatePost({ market, indicators, news }) {
  console.log("🤖 Generating AI market analysis...");

  const title = generateTitle(market, indicators);

  const opening = generateOpening(market, indicators);

  const newsText = news.length
    ? news.map((item, index) => `${index + 1}. ${item.title}`).join("\n")
    : "No recent reliable news available.";

  const prompt = `
You are an expert crypto market analyst writing a Binance Square post.

Your job is NOT to write a boring technical-analysis report.

Your job is to create an attractive, mysterious, easy-to-read post that makes the reader curious about what happens next.

============================================================
MARKET DATA
============================================================

COIN:
${market.coin}

SYMBOL:
${market.symbol}

CURRENT PRICE:
$${formatPrice(market.price)}

24H CHANGE:
${formatPercent(market.priceChange24h)}%

24H VOLUME:
$${Number(market.volume24h).toLocaleString()}

============================================================
TECHNICAL DATA
============================================================

SMA 9:
${formatPrice(indicators.sma9)}

SMA 21:
${formatPrice(indicators.sma21)}

SMA 50:
${formatPrice(indicators.sma50)}

RSI:
${round(indicators.rsi, 2)}

TREND:
${indicators.trend}

============================================================
TITLE
============================================================

The title has already been generated.

TITLE:
${title}

Do NOT create another title.

Do NOT change the title.

Do NOT repeat the title inside the content.

============================================================
OPENING HOOK
============================================================

The post should be based on this opening idea:

${opening}

Do NOT copy it word-for-word every time.

Rewrite it naturally while keeping the same meaning.

The first 1-2 lines must immediately create curiosity.

The reader should quickly understand:

- which coin
- what happened
- why it matters
- BUY, HOLD or SELL angle

Do NOT start with:

"According to technical analysis..."

"Based on the indicators..."

"Let's analyze..."

"Here is the analysis..."

Start like a Binance Square post, not a research report.

============================================================
REQUIRED POST STRUCTURE
============================================================

FOLLOW THIS ORDER:

1. HOOK

Create a strong and mysterious opening.

Example style:

"$COIN just exploded 20%... but is this really a breakout?"

"$COIN is pumping hard, but something doesn't look right."

"$COIN is showing serious strength — but should you BUY, HOLD or SELL?"

Do NOT copy these examples exactly.

Use the real market data.

------------------------------------------------------------

2. WHY

Explain WHY the coin is bullish, bearish or uncertain.

Use:

- price movement
- SMA 9
- SMA 21
- SMA 50
- RSI
- volume
- overall trend

Do not simply list the indicators.

Explain them naturally.

For example:

"Price is above the 9 and 21 SMA, showing that buyers currently have control."

Instead of:

"SMA9 = X, SMA21 = Y."

------------------------------------------------------------

3. NEWS / IMPORTANT TOPIC

Discuss the most important recent news or topic.

Explain:

- what happened
- why it matters
- how it could affect the coin
- what traders should watch next

NEVER invent news.

Only use information provided in the news section.

If there is no useful reliable news, say that the market is mainly being driven by price action or sentiment.

------------------------------------------------------------

4. WHAT TO DO NOW

Clearly choose ONE action:

BUY

HOLD

SELL

Do not give multiple actions.

If the signals are mixed, choose HOLD.

The action should be based on the complete picture, not just the 24h percentage.

------------------------------------------------------------

5. TARGET

Give a realistic target price.

Do not create extreme or unrealistic targets.

------------------------------------------------------------

6. INVALIDATION

Give a realistic invalidation price.

Explain briefly what level would make the current setup invalid.

------------------------------------------------------------

7. FINAL QUESTION

End with a short question that encourages comments.

Examples:

"Can $COIN keep this momentum?"

"Would you BUY here or wait for a pullback?"

"Do you think this breakout is real?"

"Where do you see $COIN next?"

Do NOT use the same question every time.

============================================================
STYLE
============================================================

Use A2-B1 English.

Keep sentences short.

Use simple words.

Sound like an experienced crypto trader explaining the situation to a normal person.

The post should be:

- interesting
- mysterious
- informative
- easy to understand
- professional
- conversational

Do NOT sound like an AI report.

Do NOT overuse technical jargon.

Do NOT use fake urgency.

Do NOT promise profits.

Do NOT claim certainty.

Never say:

"100% guaranteed"

"guaranteed profit"

"risk-free"

"can't lose"

"easy money"

"certain to pump"

============================================================
IMPORTANT PERCENTAGE RULE
============================================================

A percentage represents PRICE MOVEMENT.

Never say:

"$COIN is 29% bullish."

That is incorrect.

Say:

"$COIN is UP 29%."

or:

"$COIN jumped 29%."

============================================================
RSI RULE
============================================================

Explain RSI simply.

If RSI is around 50:

Momentum is relatively balanced.

If RSI is above 70:

Momentum is strong but potentially overbought.

If RSI is below 30:

The coin may be oversold.

Do not automatically call an overbought coin bearish.

Explain the situation.

============================================================
TARGET / INVALIDATION
============================================================

Use realistic prices based on the current market.

Do not invent extreme targets.

The target should make sense relative to:

- current price
- recent movement
- SMA levels
- trend

============================================================
HASHTAGS
============================================================

Use MAXIMUM TWO hashtags.

Do NOT put hashtags inside the content.

Return hashtags separately.

============================================================
NEWS
============================================================

${newsText}

============================================================
CONTENT LENGTH
============================================================

Content must be approximately 500-900 characters.

Aim for approximately 650-850 characters.

Do not make the content extremely short.

Do not make it unnecessarily long.

============================================================
OUTPUT
============================================================

Return ONLY valid JSON.

Use exactly this structure:

{
  "content": "complete Binance Square body without title",
  "action": "BUY | HOLD | SELL",
  "targetPrice": 0,
  "invalidationPrice": 0,
  "confidence": "LOW | MEDIUM | HIGH",
  "qualityScore": 0,
  "hashtags": [
    "#${market.coin}",
    "#CryptoAnalysis"
  ],
  "newsUsed": true
}

IMPORTANT:

- Do not include the title inside content.
- Do not create another title.
- Do not repeat the title.
- Do not use hashtags inside content.
- Return maximum 2 hashtags.
- Use real market data.
- Never invent news.
- Never promise profit.
- Never claim certainty.
- End the content with a question.
`;

  const completion = await groq.chat.completions.create({
    model: GROQ_MODEL,

    temperature: 0.65,

    max_tokens: Number(GENERATION_MAX_TOKENS),

    response_format: {
      type: "json_object",
    },

    messages: [
      {
        role: "system",

        content:
          "You are a professional crypto market analyst and Binance Square content writer. Write attractive, mysterious, beginner-friendly crypto posts. Return only valid JSON.",
      },

      {
        role: "user",

        content: prompt,
      },
    ],
  });

  const raw = completion.choices?.[0]?.message?.content;

  if (!raw) {
    throw new Error("Groq returned empty response.");
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("❌ Invalid Groq JSON:", raw);

    throw new Error("Groq returned invalid JSON.");
  }

  return normalizePost(parsed, market, title);
}

// ============================================================
// NORMALIZE AI POST
// ============================================================

function normalizePost(post, market, title) {
  const action = ["BUY", "HOLD", "SELL"].includes(
    String(post.action || "").toUpperCase(),
  )
    ? String(post.action).toUpperCase()
    : "HOLD";

  const confidence = ["LOW", "MEDIUM", "HIGH"].includes(
    String(post.confidence || "").toUpperCase(),
  )
    ? String(post.confidence).toUpperCase()
    : "MEDIUM";

  let content = String(post.content || "").trim();

  if (content.toLowerCase().startsWith(title.toLowerCase())) {
    content = content.slice(title.length).trim();
  }

  content = removeInlineHashtags(content);

  const hashtags = sanitizeHashtags(post.hashtags, market.coin);

  let targetPrice = safeNumber(post.targetPrice);

  let invalidationPrice = safeNumber(post.invalidationPrice);

  const currentPrice = safeNumber(market.price);

  if (targetPrice <= 0) {
    if (action === "BUY") {
      targetPrice = currentPrice * 1.08;
    } else if (action === "SELL") {
      targetPrice = currentPrice * 0.92;
    } else {
      targetPrice = currentPrice * 1.05;
    }
  }

  if (invalidationPrice <= 0) {
    if (action === "BUY") {
      invalidationPrice = currentPrice * 0.95;
    } else if (action === "SELL") {
      invalidationPrice = currentPrice * 1.05;
    } else {
      invalidationPrice = currentPrice * 0.95;
    }
  }

  return {
    title,

    content,

    action,

    targetPrice: round(targetPrice, 8),

    invalidationPrice: round(invalidationPrice, 8),

    confidence,

    qualityScore: Math.min(10, Math.max(0, safeNumber(post.qualityScore, 5))),

    hashtags,

    newsUsed: Boolean(post.newsUsed),
  };
}

// ============================================================
// CONTENT VALIDATION
// ============================================================

function validatePost(post) {
  const warnings = [];

  const contentLength = post.content.length;

  if (contentLength < MIN_CONTENT_CHARS) {
    warnings.push(`Content is shorter than ${MIN_CONTENT_CHARS} characters.`);
  }

  if (contentLength > MAX_CONTENT_CHARS) {
    warnings.push(`Content is longer than ${MAX_CONTENT_CHARS} characters.`);
  }

  if (!post.title) {
    warnings.push("Missing title.");
  }

  if (!post.content) {
    warnings.push("Missing content.");
  }

  if (!["BUY", "HOLD", "SELL"].includes(post.action)) {
    warnings.push("Invalid action.");
  }

  if (post.hashtags.length > MAX_HASHTAGS) {
    warnings.push("Too many hashtags.");
  }

  if (post.targetPrice <= 0) {
    warnings.push("Invalid target price.");
  }

  if (post.invalidationPrice <= 0) {
    warnings.push("Invalid invalidation price.");
  }

  return {
    valid: warnings.length === 0,

    warnings,
  };
}

// ============================================================
// IMAGE GENERATION
// ============================================================

async function generateTradingGraphic({ market, indicators, post }) {
  console.log("🎨 Generating trading graphic...");

  if (!CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_API_TOKEN) {
    throw new Error("Cloudflare credentials missing.");
  }

  await fs.mkdir(GENERATED_IMAGES_DIR, {
    recursive: true,
  });

  const imagePrompt = `
Create a professional cryptocurrency trading graphic for Binance Square.

Coin: ${market.coin}

Current Price:
$${formatPrice(market.price)}

24h Change:
${formatPercent(market.priceChange24h)}%

Action:
${post.action}

Target:
$${formatPrice(post.targetPrice)}

Invalidation:
$${formatPrice(post.invalidationPrice)}

RSI:
${round(indicators.rsi, 2)}

Trend:
${indicators.trend}

Style:

- premium financial news graphic
- professional crypto trading analysis
- modern trading terminal aesthetic
- dark sophisticated background
- large readable ${market.coin} ticker
- current price clearly visible
- realistic technical chart visual
- clear bullish or bearish visual depending on action
- professional financial presentation
- clean composition
- high contrast
- no fake exchange logos
- no fake Binance logo
- no extra hashtags
- no watermark
- no unnecessary text
- no fake statistics
`;

  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${CLOUDFLARE_ACCOUNT_ID}/ai/run/` +
    `${CLOUDFLARE_IMAGE_MODEL}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "POST",

      headers: {
        Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,

        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        prompt: imagePrompt,
      }),
    },
    120000,
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Cloudflare image API failed: ${response.status} ${errorText}`,
    );
  }

  const contentType = response.headers.get("content-type") || "";

  const filename = `coin-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 9)}.png`;

  const imagePath = path.join(GENERATED_IMAGES_DIR, filename);

  if (contentType.includes("application/json")) {
    const json = await response.json();

    let imageBuffer;

    if (json.result?.image) {
      imageBuffer = Buffer.from(json.result.image, "base64");
    } else if (json.result?.image_base64) {
      imageBuffer = Buffer.from(json.result.image_base64, "base64");
    } else {
      throw new Error("Cloudflare returned JSON but no image data.");
    }

    await fs.writeFile(imagePath, imageBuffer);
  } else {
    const buffer = Buffer.from(await response.arrayBuffer());

    await fs.writeFile(imagePath, buffer);
  }

  console.log(`✅ Image saved: ${imagePath}`);

  return imagePath;
}

// ============================================================
// PUBLISH TO BINANCE SQUARE
// ============================================================

function publishToBinanceSquare(content, imagePath, coin) {
  return new Promise((resolve, reject) => {
    console.log("📡 Publishing to Binance Square...");

    const cleanContent = removeInlineHashtags(content);

    const contentWithoutHashtags = cleanContent
      .replace(/(^|\s)#[A-Za-z0-9_]+/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    const safeHashtags = sanitizeHashtags(
      [`#${coin}`, "#CryptoAnalysis"],
      coin,
    );

    const finalContent =
      `${contentWithoutHashtags}\n\n` + `${safeHashtags.join(" ")}`;

    console.log("🏷️ Publishing with hashtags:", safeHashtags.join(" "));

    console.log(`🏷️ Hashtag count: ${safeHashtags.length}`);

    if (safeHashtags.length > MAX_HASHTAGS) {
      return reject(
        new Error("Internal safety check: hashtag limit exceeded."),
      );
    }

    const args = [
      SQUARE_IMAGE_SCRIPT,

      "--text",
      finalContent,

      "--images",
      imagePath,
    ];

    const child = spawn(process.execPath, args, {
      cwd: path.dirname(SQUARE_IMAGE_SCRIPT),

      env: {
        ...process.env,

        BINANCE_SQUARE_OPENAPI_KEY,
      },

      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";

    let stderr = "";

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
      reject(error);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          success: true,

          stdout,

          stderr,

          finalContent,

          hashtags: safeHashtags,
        });
      } else {
        reject(
          new Error(
            `Square publisher exited with code ${code}\n` +
              `${stderr || stdout}`,
          ),
        );
      }
    });
  });
}

// ============================================================
// POST LIMIT
// ============================================================

function canPostToday() {
  const today = getDateKey();

  if (state.lastPostDate !== today) {
    state.postsToday = 0;

    state.lastPostDate = today;
  }

  return state.postsToday < Number(MAX_POSTS_PER_DAY);
}

// ============================================================
// MAIN BOT CYCLE
// ============================================================

async function runCycle() {
  console.log("\n============================================================");

  console.log("🚀 BINANCE SQUARE AI BOT CYCLE");

  console.log("============================================================\n");

  if (!canPostToday()) {
    console.log(
      `⛔ Daily post limit reached: ${state.postsToday}/${MAX_POSTS_PER_DAY}`,
    );

    return {
      success: false,

      skipped: true,

      reason: "daily_limit",
    };
  }

  let market = null;

  let indicators = null;

  let news = [];

  let post = null;

  let imagePath = null;

  try {
    market = await selectStrongestCoin();

    indicators = await calculateIndicators(market.symbol);

    news = await fetchCoinNews(market.coin);

    post = await generatePost({
      market,

      indicators,

      news,
    });

    const validation = validatePost(post);

    if (!validation.valid) {
      console.log("⚠️ Content validation warnings:");

      for (const warning of validation.warnings) {
        console.log(`   - ${warning}`);
      }
    } else {
      console.log("✅ Content validation passed.");
    }

    const finalContent = buildFinalContent(
      post.title,
      post.content,
      post.hashtags,
      market.coin,
    );

    console.log("\n📝 FINAL POST:");

    console.log("------------------------------------------------------------");

    console.log(finalContent);

    console.log("------------------------------------------------------------");

    console.log(`Title: ${post.title}`);

    console.log(`Action: ${post.action}`);

    console.log(`Target Price: $${formatPrice(post.targetPrice)}`);

    console.log(`Invalidation Price: $${formatPrice(post.invalidationPrice)}`);

    console.log(`Confidence: ${post.confidence}`);

    console.log(`newsUsed: ${post.newsUsed}`);

    console.log(`qualityScore: ${post.qualityScore}`);

    console.log(`hashtags: ${post.hashtags.join(" ")}`);

    console.log(`Content chars: ${post.content.length}`);

    imagePath = await generateTradingGraphic({
      market,

      indicators,

      post,
    });

    if (String(DRY_RUN).toLowerCase() === "true") {
      console.log("\n🧪 DRY_RUN enabled.");

      console.log("⏭️ Skipping Binance Square publication.");

      await saveHistory({
        success: true,

        dryRun: true,

        coin: market.coin,

        symbol: market.symbol,

        title: post.title,

        action: post.action,

        targetPrice: post.targetPrice,

        invalidationPrice: post.invalidationPrice,

        confidence: post.confidence,

        qualityScore: post.qualityScore,

        newsUsed: post.newsUsed,

        content: finalContent,

        hashtags: post.hashtags,

        imagePath,
      });

      return {
        success: true,

        dryRun: true,

        coin: market.coin,

        title: post.title,
      };
    }

    const publication = await publishToBinanceSquare(
      finalContent,

      imagePath,

      market.coin,
    );

    state.postsToday += 1;

    state.totalPosts += 1;

    state.lastCoin = market.coin;

    state.lastPostAt = new Date().toISOString();

    state.lastPostDate = getDateKey();

    await saveState();

    await saveHistory({
      success: true,

      coin: market.coin,

      symbol: market.symbol,

      title: post.title,

      action: post.action,

      targetPrice: post.targetPrice,

      invalidationPrice: post.invalidationPrice,

      confidence: post.confidence,

      qualityScore: post.qualityScore,

      newsUsed: post.newsUsed,

      hashtags: post.hashtags,

      content: finalContent,

      imagePath,

      publication,
    });

    console.log(
      "\n============================================================",
    );

    console.log("🎉 BINANCE SQUARE POST PUBLISHED SUCCESSFULLY");

    console.log("============================================================");

    return {
      success: true,

      coin: market.coin,

      title: post.title,

      action: post.action,

      targetPrice: post.targetPrice,

      invalidationPrice: post.invalidationPrice,

      confidence: post.confidence,

      hashtags: post.hashtags,
    };
  } catch (error) {
    state.totalFailures += 1;

    await saveState();

    await saveHistory({
      success: false,

      coin: market?.coin || null,

      symbol: market?.symbol || null,

      title: post?.title || null,

      error: error.message,

      createdAt: new Date(),
    });

    console.error("\n❌ Cycle failed:");

    console.error(error);

    return {
      success: false,

      error: error.message,

      retryAfterMs: error?.retryAfterMs || null,
    };
  }
}

// ============================================================
// BOT INITIALIZATION
// ============================================================

let botInitialized = false;

let botInitializing = null;

async function initializeBinanceBot() {
  if (botInitialized) {
    return;
  }

  if (botInitializing) {
    return botInitializing;
  }

  botInitializing = (async () => {
    console.log("⚙️ Initializing Binance bot...");

    await loadState();

    await connectMongo();

    botInitialized = true;

    console.log("✅ Binance bot initialized.");
  })();

  try {
    await botInitializing;
  } finally {
    botInitializing = null;
  }
}

// ============================================================
// PUBLIC BOT RUNNER
// ============================================================

async function runBinanceBot() {
  await initializeBinanceBot();

  return await runCycle();
}

// ============================================================
// PUBLIC STATUS
// ============================================================

function getBinanceStatus() {
  const endpointStatus = BINANCE_API_ENDPOINTS.map((endpoint) => {
    const info = getEndpointState(endpoint);

    return {
      endpoint,

      available: Date.now() >= info.cooldownUntil,

      cooldownUntil: info.cooldownUntil
        ? new Date(info.cooldownUntil).toISOString()
        : null,

      lastStatus: info.lastStatus,

      failures: info.failures,

      totalRequests: info.totalRequests,

      lastUsedAt: info.lastUsedAt,
    };
  });

  return {
    version: "11.2.0",

    initialized: botInitialized,

    postsToday: state.postsToday,

    maxPostsPerDay: Number(MAX_POSTS_PER_DAY),

    totalPosts: state.totalPosts,

    totalFailures: state.totalFailures,

    lastCoin: state.lastCoin,

    lastPostAt: state.lastPostAt,

    lastPostDate: state.lastPostDate,

    timezone: BOT_TIMEZONE,

    hashtagLimit: MAX_HASHTAGS,

    contentTarget: `${MIN_CONTENT_CHARS}-${MAX_CONTENT_CHARS}`,

    mongoConnected: Boolean(db),

    dryRun: String(DRY_RUN).toLowerCase() === "true",

    binance: {
      preferredEndpoint: BINANCE_API_ENDPOINTS[preferredBinanceEndpointIndex],

      globalCooldownUntil:
        binanceGlobalCooldownUntil > Date.now()
          ? new Date(binanceGlobalCooldownUntil).toISOString()
          : null,

      endpoints: endpointStatus,
    },
  };
}

// ============================================================
// PUBLIC SHUTDOWN
// ============================================================

async function shutdownBinanceBot() {
  console.log("🛑 Shutting down Binance bot...");

  try {
    if (mongoClient) {
      await mongoClient.close();

      mongoClient = null;

      db = null;

      console.log("🍃 MongoDB connection closed.");
    }
  } catch (error) {
    console.error("⚠️ MongoDB shutdown error:", error?.message || error);
  }

  botInitialized = false;

  console.log("✅ Binance bot shutdown complete.");
}

// ============================================================
// EXPORTS
// ============================================================

export { runBinanceBot, getBinanceStatus, shutdownBinanceBot };
