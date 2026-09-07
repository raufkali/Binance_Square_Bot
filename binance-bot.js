/**
 * ============================================================
 * 🚀 BINANCE SQUARE AI BOT — V11.2.0
 * API RESILIENCE + MYSTERIOUS CONTENT EDITION
 * ============================================================
 *
 * Flow:
 * Binance Market Data
 *        ↓
 * Strongest Coin Selection
 *        ↓
 * Technical Analysis
 *        ↓
 * Google News
 *        ↓
 * Groq AI Content
 *        ↓
 * Cloudflare AI Image
 *        ↓
 * Binance Square
 *
 * Content structure:
 * HOOK → WHY → NEWS/TOPIC → ACTION → TARGET → INVALIDATION → QUESTION
 * ============================================================
 */

import "dotenv/config";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import express from "express";
import mongoose from "mongoose";

import Groq from "groq-sdk";


// ============================================================
// PATHS
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// ============================================================
// ENVIRONMENT
// ============================================================

const PORT = process.env.PORT || 10000;

const MONGO_URL = process.env.MONGO_URL;

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const CLOUDFLARE_ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID;

const CLOUDFLARE_API_TOKEN =
  process.env.CLOUDFLARE_API_TOKEN;

const BINANCE_API_KEY =
  process.env.BINANCE_API_KEY;

const BINANCE_API_SECRET =
  process.env.BINANCE_API_SECRET;

const BINANCE_COOKIE =
  process.env.BINANCE_COOKIE;

const BINANCE_SQUARE_URL =
  process.env.BINANCE_SQUARE_URL ||
  "https://www.binance.com/bapi/composite/v1/public/ugc/feeds";


if (!MONGO_URL) {
  console.warn("⚠️ MONGO_URL is missing");
}

if (!GROQ_API_KEY) {
  console.warn("⚠️ GROQ_API_KEY is missing");
}

if (!CLOUDFLARE_ACCOUNT_ID) {
  console.warn("⚠️ CLOUDFLARE_ACCOUNT_ID is missing");
}

if (!CLOUDFLARE_API_TOKEN) {
  console.warn("⚠️ CLOUDFLARE_API_TOKEN is missing");
}


// ============================================================
// CLIENTS
// ============================================================

const groq = GROQ_API_KEY
  ? new Groq({
      apiKey: GROQ_API_KEY,
    })
  : null;


// ============================================================
// CONSTANTS
// ============================================================

const APP_NAME = "Binance Square AI Bot";

const VERSION = "V11.2.0";

const POST_INTERVAL =
  Number(process.env.POST_INTERVAL || 3 * 60 * 60 * 1000);

const MIN_POST_INTERVAL =
  Number(process.env.MIN_POST_INTERVAL || 60 * 60 * 1000);

const MAX_NEWS =
  Number(process.env.MAX_NEWS || 3);

const HTTP_TIMEOUT =
  Number(process.env.HTTP_TIMEOUT || 30000);

const IMAGE_TIMEOUT =
  Number(process.env.IMAGE_TIMEOUT || 120000);

const MAX_RETRIES =
  Number(process.env.MAX_RETRIES || 3);

const MAX_POST_LENGTH =
  Number(process.env.MAX_POST_LENGTH || 1000);


// ============================================================
// CRYPTO POOL
// ============================================================

const COIN_POOL = [
  "bitcoin",
  "ethereum",
  "solana",
  "binancecoin",
  "xrp",
  "dogecoin",
  "shiba-inu",
  "pepe",
  "official-trump",
  "bonk",
  "dogwifcoin",
  "floki",
];


// ============================================================
// TECHNICAL SETTINGS
// ============================================================

const SMA_SHORT = 9;

const SMA_MEDIUM = 50;

const SMA_LONG = 21;

const RSI_PERIOD = 14;


// ============================================================
// BINANCE API ENDPOINTS
// ============================================================

const BINANCE_ENDPOINTS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
  "https://api4.binance.com",
];

let currentBinanceEndpointIndex = 0;


// ============================================================
// BOT STATE
// ============================================================

let isRunning = false;

let cycleRunning = false;

let lastPostTime = 0;

let lastPost = null;

let totalPosts = 0;

let totalErrors = 0;

let currentCoin = null;


// ============================================================
// UTILITY FUNCTIONS
// ============================================================

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


function safeNumber(value, fallback = 0) {
  const num = Number(value);

  return Number.isFinite(num)
    ? num
    : fallback;
}


function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}


