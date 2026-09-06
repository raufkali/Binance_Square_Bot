// ============================================================
// BINANCE SQUARE AI BOT V11.1.0
//
// FIXES / IMPROVEMENTS:
// - Removed broken Git merge-conflict markers
// - Fixed undefined prompt variables
// - Deterministic market-data-driven title
// - Title format:
//   "$COIN is X% bullish today — BUY, HOLD or SELL?"
// - Honest title variations based on real 24h movement
// - Beginner-friendly A2/simple English
// - 500-900 character target for content
// - Content starts with coin + 24h movement + BUY/HOLD/SELL
// - AI cannot generate inline hashtags
// - MAX 2 hashtags enforced everywhere
// - Title stored separately in MongoDB
// - Strong final hashtag sanitization
// - Target/invalidation validation
// - Safer Groq JSON normalization
// - Safer Cloudflare image generation
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
import http from "http";

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
} = process.env;

// ============================================================
// VALIDATE ENVIRONMENT
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

const BINANCE_API = "https://api.binance.com";

// Technical indicators
const SMA_SHORT = 9;
const SMA_LONG = 21;
const SMA_MEDIUM = 50;
const RSI_PERIOD = 14;

// Binance Square safety
// IMPORTANT: keep this at 2.
const MAX_HASHTAGS = 2;

// Content target
const MIN_CONTENT_CHARS = 500;
const MAX_CONTENT_CHARS = 900;

// ============================================================
// STATE
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
// HTTP FETCH WITH TIMEOUT
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
  if (!db) return;

  try {
    await db.collection("post_history").insertOne({
      ...record,
      createdAt: new Date(),
    });

    // Keep recent history only.
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
  const url = `${BINANCE_API}/api/v3/ticker/24hr`;

  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`Binance ticker API failed: ${response.status}`);
  }

  return response.json();
}

async function fetchKlines(symbol) {
  const url =
    `${BINANCE_API}/api/v3/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=1h` +
    `&limit=100`;

  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(
      `Binance klines API failed for ${symbol}: ${response.status}`,
    );
  }

  return response.json();
}

// ============================================================
// SELECT STRONGEST COIN
// ============================================================