function formatPrice(value) {
  const price = safeNumber(value);

  if (price >= 1000) {
    return `$${price.toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;
  }

  if (price >= 1) {
    return `$${price.toFixed(4)}`;
  }

  if (price >= 0.01) {
    return `$${price.toFixed(5)}`;
  }

  return `$${price.toFixed(8)}`;
}


function formatPercent(value) {
  const num = safeNumber(value);

  return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
}


function formatVolume(value) {
  const num = safeNumber(value);

  if (num >= 1_000_000_000) {
    return `$${(num / 1_000_000_000).toFixed(2)}B`;
  }

  if (num >= 1_000_000) {
    return `$${(num / 1_000_000).toFixed(2)}M`;
  }

  if (num >= 1_000) {
    return `$${(num / 1_000).toFixed(2)}K`;
  }

  return `$${num.toFixed(2)}`;
}


function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}


// ============================================================
// GENERIC HTTP FETCH
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeout = HTTP_TIMEOUT
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    return response;
  } finally {
    clearTimeout(timer);
  }
}


// ============================================================
// RETRY HELPERS
// ============================================================

function getBackoffDelay(attempt) {
  return Math.min(
    1000 * Math.pow(2, attempt),
    10000
  );
}


async function fetchWithRetry(
  url,
  options = {},
  retries = MAX_RETRIES,
  timeout = HTTP_TIMEOUT
) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(
        url,
        options,
        timeout
      );

      if (
        response.ok ||
        (response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429)
      ) {
        return response;
      }

      throw new Error(
        `HTTP ${response.status}`
      );
    } catch (error) {
      lastError = error;

      if (attempt >= retries) {
        break;
      }

      await sleep(getBackoffDelay(attempt));
    }
  }

  throw lastError;
}


// ============================================================
// BINANCE ERROR
// ============================================================

class BinanceApiError extends Error {
  constructor(message, status = null, data = null) {
    super(message);

    this.name = "BinanceApiError";

    this.status = status;

    this.data = data;
  }
}


// ============================================================
// BINANCE ENDPOINT MANAGEMENT
// ============================================================

function rotatePreferredEndpoint() {
  currentBinanceEndpointIndex =
    (currentBinanceEndpointIndex + 1) %
    BINANCE_ENDPOINTS.length;

  return BINANCE_ENDPOINTS[
    currentBinanceEndpointIndex
  ];
}


function getOrderedBinanceEndpoints() {
  const ordered = [];

  for (
    let i = 0;
    i < BINANCE_ENDPOINTS.length;
    i++
  ) {
    ordered.push(
      BINANCE_ENDPOINTS[
        (currentBinanceEndpointIndex + i) %
          BINANCE_ENDPOINTS.length
      ]
    );
  }

  return ordered;
}


// ============================================================
// BINANCE REQUEST
// ============================================================

async function requestBinance(
  endpoint,
  options = {}
) {
  const endpoints = getOrderedBinanceEndpoints();

  let lastError;

  for (const baseUrl of endpoints) {
    const url = `${baseUrl}${endpoint}`;

    try {
      const response = await fetchWithTimeout(
        url,
        {
          ...options,
          headers: {
            Accept: "application/json",
            "User-Agent":
              "Mozilla/5.0 Binance-Square-AI-Bot",
            ...(options.headers || {}),
          },
        },
        HTTP_TIMEOUT
      );

      const text = await response.text();

      let data = null;

      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      if (response.ok) {
        currentBinanceEndpointIndex =
          BINANCE_ENDPOINTS.indexOf(baseUrl);

        return data;
      }

      lastError = new BinanceApiError(
        `Binance API error: ${response.status}`,
        response.status,
        data
      );

      if (
        response.status === 429 ||
        response.status === 418 ||
        response.status >= 500
      ) {
        rotatePreferredEndpoint();

        await sleep(1500);

        continue;
      }

      throw lastError;
    } catch (error) {
      lastError = error;

      console.warn(
        `⚠️ Binance endpoint failed: ${baseUrl}`
      );

      rotatePreferredEndpoint();

      await sleep(1000);
    }
  }

  throw lastError ||
    new BinanceApiError(
      "All Binance API endpoints failed"
    );
}


// ============================================================
// MONGODB
// ============================================================

let db = null;

async function connectMongoDB() {
  if (!MONGO_URL) {
    console.warn(
      "⚠️ MongoDB disabled because MONGO_URL is missing"
    );

    return;
  }

  try {
    await mongoose.connect(MONGO_URL);

    db = mongoose.connection;

    console.log("✅ MongoDB connected");
  } catch (error) {
    console.error(
      "❌ MongoDB connection failed:",
      error.message
    );
  }
}


// ============================================================
// SIMPLE POST HISTORY
// ============================================================

const POST_HISTORY_FILE = path.join(
  __dirname,
  "post-history.json"
);


function loadPostHistory() {
  try {
    if (!fs.existsSync(POST_HISTORY_FILE)) {
      return [];
    }

    const data = fs.readFileSync(
      POST_HISTORY_FILE,
      "utf8"
    );

    return JSON.parse(data);
  } catch {
    return [];
  }
}


function savePostHistory(history) {
  try {
    fs.writeFileSync(
      POST_HISTORY_FILE,
      JSON.stringify(history, null, 2)
    );
  } catch (error) {
    console.warn(
      "⚠️ Could not save post history:",
      error.message
    );
  }
}


function rememberPost(data) {
  const history = loadPostHistory();

  history.push({
    ...data,
    timestamp: new Date().toISOString(),
  });

  while (history.length > 100) {
    history.shift();
  }

  savePostHistory(history);
}


// ============================================================
// BINANCE MARKET DATA
// ============================================================

async function getBinance24hrData() {
  return requestBinance(
    "/api/v3/ticker/24hr"
  );
}


async function getBinanceKlines(
  symbol,
  interval = "1h",
  limit = 100
) {
  return requestBinance(
    `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
  );
}


// ============================================================
// COIN SELECTION
// ============================================================

function normalizeCoinName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}


function symbolToCoinId(symbol) {
  const clean = String(symbol || "")
    .replace(/USDT$/i, "")
    .toLowerCase();

  const map = {
    BTC: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",
    BNB: "binancecoin",
    XRP: "xrp",
    DOGE: "dogecoin",
    SHIB: "shiba-inu",
    PEPE: "pepe",
    TRUMP: "official-trump",
    BONK: "bonk",
    WIF: "dogwifcoin",
    FLOKI: "floki",
  };

  const ticker =
    clean.toUpperCase();

  return map[ticker] || clean;
}


function selectStrongestCoin(data) {
  if (!Array.isArray(data)) {
    throw new Error(
      "Invalid Binance ticker data"
    );
  }

  const candidates = data
    .filter((item) => {
      const symbol =
        String(item.symbol || "");

      const priceChange =
        safeNumber(item.priceChangePercent);

      if (!symbol.endsWith("USDT")) {
        return false;
      }

      if (symbol.includes("UPUSDT")) {
        return false;
      }

      if (symbol.includes("DOWNUSDT")) {
        return false;
      }

      if (symbol.includes("BULLUSDT")) {
        return false;
      }

      if (symbol.includes("BEARUSDT")) {
        return false;
      }

      if (priceChange <= 0) {
        return false;
      }

      const coinId =
        symbolToCoinId(symbol);

      return COIN_POOL.includes(
        normalizeCoinName(coinId)
      );
    })
    .sort(
      (a, b) =>
        safeNumber(b.priceChangePercent) -
        safeNumber(a.priceChangePercent)
    );

  if (!candidates.length) {
    throw new Error(
      "No suitable coin found"
    );
  }

  const coin = candidates[0];

  return {
    symbol: coin.symbol,
    coinId: symbolToCoinId(
      coin.symbol
    ),
    price: safeNumber(
      coin.lastPrice
    ),
    priceChange24h:
      safeNumber(
        coin.priceChangePercent
      ),
    high24h:
      safeNumber(coin.highPrice),
    low24h:
      safeNumber(coin.lowPrice),
    volume:
      safeNumber(coin.quoteVolume),
    trades:
      safeNumber(coin.count),
  };
}


// ============================================================
// TECHNICAL INDICATORS
// ============================================================

function calculateSMA(values, period) {
  if (
    !Array.isArray(values) ||
    values.length < period
  ) {
    return null;
  }

  const slice =
    values.slice(-period);

  const sum =
    slice.reduce(
      (total, value) =>
        total + safeNumber(value),
      0
    );

  return sum / period;
}


function calculateRSI(
  values,
  period = RSI_PERIOD
) {
  if (
    !Array.isArray(values) ||
    values.length <= period
  ) {
    return null;
  }

  let gains = 0;

  let losses = 0;

  for (
    let i = 1;
    i <= period;
    i++
  ) {
    const difference =
      safeNumber(values[i]) -
      safeNumber(values[i - 1]);

    if (difference > 0) {
      gains += difference;
    } else {
      losses += Math.abs(
        difference
      );
    }
  }

  let averageGain =
    gains / period;

  let averageLoss =
    losses / period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const difference =
      safeNumber(values[i]) -
      safeNumber(values[i - 1]);

    const gain =
      difference > 0
        ? difference
        : 0;

    const loss =
      difference < 0
        ? Math.abs(difference)
        : 0;

    averageGain =
      (averageGain *
        (period - 1) +
        gain) /
      period;

    averageLoss =
      (averageLoss *
        (period - 1) +
        loss) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain /
    averageLoss;

  return 100 - 100 / (1 + rs);
}