async function selectStrongestCoin() {
  console.log("🔎 Scanning Binance USDT markets...");

  const tickers = await fetch24hTickers();

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
    `🏆 Selected ${coin} | ` +
      `24h: ${formatPercent(selected.priceChangePercent)}% | ` +
      `Volume: $${Number(selected.quoteVolume).toLocaleString()}`,
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
    `SMA9=${round(sma9, 6)} | ` +
      `SMA21=${round(sma21, 6)} | ` +
      `SMA50=${round(sma50, 6)} | ` +
      `RSI=${round(rsi, 2)} | ` +
      `Trend=${trend}`,
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
// TITLE GENERATOR
//
// IMPORTANT:
// The title is generated locally from REAL market data.
// This prevents Groq from changing the percentage,
// coin name, or BUY/HOLD/SELL wording.
// ============================================================

function generateTitle(market) {
  const coin = market.coin;

  const change = safeNumber(market.priceChange24h);

  const percentage = formatPercent(change);

  // Strong positive move
  if (change >= 10) {
    return `🚨 $${coin} IS ${percentage}% BULLISH TODAY — BUY, HOLD OR SELL?`;
  }

  // Moderate positive move
  if (change > 1) {
    return `📈 $${coin} IS ${percentage}% UP TODAY — BUY, HOLD OR SELL?`;
  }

  // Nearly flat
  if (change >= -1 && change <= 1) {
    return `⚠️ $${coin} IS AT A CRITICAL LEVEL — BUY, HOLD OR SELL?`;
  }

  // Negative move
  return `🔻 $${coin} IS ${percentage}% DOWN TODAY — BUY, HOLD OR SELL?`;
}

// ============================================================
// CONTENT OPENING GENERATOR
//
// Gives Groq a guaranteed structure for the first lines.
// ============================================================

function generateOpening(market) {
  const coin = market.coin;

  const change = safeNumber(market.priceChange24h);

  const percentage = formatPercent(Math.abs(change));

  if (change > 1) {
    return `$${coin} is ${percentage}% up today. The big question is simple: BUY, HOLD or SELL?`;
  }

  if (change < -1) {
    return `$${coin} is ${percentage}% down today. The big question is simple: BUY, HOLD or SELL?`;
  }

  return `$${coin} is moving around a key level today. The big question is simple: BUY, HOLD or SELL?`;
}

// ============================================================
// FINAL CONTENT BUILDER
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
// GROQ POST GENERATION
// ============================================================

async function generatePost({ market, indicators, news }) {
  console.log("🤖 Generating AI market analysis...");

  const title = generateTitle(market);

  const opening = generateOpening(market);

  const newsText = news.length
    ? news.map((item, index) => `${index + 1}. ${item.title}`).join("\n")
    : "No recent reliable news available.";

  const prompt = `
You are an expert crypto market analyst writing a Binance Square post.

The reader is a normal crypto user, not a professional trader.

Your job is to explain the market clearly using simple English.

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
REQUIRED TITLE
============================================================

The title has already been generated from real market data.

TITLE:
${title}

Do NOT create another title.

Do NOT change the title.

============================================================
REQUIRED FIRST LINE IDEA
============================================================

The post must begin with this idea:

${opening}

The first 1-2 lines must immediately tell the reader:

1. Which coin we are discussing.
2. How much it moved today or that it is at a key level.
3. The main question: BUY, HOLD or SELL?

============================================================
CONTENT STYLE
============================================================

Use very simple English.

Aim for A2-B1 level English.

Write like:

"An experienced trader explaining the market to a normal person."

Do NOT sound like a textbook.

Do NOT use complicated English.

Do NOT use unnecessary technical jargon.

If you use a trading term, explain it simply.

Use short paragraphs.

Keep the tone professional but easy to read.

Do not create fake urgency.

Do not promise profit.

Do not claim certainty.

Do not say:
- guaranteed
- guaranteed profit
- can't lose
- risk-free
- 100% sure
- easy money

============================================================
EXPLAIN THESE POINTS
============================================================

1. What happened to ${market.coin} during the last 24 hours.

2. Why the coin may be moving.

3. What SMA 9 shows in simple language.

4. What SMA 21 shows in simple language.

5. What RSI shows.

6. Explain whether RSI suggests:
   - normal momentum
   - strong momentum
   - overbought
   - oversold

7. Mention the latest relevant news only if it appears useful and reliable.

8. Explain what could happen next.

9. Choose one action:
   BUY
   HOLD
   SELL

10. Give a realistic target price.

11. Give an invalidation price.

12. End with a simple question that encourages comments.

============================================================
TRADING LOGIC
============================================================

Do not choose BUY only because the coin is green.

Do not choose SELL only because the coin is red.

Consider together:

- 24h movement
- SMA 9
- SMA 21
- SMA 50
- RSI
- overall trend
- recent news

If the signals are mixed, HOLD is acceptable.

Targets and invalidation levels must be realistic relative to the current price.

Do not invent extreme targets.

============================================================
CONTENT LENGTH
============================================================

The body content should be approximately:

500-900 characters.

Do not make it extremely short.

Do not make it unnecessarily long.

============================================================
HASHTAGS
============================================================

Return at most TWO hashtags.

Do not put hashtags inside the content.

Use relevant hashtags such as:

#${market.coin}
#CryptoAnalysis

============================================================
NEWS
============================================================

${newsText}

============================================================
OUTPUT
============================================================

Return ONLY valid JSON.

Use exactly this structure:

{
  "content": "complete Binance Square body",
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

- Do not include the title in content.
- Do not create a title.
- Do not use hashtags inside content.
- Return at most 2 hashtags.
- Use the real market data.
- Never promise profit.
- Never claim certainty.
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
          "You are a professional crypto market analyst. Return only valid JSON. Use simple beginner-friendly English.",
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

  // Remove accidental title duplication.
  if (content.toLowerCase().startsWith(title.toLowerCase())) {
    content = content.slice(title.length).trim();
  }

  content = removeInlineHashtags(content);

  const hashtags = sanitizeHashtags(post.hashtags, market.coin);

  let targetPrice = safeNumber(post.targetPrice);

  let invalidationPrice = safeNumber(post.invalidationPrice);

  // ----------------------------------------------------------
  // Safety fallback for invalid AI prices
  // ----------------------------------------------------------

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

    // ------------------------------------------------------
    // FINAL DEFENSIVE HASHTAG CLEANUP
    // ------------------------------------------------------

    const cleanContent = removeInlineHashtags(content);

    // ------------------------------------------------------
    // Remove ALL hashtags from content
    // ------------------------------------------------------

    const contentWithoutHashtags = cleanContent
      .replace(/(^|\s)#[A-Za-z0-9_]+/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    // ------------------------------------------------------
    // ALWAYS use controlled hashtags.
    //
    // We don't trust AI hashtags at publication time.
    // ------------------------------------------------------

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
    // --------------------------------------------------------
    // 1. SELECT COIN
    // --------------------------------------------------------

    market = await selectStrongestCoin();

    // --------------------------------------------------------
    // 2. TECHNICAL ANALYSIS
    // --------------------------------------------------------

    indicators = await calculateIndicators(market.symbol);

    // --------------------------------------------------------
    // 3. NEWS
    // --------------------------------------------------------

    news = await fetchCoinNews(market.coin);

    // --------------------------------------------------------
    // 4. AI POST
    // --------------------------------------------------------

    post = await generatePost({
      market,
      indicators,
      news,
    });

    // --------------------------------------------------------
    // 5. VALIDATION
    // --------------------------------------------------------

    const validation = validatePost(post);

    if (!validation.valid) {
      console.log("⚠️ Content validation warnings:");

      for (const warning of validation.warnings) {
        console.log(`   - ${warning}`);
      }
    } else {
      console.log("✅ Content validation passed.");
    }

    // --------------------------------------------------------
    // 6. BUILD FINAL CONTENT
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // 7. IMAGE
    // --------------------------------------------------------

    imagePath = await generateTradingGraphic({
      market,
      indicators,
      post,
    });

    // --------------------------------------------------------
    // 8. DRY RUN
    // --------------------------------------------------------

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

    // --------------------------------------------------------
    // 9. PUBLISH
    // --------------------------------------------------------

    const publication = await publishToBinanceSquare(
      finalContent,
      imagePath,
      market.coin,
    );

    // --------------------------------------------------------
    // 10. UPDATE STATE
    // --------------------------------------------------------

    state.postsToday += 1;

    state.totalPosts += 1;

    state.lastCoin = market.coin;

    state.lastPostAt = new Date().toISOString();

    state.lastPostDate = getDateKey();

    await saveState();

    // --------------------------------------------------------
    // 11. SAVE HISTORY
    // --------------------------------------------------------

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
    };
  }
}

// ============================================================
// HTTP SERVER
// ============================================================

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer(async (req, res) => {
  // ------------------------------------------------------
  // CORS
  // ------------------------------------------------------

  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Post-Secret",
  );

  // ------------------------------------------------------
  // OPTIONS
  // ------------------------------------------------------

  if (req.method === "OPTIONS") {
    res.writeHead(204);

    res.end();

    return;
  }

  // ------------------------------------------------------
  // GET /
  // ------------------------------------------------------

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        success: true,

        service: "Binance Square AI Bot",

        version: "11.1.0",

        status: "online",

        postsToday: state.postsToday,

        maxPostsPerDay: Number(MAX_POSTS_PER_DAY),

        totalPosts: state.totalPosts,

        totalFailures: state.totalFailures,

        hashtagLimit: MAX_HASHTAGS,

        timezone: BOT_TIMEZONE,

        contentTarget: `${MIN_CONTENT_CHARS}-${MAX_CONTENT_CHARS} characters`,
      }),
    );

    return;
  }

  // ------------------------------------------------------
  // GET /health
  // ------------------------------------------------------

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        success: true,
        status: "healthy",
        timestamp: new Date().toISOString(),
      }),
    );

    return;
  }

  // ------------------------------------------------------
  // POST /post
  // POST /binance/post
  // ------------------------------------------------------

  if (
    req.method === "POST" &&
    (req.url === "/post" || req.url === "/binance/post")
  ) {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      try {
        let parsed = {};

        if (body.trim()) {
          try {
            parsed = JSON.parse(body);
          } catch {
            parsed = {};
          }
        }

        const providedSecret =
          req.headers["x-post-secret"] ||
          req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
          parsed.secret;

        if (providedSecret !== POST_TRIGGER_SECRET) {
          res.writeHead(401, {
            "Content-Type": "application/json",
          });

          res.end(
            JSON.stringify({
              success: false,

              error: "Unauthorized",
            }),
          );

          return;
        }

        const result = await runCycle();

        res.writeHead(result.success ? 200 : 500, {
          "Content-Type": "application/json",
        });

        res.end(JSON.stringify(result, null, 2));
      } catch (error) {
        res.writeHead(500, {
          "Content-Type": "application/json",
        });

        res.end(
          JSON.stringify({
            success: false,

            error: error.message,
          }),
        );
      }
    });

    return;
  }

  // ------------------------------------------------------
  // 404
  // ------------------------------------------------------

  res.writeHead(404, {
    "Content-Type": "application/json",
  });

  res.end(
    JSON.stringify({
      success: false,
      error: "Not found",
    }),
  );
});

// ============================================================
// STARTUP
// ============================================================

async function start() {
  console.log("\n============================================================");

  console.log("🤖 BINANCE SQUARE AI BOT V11.1.0");

  console.log("============================================================");

  console.log(`🌎 Timezone: ${BOT_TIMEZONE}`);

  console.log(`🏷️ Max hashtags: ${MAX_HASHTAGS}`);

  console.log(
    `📝 Content target: ${MIN_CONTENT_CHARS}-${MAX_CONTENT_CHARS} chars`,
  );

  console.log(`🤖 Groq model: ${GROQ_MODEL}`);

  console.log(`🎨 Cloudflare model: ${CLOUDFLARE_IMAGE_MODEL}`);

  try {
    await loadState();

    await connectMongo();

    server.listen(PORT, () => {
      console.log(`🌐 Server running on port ${PORT}`);

      console.log(`📡 POST endpoint: /post`);

      console.log(`📡 POST endpoint: /binance/post`);

      console.log(`❤️ Health endpoint: /health`);

      console.log(
        `📊 Current posts today: ${state.postsToday}/${MAX_POSTS_PER_DAY}`,
      );
    });
  } catch (error) {
    console.error("❌ Startup failed:", error);

    process.exit(1);
  }
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Shutting down...`);

  try {
    server.close();

    if (mongoClient) {
      await mongoClient.close();

      console.log("🍃 MongoDB connection closed.");
    }
  } catch (error) {
    console.error("⚠️ Shutdown error:", error.message);
  }

  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// START
// ============================================================

start();