async function getTechnicalIndicators(
  symbol
) {
  const klines =
    await getBinanceKlines(
      symbol,
      "1h",
      100
    );

  const closes =
    klines.map(
      (candle) =>
        safeNumber(candle[4])
    );

  const volumes =
    klines.map(
      (candle) =>
        safeNumber(candle[5])
    );

  const currentPrice =
    closes[closes.length - 1];

  const sma9 =
    calculateSMA(
      closes,
      SMA_SHORT
    );

  const sma21 =
    calculateSMA(
      closes,
      SMA_LONG
    );

  const sma50 =
    calculateSMA(
      closes,
      SMA_MEDIUM
    );

  const rsi =
    calculateRSI(
      closes,
      RSI_PERIOD
    );

  const recentVolume =
    calculateSMA(
      volumes,
      20
    );

  const latestVolume =
    volumes[volumes.length - 1];

  let trend = "neutral";

  if (
    sma9 &&
    sma21 &&
    sma50
  ) {
    if (
      currentPrice > sma9 &&
      sma9 > sma21 &&
      sma21 > sma50
    ) {
      trend = "strong bullish";
    } else if (
      currentPrice > sma9 &&
      sma9 > sma21
    ) {
      trend = "bullish";
    } else if (
      currentPrice < sma9 &&
      sma9 < sma21 &&
      sma21 < sma50
    ) {
      trend = "strong bearish";
    } else if (
      currentPrice < sma9 &&
      sma9 < sma21
    ) {
      trend = "bearish";
    }
  }

  let volumeStatus =
    "normal";

  if (
    recentVolume &&
    latestVolume > recentVolume * 1.5
  ) {
    volumeStatus =
      "high";
  } else if (
    recentVolume &&
    latestVolume < recentVolume * 0.7
  ) {
    volumeStatus =
      "low";
  }

  let momentum =
    "neutral";

  if (rsi >= 70) {
    momentum = "overbought";
  } else if (rsi <= 30) {
    momentum = "oversold";
  } else if (rsi >= 55) {
    momentum = "positive";
  } else if (rsi <= 45) {
    momentum = "negative";
  }

  return {
    currentPrice,
    sma9,
    sma21,
    sma50,
    rsi,
    latestVolume,
    averageVolume:
      recentVolume,
    volumeStatus,
    trend,
    momentum,
  };
}


// ============================================================
// GOOGLE NEWS
// ============================================================

async function fetchCoinNews(
  coinName
) {
  try {
    const query =
      encodeURIComponent(
        `${coinName} crypto`
      );

    const url =
      `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;

    const response =
      await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0",
          },
        },
        15000
      );

    if (!response.ok) {
      return [];
    }

    const xml =
      await response.text();

    const items = [];

    const matches =
      xml.match(
        /<item>([\s\S]*?)<\/item>/g
      ) || [];

    for (
      const item of matches.slice(
        0,
        MAX_NEWS
      )
    ) {
      const titleMatch =
        item.match(
          /<title><!\[CDATA\[(.*?)\]\]><\/title>/
        );

      const linkMatch =
        item.match(
          /<link>(.*?)<\/link>/
        );

      const pubDateMatch =
        item.match(
          /<pubDate>(.*?)<\/pubDate>/
        );

      if (
        titleMatch ||
        linkMatch
      ) {
        items.push({
          title:
            titleMatch
              ? titleMatch[1]
              : "",
          link:
            linkMatch
              ? linkMatch[1]
              : "",
          pubDate:
            pubDateMatch
              ? pubDateMatch[1]
              : "",
        });
      }
    }

    return items;
  } catch (error) {
    console.warn(
      "⚠️ News fetch failed:",
      error.message
    );

    return [];
  }
}


// ============================================================
// HASHTAG SANITIZATION
// ============================================================

function sanitizeHashtags(
  hashtags = []
) {
  if (!Array.isArray(hashtags)) {
    return [];
  }

  return hashtags
    .map((tag) =>
      String(tag || "")
        .trim()
        .replace(/^#+/, "")
        .replace(/[^a-zA-Z0-9_]/g, "")
    )
    .filter(Boolean)
    .slice(0, 2)
    .map((tag) => `#${tag}`);
}


function removeInlineHashtags(
  text
) {
  return String(text || "")
    .replace(
      /(^|\s)#[a-zA-Z0-9_]+/g,
      "$1"
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}


// ============================================================
// MYSTERIOUS TITLE GENERATOR
// ============================================================

function generateTitle(
  market,
  indicators
) {
  const coin =
    String(market.coinId || "")
      .toUpperCase();

  const change =
    safeNumber(
      market.priceChange24h
    );

  const rsi =
    safeNumber(
      indicators?.rsi
    );

  const trend =
    indicators?.trend ||
    "neutral";

  // Strong move + overbought
  if (
    change >= 15 &&
    rsi >= 70
  ) {
    return `🚨 $${coin} IS UP ${change.toFixed(
      0
    )}% — BULLISH BREAKOUT OR TRAP? BUY, HOLD OR SELL?`;
  }

  // Strong bullish trend
  if (
    change >= 10 &&
    (
      trend === "bullish" ||
      trend === "strong bullish"
    )
  ) {
    return `🔥 $${coin} IS UP ${change.toFixed(
      0
    )}% — IS THE BREAKOUT REAL? BUY, HOLD OR SELL?`;
  }

  // Large price movement
  if (change >= 5) {
    return `🚨 $${coin} JUST JUMPED ${change.toFixed(
      0
    )}% — WHAT HAPPENS NEXT? BUY, HOLD OR SELL?`;
  }

  // Moderate bullish move
  if (
    change > 0 &&
    rsi >= 55
  ) {
    return `👀 $${coin} IS MOVING UP — IS THIS THE START OF SOMETHING BIG? BUY, HOLD OR SELL?`;
  }

  // Default
  return `⚠️ $${coin} IS SHOWING A BULLISH MOVE — BUT SHOULD YOU BUY, HOLD OR SELL?`;
}


// ============================================================
// OPENING HOOK
// ============================================================

function generateOpening(
  market,
  indicators
) {
  const coin =
    String(market.coinId || "")
      .toUpperCase();

  const change =
    safeNumber(
      market.priceChange24h
    );

  const rsi =
    safeNumber(
      indicators?.rsi
    );

  const trend =
    indicators?.trend ||
    "neutral";

  if (
    change >= 15 &&
    rsi >= 70
  ) {
    return `$${coin} is up ${change.toFixed(
      1
    )}% today, but the RSI is already very high. Is this a real breakout or a move that could cool down soon?`;
  }

  if (
    change >= 10 &&
    (
      trend === "bullish" ||
      trend === "strong bullish"
    )
  ) {
    return `$${coin} is up ${change.toFixed(
      1
    )}% and the trend is clearly bullish. But the big question is: can buyers keep this move alive?`;
  }

  if (change >= 5) {
    return `$${coin} just moved ${change.toFixed(
      1
    )}% higher. The move looks interesting, but is there enough strength behind it to continue?`;
  }

  return `$${coin} is showing a bullish move today. The interesting part is what happens next — can buyers push it higher?`;
}


// ============================================================
// GROQ CONTENT GENERATION
// ============================================================

async function generatePost(
  market,
  indicators,
  news
) {
  if (!groq) {
    throw new Error(
      "Groq client is not configured"
    );
  }

  const title =
    generateTitle(
      market,
      indicators
    );

  const opening =
    generateOpening(
      market,
      indicators
    );

  const newsText =
    news.length
      ? news
          .map(
            (item, index) =>
              `${index + 1}. ${item.title}`
          )
          .join("\n")
      : "No reliable recent news was found.";

  const prompt = `
You are an experienced crypto writer creating a Binance Square post.

The post must feel:
- Interesting
- Mysterious
- Easy to understand
- Human
- Useful
- Not like a boring technical-analysis report

IMPORTANT:
The title is already generated.
DO NOT create another title.
DO NOT repeat the title inside the body.

TITLE:
${title}

OPENING IDEA:
${opening}

COIN:
$${String(
    market.coinId || ""
  ).toUpperCase()}

24H PRICE CHANGE:
${formatPercent(
    market.priceChange24h
  )}

CURRENT PRICE:
${formatPrice(
    market.price
  )}

24H HIGH:
${formatPrice(
    market.high24h
  )}

24H LOW:
${formatPrice(
    market.low24h
  )}

24H VOLUME:
${formatVolume(
    market.volume
  )}

SMA 9:
${formatPrice(
    indicators.sma9
  )}

SMA 21:
${formatPrice(
    indicators.sma21
  )}

SMA 50:
${formatPrice(
    indicators.sma50
  )}

RSI:
${safeNumber(
    indicators.rsi
  ).toFixed(1)}

TREND:
${indicators.trend}

MOMENTUM:
${indicators.momentum}

VOLUME:
${indicators.volumeStatus}

RECENT NEWS:
${newsText}

WRITE THE POST USING THIS STRUCTURE:

1. HOOK
Start immediately with the coin's move and the main mystery.
The first 1–2 lines should make the reader want to continue.

2. WHY
Explain simply why the coin is bullish, bearish, or uncertain.
Use the SMA 9, SMA 21, SMA 50, RSI and volume naturally.
Do not dump technical indicators like a report.

3. NEWS / TOPIC
If useful news exists, explain:
- What happened?
- Why does it matter?
- Could it affect the coin?
- What should traders watch next?

Do NOT invent news.

4. WHAT TO DO NOW
Clearly choose ONE:
BUY
HOLD
SELL

If the signals conflict or confidence is low, choose HOLD.

5. KEY LEVELS
Give a realistic target and invalidation level based on the available data.
Do not promise profits.

6. END WITH A QUESTION
End with a simple question that encourages comments.
Vary the question naturally.

STYLE RULES:
- A2-B1 English.
- Short sentences.
- Easy for international readers.
- Sound like a smart human, not an AI report.
- Use emojis naturally, but do not overuse them.
- No fake urgency.
- No guaranteed profits.
- No financial guarantees.
- Do not say "100%".
- Do not repeat the same sentence.
- No inline hashtags.
- Maximum 2 hashtags at the end.
- 500–900 characters for the main body.
- Aim around 650–850 characters.
- Do not mention these instructions.
- Do not mention "AI".
- Do not use markdown tables.

IMPORTANT:
The opening should NOT sound like:
"According to technical analysis..."
"Based on the indicators..."
"Let's analyze..."

Instead, make it feel like:
"$COIN just moved X%... but something is not adding up."

Return JSON ONLY:

{
  "content": "main post without title",
  "action": "BUY/HOLD/SELL",
  "target": "target price",
  "invalidation": "invalidation price",
  "hashtags": ["#Crypto", "#CoinName"],
  "newsUsed": true
}
`;

  const completion =
    await groq.chat.completions.create({
      model:
        "openai/gpt-oss-120b",
      temperature: 0.85,
      max_tokens: 1200,
      messages: [
        {
          role: "system",
          content:
            "You write concise, engaging crypto posts for Binance Square. Return valid JSON only.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

  const raw =
    completion?.choices?.[0]?.message?.content ||
    "";

  return {
    title,
    opening,
    raw,
  };
}


// ============================================================
// NORMALIZE AI RESPONSE
// ============================================================

function extractJson(text) {
  const cleaned =
    String(text || "")
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/i, "")
      .replace(/```$/i, "")
      .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start =
      cleaned.indexOf("{");

    const end =
      cleaned.lastIndexOf("}");

    if (
      start !== -1 &&
      end !== -1 &&
      end > start
    ) {
      try {
        return JSON.parse(
          cleaned.slice(
            start,
            end + 1
          )
        );
      } catch {
        return null;
      }
    }

    return null;
  }
}


function normalizePost(
  aiResult,
  market,
  indicators
) {
  const parsed =
    extractJson(
      aiResult.raw
    );

  if (!parsed) {
    throw new Error(
      "Groq returned invalid JSON"
    );
  }

  let content =
    cleanText(
      parsed.content
    );

  const title =
    aiResult.title;

  // Remove accidental duplicate title.
  if (
    content
      .toLowerCase()
      .startsWith(
        title.toLowerCase()
      )
  ) {
    content =
      content
        .slice(title.length)
        .trim();
  }

  content =
    removeInlineHashtags(
      content
    );

  let action =
    String(
      parsed.action || "HOLD"
    )
      .toUpperCase()
      .trim();

  if (
    !["BUY", "HOLD", "SELL"].includes(
      action
    )
  ) {
    action = "HOLD";
  }

  let target =
    cleanText(
      parsed.target
    );

  let invalidation =
    cleanText(
      parsed.invalidation
    );

  if (!target) {
    target =
      formatPrice(
        market.price *
          (1 +
            Math.max(
              0.03,
              Math.abs(
                market.priceChange24h
              ) / 100 *
                0.5
            ))
      );
  }

  if (!invalidation) {
    invalidation =
      formatPrice(
        market.price * 0.95
      );
  }

  let hashtags =
    sanitizeHashtags(
      parsed.hashtags
    );

  if (!hashtags.length) {
    hashtags = [
      "#Crypto",
      `#${String(
        market.coinId || "Crypto"
      )
        .replace(
          /[^a-zA-Z0-9]/g,
          ""
        )
        .slice(0, 20)}`,
    ];
  }

  return {
    title,
    content,
    action,
    target,
    invalidation,
    hashtags,
    newsUsed:
      Boolean(
        parsed.newsUsed
      ),
    rsi:
      indicators.rsi,
  };
}


// ============================================================
// FINAL CONTENT
// ============================================================

function buildFinalContent(
  post
) {
  const actionEmoji = {
    BUY: "🟢",
    HOLD: "🟡",
    SELL: "🔴",
  };

  const emoji =
    actionEmoji[
      post.action
    ] || "🟡";

  const finalText = [
    post.title,
    "",
    post.content,
    "",
    `${emoji} ACTION: ${post.action}`,
    `🎯 Target: ${post.target}`,
    `⚠️ Invalidation: ${post.invalidation}`,
    "",
    post.hashtags.join(" "),
  ]
    .join("\n")
    .trim();

  return finalText;
}


// ============================================================
// VALIDATE POST
// ============================================================

function validatePost(
  content
) {
  const text =
    String(content || "");

  const length =
    text.length;

  if (length < 500) {
    console.warn(
      `⚠️ Post is short: ${length} characters`
    );
  }

  if (length > 900) {
    console.warn(
      `⚠️ Post is long: ${length} characters`
    );
  }

  if (length > MAX_POST_LENGTH) {
    return {
      valid: false,
      reason:
        `Post exceeds maximum length of ${MAX_POST_LENGTH}`,
    };
  }

  return {
    valid: true,
    reason: null,
  };
}


// ============================================================
// CLOUDFLARE IMAGE GENERATION
// ============================================================

async function generateTradingGraphic(
  market,
  indicators
) {
  if (
    !CLOUDFLARE_ACCOUNT_ID ||
    !CLOUDFLARE_API_TOKEN
  ) {
    console.warn(
      "⚠️ Cloudflare AI credentials missing. Skipping image."
    );

    return null;
  }

  const coin =
    String(
      market.coinId || ""
    ).toUpperCase();

  const change =
    safeNumber(
      market.priceChange24h
    );

  const trend =
    indicators?.trend ||
    "neutral";

  const imagePrompt = `
Create a premium crypto trading graphic for Binance Square.

Coin: $${coin}
24h movement: ${change.toFixed(2)}%
Trend: ${trend}

Style:
- Modern crypto finance visual
- Dark futuristic background
- Strong professional trading atmosphere
- Glowing candlestick/chart elements
- Large readable "$${coin}"
- Show the ${change >= 0 ? "bullish" : "bearish"} movement visually
- Mysterious and exciting
- Clean composition
- No fake logos
- No unnecessary text
- No people
- Square social media format
`;

  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`;

  try {
    const response =
      await fetchWithTimeout(
        endpoint,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            prompt: imagePrompt,
          }),
        },
        IMAGE_TIMEOUT
      );

    if (!response.ok) {
      const errorText =
        await response.text();

      throw new Error(
        `Cloudflare image error ${response.status}: ${errorText}`
      );
    }

    const contentType =
      response.headers.get(
        "content-type"
      ) || "";

    if (
      contentType.includes(
        "application/json"
      )
    ) {
      const data =
        await response.json();

      if (
        data?.result?.image
      ) {
        return data.result.image;
      }

      return null;
    }

    const arrayBuffer =
      await response.arrayBuffer();

    return Buffer.from(
      arrayBuffer
    );
  } catch (error) {
    console.warn(
      "⚠️ Image generation failed:",
      error.message
    );

    return null;
  }
}


// ============================================================
// BINANCE SQUARE PUBLISH
// ============================================================

async function publishToBinanceSquare(
  content,
  image = null
) {
  if (!BINANCE_SQUARE_URL) {
    throw new Error(
      "BINANCE_SQUARE_URL is missing"
    );
  }

  const headers = {
    Accept: "application/json",
    "Content-Type":
      "application/json",
    "User-Agent":
      "Mozilla/5.0 Binance-Square-AI-Bot",
  };

  if (BINANCE_API_KEY) {
    headers["X-MBX-APIKEY"] =
      BINANCE_API_KEY;
  }

  if (BINANCE_COOKIE) {
    headers.Cookie =
      BINANCE_COOKIE;
  }

  const payload = {
    content,
  };

  if (image) {
    if (Buffer.isBuffer(image)) {
      payload.image =
        image.toString(
          "base64"
        );
    } else {
      payload.image = image;
    }
  }

  const response =
    await fetchWithTimeout(
      BINANCE_SQUARE_URL,
      {
        method: "POST",
        headers,
        body: JSON.stringify(
          payload
        ),
      },
      HTTP_TIMEOUT
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Binance Square publish failed: ${response.status} ${text}`
    );
  }

  return data;
}


// ============================================================
// POST LIMIT / COOLDOWN
// ============================================================

function canPost() {
  const now =
    Date.now();

  if (
    now - lastPostTime <
    MIN_POST_INTERVAL
  ) {
    return false;
  }

  return true;
}


// ============================================================
// MAIN BOT CYCLE
// ============================================================

async function runBotCycle() {
  if (cycleRunning) {
    console.log(
      "⏳ Cycle already running."
    );

    return;
  }

  cycleRunning = true;

  try {
    console.log(
      "\n============================================================"
    );

    console.log(
      `🚀 ${APP_NAME} ${VERSION}`
    );

    console.log(
      "🔍 Starting market scan..."
    );

    console.log(
      "============================================================"
    );

    if (!canPost()) {
      const remaining =
        MIN_POST_INTERVAL -
        (Date.now() -
          lastPostTime);

      console.log(
        `⏳ Cooldown active. ${Math.ceil(
          remaining / 60000
        )} minutes remaining.`
      );

      return;
    }

    // --------------------------------------------------------
    // MARKET DATA
    // --------------------------------------------------------

    const marketData =
      await getBinance24hrData();

    const market =
      selectStrongestCoin(
        marketData
      );

    currentCoin =
      market.coinId;

    console.log(
      `🔥 Strongest coin: $${market.coinId.toUpperCase()}`
    );

    console.log(
      `📈 24h movement: ${formatPercent(
        market.priceChange24h
      )}`
    );

    console.log(
      `💰 Price: ${formatPrice(
        market.price
      )}`
    );

    // --------------------------------------------------------
    // TECHNICAL ANALYSIS
    // --------------------------------------------------------

    const indicators =
      await getTechnicalIndicators(
        market.symbol
      );

    console.log(
      `📊 Trend: ${indicators.trend}`
    );

    console.log(
      `📊 RSI: ${safeNumber(
        indicators.rsi
      ).toFixed(1)}`
    );

    console.log(
      `📊 Volume: ${indicators.volumeStatus}`
    );

    // --------------------------------------------------------
    // NEWS
    // --------------------------------------------------------

    const news =
      await fetchCoinNews(
        market.coinId
      );

    console.log(
      `📰 News items found: ${news.length}`
    );

    // --------------------------------------------------------
    // AI CONTENT
    // --------------------------------------------------------

    console.log(
      "🤖 Generating mysterious AI post..."
    );

    const aiResult =
      await generatePost(
        market,
        indicators,
        news
      );

    const post =
      normalizePost(
        aiResult,
        market,
        indicators
      );

    const finalContent =
      buildFinalContent(
        post
      );

    // --------------------------------------------------------
    // VALIDATION
    // --------------------------------------------------------

    const validation =
      validatePost(
        finalContent
      );

    if (!validation.valid) {
      throw new Error(
        validation.reason
      );
    }

    console.log(
      "\n---------------- GENERATED POST ----------------"
    );

    console.log(
      finalContent
    );

    console.log(
      "-------------------------------------------------\n"
    );

    // --------------------------------------------------------
    // IMAGE
    // --------------------------------------------------------

    console.log(
      "🎨 Generating trading graphic..."
    );

    const image =
      await generateTradingGraphic(
        market,
        indicators
      );

    if (image) {
      console.log(
        "✅ Trading graphic generated."
      );
    } else {
      console.log(
        "ℹ️ No image generated."
      );
    }

    // --------------------------------------------------------
    // PUBLISH
    // --------------------------------------------------------

    console.log(
      "📤 Publishing to Binance Square..."
    );

    const result =
      await publishToBinanceSquare(
        finalContent,
        image
      );

    console.log(
      "✅ Published successfully."
    );

    // --------------------------------------------------------
    // SAVE STATE
    // --------------------------------------------------------

    lastPostTime =
      Date.now();

    totalPosts++;

    lastPost = {
      coin:
        market.coinId,
      symbol:
        market.symbol,
      action:
        post.action,
      title:
        post.title,
      content:
        finalContent,
      target:
        post.target,
      invalidation:
        post.invalidation,
      price:
        market.price,
      change24h:
        market.priceChange24h,
      rsi:
        indicators.rsi,
      trend:
        indicators.trend,
      timestamp:
        new Date().toISOString(),
      result,
    };

    rememberPost({
      coin:
        market.coinId,
      symbol:
        market.symbol,
      action:
        post.action,
      price:
        market.price,
      change24h:
        market.priceChange24h,
      rsi:
        indicators.rsi,
      trend:
        indicators.trend,
      title:
        post.title,
    });

    console.log(
      `📊 Total posts: ${totalPosts}`
    );
  } catch (error) {
    totalErrors++;

    console.error(
      "\n❌ BOT CYCLE ERROR:"
    );

    console.error(
      error?.message ||
        error
    );
  } finally {
    cycleRunning = false;
  }
}


// ============================================================
// BOT INITIALIZATION
// ============================================================

async function initBot() {
  console.log(
    "\n============================================================"
  );

  console.log(
    `🚀 ${APP_NAME} ${VERSION}`
  );

  console.log(
    "============================================================"
  );

  await connectMongoDB();

  isRunning = true;

  console.log(
    "✅ Bot initialized."
  );

  console.log(
    `⏰ Post interval: ${POST_INTERVAL / 3600000} hours`
  );

  // Run immediately
  await runBotCycle();

  // Schedule future cycles
  setInterval(
    async () => {
      if (!isRunning) {
        return;
      }

      await runBotCycle();
    },
    POST_INTERVAL
  );
}


// ============================================================
// EXPRESS SERVER
// ============================================================

const app =
  express();

app.use(
  express.json({
    limit: "10mb",
  })
);


// ============================================================
// HEALTH CHECK
// ============================================================

app.get(
  "/",
  (req, res) => {
    res.json({
      status: "online",
      bot:
        APP_NAME,
      version:
        VERSION,
      running:
        isRunning,
      cycleRunning,
        cycleRunning,
      currentCoin,
      totalPosts,
      totalErrors,
      lastPostTime:
        lastPostTime
          ? new Date(
              lastPostTime
            ).toISOString()
          : null,
    });
  }
);


// ============================================================
// STATUS
// ============================================================

app.get(
  "/status",
  (req, res) => {
    res.json({
      status: "online",
      version:
        VERSION,
      running:
        isRunning,
      cycleRunning,
      currentCoin,
      totalPosts,
      totalErrors,
      lastPost,
    });
  }
);


// ============================================================
// MANUAL LINKEDIN ENDPOINT
// ============================================================

app.post(
  "/post",
  async (req, res) => {
    try {
      await runBotCycle();

      res.json({
        success: true,
        message:
          "Bot cycle completed.",
        lastPost,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);


// ============================================================
// BINANCE POST ENDPOINT
// ============================================================

app.post(
  "/binance/post",
  async (req, res) => {
    try {
      await runBotCycle();

      res.json({
        success: true,
        lastPost,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);


// ============================================================
// LINKEDIN ALIAS
// ============================================================

app.post(
  "/linkedin/post",
  async (req, res) => {
    try {
      await runBotCycle();

      res.json({
        success: true,
        lastPost,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error:
          error.message,
      });
    }
  }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {
    console.log(
      `🌐 Server running on port ${PORT}`
    );

    console.log(
      `🚀 ${APP_NAME} ${VERSION}`
    );

    initBot().catch(
      (error) => {
        console.error(
          "❌ Bot initialization failed:",
          error
        );
      }
    );
  }
);


// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {
  console.log(
    `\n🛑 Received ${signal}. Shutting down...`
  );

  isRunning = false;

  try {
    await mongoose.connection.close();

    console.log(
      "✅ MongoDB connection closed."
    );
  } catch {
    // Ignore shutdown errors
  }

  process.exit(0);
}


process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);


// ============================================================
// GLOBAL ERROR HANDLERS
// ============================================================

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "❌ Unhandled rejection:",
      reason
    );
  }
);


process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "❌ Uncaught exception:",
      error
    );
  }
);


// ============================================================
// EXPORTS
// ============================================================

export {
  runBotCycle,
  generatePost,
  generateTitle,
  generateOpening,
  getTechnicalIndicators,
  selectStrongestCoin,
};
