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
=========================================================

STRATEGY

1. Scan Binance USDT markets
2. Find the strongest liquid coin over 24h
3. Fetch coin-specific news
4. Calculate:
   - 24h momentum
   - SMA 9
   - SMA 21
   - RSI 14
5. Determine market bias
6. Ask Groq to analyze the setup
7. Generate:
   - Strong title
   - BUY / HOLD / SELL conclusion
   - Evidence-based explanation
   - Price target / invalidation
   - Relevant hashtags
8. Generate a high-impact trading graphic
9. Publish to Binance Square
10. Store result in MongoDB

LinkedIn has been completely removed.
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

const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;

const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

const CLOUDFLARE_IMAGE_MODEL =
  process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";

const GENERATED_IMAGE_DIR = path.join(__dirname, "generated-images");

const SQUARE_IMAGE_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-image.mjs",
);

const MAX_POSTS_PER_DAY = parsePositiveInteger(
  process.env.MAX_POSTS_PER_DAY,
  12,
);

const MAX_HISTORY = parsePositiveInteger(process.env.MAX_HISTORY, 200);

const REQUEST_TIMEOUT_MS = parsePositiveInteger(
  process.env.REQUEST_TIMEOUT_MS,
  30000,
);

const GENERATION_MAX_TOKENS = parsePositiveInteger(
  process.env.GENERATION_MAX_TOKENS,
  1800,
);

const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

const BOT_TIMEZONE = process.env.BOT_TIMEZONE || "Asia/Karachi";

const MIN_24H_VOLUME_USDT = Number(process.env.MIN_24H_VOLUME_USDT || 500000);

const MAX_SCAN_COINS = parsePositiveInteger(process.env.MAX_SCAN_COINS, 50);

const NEWS_ITEMS = parsePositiveInteger(process.env.NEWS_ITEMS, 15);

const SMA_SHORT = 9;
const SMA_LONG = 21;
const RSI_PERIOD = 14;

/* =======================================================
   VALIDATION
======================================================= */

if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY is missing.");

if (!BINANCE_SQUARE_OPENAPI_KEY)
  throw new Error("BINANCE_SQUARE_OPENAPI_KEY is missing.");

if (!POST_TRIGGER_SECRET) throw new Error("POST_TRIGGER_SECRET is missing.");

if (!MONGODB_URI) throw new Error("MONGODB_URI is missing.");

if (!CLOUDFLARE_ACCOUNT_ID)
  throw new Error("CLOUDFLARE_ACCOUNT_ID is missing.");

if (!CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is missing.");

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

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [array[i], array[j]] = [array[j], array[i]];
  }

  return array;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* =======================================================
   MONGODB
======================================================= */

let mongoClient = null;
let db = null;

let postHistoryCollection = null;
let newsCollection = null;

let initialized = false;

async function connectMongo() {
  if (mongoClient) return;

  mongoClient = new MongoClient(MONGODB_URI, {
    maxPoolSize: 5,
  });

  await mongoClient.connect();

  db = mongoClient.db(MONGODB_DB_NAME);

  postHistoryCollection = db.collection("post_history");

  newsCollection = db.collection("coin_news");

  await postHistoryCollection.createIndex({
    publishedAt: -1,
  });

  await newsCollection.createIndex({
    fetchedAt: -1,
  });

  console.log("💾 [Binance] MongoDB connected.");
}

async function disconnectMongo() {
  try {
    if (mongoClient) {
      await mongoClient.close();
    }

    mongoClient = null;
    db = null;

    postHistoryCollection = null;
    newsCollection = null;

    console.log("💾 [Binance] MongoDB disconnected.");
  } catch (error) {
    console.warn("⚠️ MongoDB close warning:", error.message);
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

      await fs.writeFile(tempFile, JSON.stringify(state, null, 2), "utf8");

      try {
        await fs.copyFile(STATE_FILE, STATE_BACKUP_FILE);
      } catch {}

      await fs.rename(tempFile, STATE_FILE);
    });

  return stateSaveRunning;
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

      console.log("💾 State loaded.");
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
      console.log("ℹ️ No existing state.");
    }
  }

  normalizeState();

  const today = getLocalDate();

  if (state.date !== today) {
    state.date = today;
    state.postsToday = 0;
  }

  if (!loaded) {
    await saveState();
  }
}

/* =======================================================
   FETCH
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
   MARKET DATA
======================================================= */

/*
Find the strongest liquid coin in the
last 24 hours.

We don't simply pick a random coin.

Ranking considers:

- 24h percentage gain
- trading volume
- liquidity
- recent momentum
*/

async function getBest24hCoin() {
  console.log("\n📊 Scanning Binance 24h market...");

  const response = await fetchWithTimeout(
    "https://api.binance.com/api/v3/ticker/24hr",
    {},
    15000,
  );

  if (!response.ok) {
    throw new Error(`Binance ticker HTTP ${response.status}`);
  }

  const tickers = await response.json();

  const stablecoins = new Set([
    "USDCUSDT",
    "FDUSDUSDT",
    "TUSDUSDT",
    "DAIUSDT",
    "USDPUSDT",
    "BUSDUSDT",
  ]);

  const candidates = tickers
    .filter((ticker) => {
      if (!ticker.symbol.endsWith("USDT")) {
        return false;
      }

      if (stablecoins.has(ticker.symbol)) {
        return false;
      }

      const volume = Number(ticker.quoteVolume);

      const change = Number(ticker.priceChangePercent);

      const price = Number(ticker.lastPrice);

      return (
        Number.isFinite(volume) &&
        Number.isFinite(change) &&
        Number.isFinite(price) &&
        volume >= MIN_24H_VOLUME_USDT
      );
    })
    .sort(
      (a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent),
    );

  if (!candidates.length) {
    throw new Error("No liquid USDT markets found.");
  }

  /*
  Avoid extremely illiquid/obscure
  pumps dominating the selection.

  First take top candidates by
  percentage gain, then rank them
  using volume + momentum.
  */

  const topCandidates = candidates.slice(0, MAX_SCAN_COINS);

  const scored = topCandidates.map((ticker) => {
    const change = Number(ticker.priceChangePercent);

    const volume = Number(ticker.quoteVolume);

    const volumeScore = Math.log10(Math.max(volume, 1));

    const momentumScore = clamp(change, -100, 100);

    const score = momentumScore * 3 + volumeScore;

    return {
      ticker,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected = scored[0].ticker;

  const symbol = selected.symbol;

  const baseAsset = symbol.replace("USDT", "");

  console.log(`🔥 BEST 24H COIN: ${symbol}`);

  console.log(`📈 24h: ${selected.priceChangePercent}%`);

  console.log(`💰 Volume: $${Number(selected.quoteVolume).toLocaleString()}`);

  const marketData = await enrichMarketData(selected);

  return {
    ...marketData,
    baseAsset,
  };
}

/* =======================================================
   KLINES + INDICATORS
======================================================= */

async function enrichMarketData(ticker) {
  const symbol = ticker.symbol;

  const response = await fetchWithTimeout(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=100`,
    {},
    15000,
  );

  if (!response.ok) {
    throw new Error(`Klines HTTP ${response.status}`);
  }

  const klines = await response.json();

  const closes = klines.map((candle) => Number(candle[4]));

  const smaShort = movingAverage(closes, SMA_SHORT);

  const smaLong = movingAverage(closes, SMA_LONG);

  const rsi = computeRSI(closes, RSI_PERIOD);

  const lastPrice = Number(ticker.lastPrice);

  const change = Number(ticker.priceChangePercent);

  const currentSMA9 = smaShort.at(-1);

  const currentSMA21 = smaLong.at(-1);

  const currentRSI = rsi.at(-1);

  const signal = generateSignal({
    price: lastPrice,
    change,
    sma9: currentSMA9,
    sma21: currentSMA21,
    rsi: currentRSI,
  });

  return {
    symbol,
    lastPrice,
    priceChangePercent: change,
    volume: Number(ticker.quoteVolume),
    high: Number(ticker.highPrice),
    low: Number(ticker.lowPrice),
    sma9: currentSMA9,
    sma21: currentSMA21,
    rsi: currentRSI,
    signal,
  };
}

function movingAverage(data, period) {
  const result = [];

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    const slice = data.slice(i - period + 1, i + 1);

    const sum = slice.reduce((a, b) => a + b, 0);

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
    const difference = data[i] - data[i - 1];

    gains.push(difference > 0 ? difference : 0);

    losses.push(difference < 0 ? Math.abs(difference) : 0);
  }

  const averageGain = movingAverage(gains, period);

  const averageLoss = movingAverage(losses, period);

  const result = [];

  for (let i = 0; i < averageGain.length; i++) {
    if (averageGain[i] === null || averageLoss[i] === null) {
      result.push(50);
      continue;
    }

    if (averageLoss[i] === 0) {
      result.push(100);
      continue;
    }

    const rs = averageGain[i] / averageLoss[i];

    result.push(100 - 100 / (1 + rs));
  }

  while (result.length < data.length) {
    result.unshift(50);
  }

  return result;
}

/* =======================================================
   SIGNAL
======================================================= */

function generateSignal({ price, change, sma9, sma21, rsi }) {
  let bullishPoints = 0;
  let bearishPoints = 0;

  const reasons = [];

  if (sma9 > sma21) {
    bullishPoints++;
    reasons.push("SMA 9 is above SMA 21");
  } else {
    bearishPoints++;
    reasons.push("SMA 9 is below SMA 21");
  }

  if (change > 0) {
    bullishPoints++;
    reasons.push("24h momentum is positive");
  } else {
    bearishPoints++;
    reasons.push("24h momentum is negative");
  }

  if (rsi >= 50 && rsi <= 70) {
    bullishPoints++;
    reasons.push(
      "RSI shows positive momentum without extreme overbought conditions",
    );
  }

  if (rsi > 75) {
    bearishPoints++;
    reasons.push("RSI is elevated and warns of overextension");
  }

  if (rsi < 30) {
    bullishPoints++;
    reasons.push("RSI indicates oversold conditions");
  }

  let direction = "NEUTRAL";

  if (bullishPoints >= bearishPoints + 2) {
    direction = "BULLISH";
  } else if (bearishPoints >= bullishPoints + 2) {
    direction = "BEARISH";
  }

  let confidence = "LOW";

  const difference = Math.abs(bullishPoints - bearishPoints);

  if (difference >= 3) {
    confidence = "HIGH";
  } else if (difference >= 2) {
    confidence = "MEDIUM";
  }

  let action = "HOLD";

  if (direction === "BULLISH" && confidence !== "LOW") {
    action = "BUY";
  }

  if (direction === "BEARISH" && confidence !== "LOW") {
    action = "SELL";
  }

  return {
    direction,
    confidence,
    action,
    reasons,
    price,
    change,
    rsi,
    sma9,
    sma21,
  };
}

/* =======================================================
   COIN-SPECIFIC NEWS
======================================================= */

async function researchCoinNews(coin) {
  console.log(`\n🌐 Searching news specifically for ${coin}...`);

  const query = `"${coin}" crypto OR cryptocurrency OR token`;

  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(query) +
    "&hl=en-US&gl=US&ceid=US:en";

  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 BinanceSquareAI/11.0",
          Accept: "application/rss+xml, application/xml, text/xml",
        },
      },
      15000,
    );

    if (!response.ok) {
      throw new Error(`Google News HTTP ${response.status}`);
    }

    const xml = await response.text();

    const matches = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)];

    const news = [];

    for (const match of matches.slice(0, NEWS_ITEMS)) {
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

    shuffleArray(news);

    if (newsCollection && news.length) {
      await newsCollection.insertMany(
        news.map((item) => ({
          coin,
          ...item,
          fetchedAt: new Date(),
        })),
        {
          ordered: false,
        },
      );
    }

    console.log(`   📰 ${news.length} news items found.`);

    return news;
  } catch (error) {
    console.warn(`⚠️ News research failed: ${error.message}`);

    return [];
  }
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, "$1")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'");
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
   GROQ SCHEMA
======================================================= */

const POST_SCHEMA = {
  type: "object",

  properties: {
    title: {
      type: "string",
    },

    content: {
      type: "string",
    },

    action: {
      type: "string",
      enum: ["BUY", "HOLD", "SELL"],
    },

    direction: {
      type: "string",
      enum: ["BULLISH", "BEARISH", "NEUTRAL"],
    },

    confidence: {
      type: "string",
      enum: ["LOW", "MEDIUM", "HIGH"],
    },

    qualityScore: {
      type: "number",
    },

    targetPrice: {
      type: "number",
    },

    invalidationPrice: {
      type: "number",
    },

    newsUsed: {
      type: "boolean",
    },

    hashtags: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },

  required: [
    "title",
    "content",
    "action",
    "direction",
    "confidence",
    "qualityScore",
    "targetPrice",
    "invalidationPrice",
    "newsUsed",
    "hashtags",
  ],

  additionalProperties: false,
};

/* =======================================================
   GROQ GENERATION
======================================================= */

async function generatePost(marketData, news) {
  const coin = marketData.symbol.replace("USDT", "");

  const newsBlock = news.length
    ? news
        .slice(0, 8)
        .map(
          (item, index) => `${index + 1}. ${item.title}\n${item.description}`,
        )
        .join("\n\n")
    : "No reliable recent news was found.";

  const marketBlock = `
COIN: ${coin}

CURRENT PRICE:
$${marketData.lastPrice}

24H CHANGE:
${marketData.priceChangePercent}%

24H HIGH:
$${marketData.high}

24H LOW:
$${marketData.low}

24H VOLUME:
$${marketData.volume}

SMA 9:
${marketData.sma9}

SMA 21:
${marketData.sma21}

RSI 14:
${marketData.rsi}

TECHNICAL SIGNAL:
${marketData.signal.direction}

SIGNAL CONFIDENCE:
${marketData.signal.confidence}

PRELIMINARY ACTION:
${marketData.signal.action}

SIGNAL REASONS:
${marketData.signal.reasons.join("; ")}
`;

  const prompt = `
You are an experienced crypto market analyst writing for Binance Square.

Your job is to analyze ONE coin using the provided real market data and recent news.

Do not fabricate news.

Do not invent prices.

Do not claim certainty.

Do not promise profit.

Do not use fake urgency such as:
"buy now or regret it"
"guaranteed"
"100% going up"
"can't lose"

The post should nevertheless be highly engaging, confident and easy to understand.

TITLE:

Create a title in this general style:

"$${coin} is extremely bullish — what to expect next?"

If the data is bearish or neutral, adapt the title honestly.

Examples:

"$COIN is extremely bullish — what to expect next?"

"$COIN is losing momentum — what happens next?"

"$COIN is at a critical level — BUY, HOLD or SELL?"

CONTENT:

Start with a strong hook.

Explain:

1. What happened during the last 24 hours.
2. Why the coin is moving.
3. What the technical indicators show.
4. What the latest relevant news says.
5. What could happen next.
6. Give a clear action view:
   BUY, HOLD or SELL.
7. Give a realistic target.
8. Give an invalidation level.
9. End with a question encouraging discussion.

The recommendation must follow the evidence.

IMPORTANT:

Only discuss ${coin}.

Do not mention Bitcoin or another cryptocurrency.

Use short paragraphs.

Make the post feel like a professional trader's market breakdown.

Keep it approximately 500-900 characters.

Use 3-5 relevant hashtags.

MARKET DATA:

${marketBlock}

RECENT NEWS:

${newsBlock}
`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`🧠 Groq analysis ${attempt}/3...`);

      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,

        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],

        temperature: 0.7,

        max_completion_tokens: GENERATION_MAX_TOKENS,

        reasoning_effort: "low",

        reasoning_format: "hidden",

        response_format: {
          type: "json_schema",

          json_schema: {
            name: "binance_market_analysis",

            strict: true,

            schema: POST_SCHEMA,
          },
        },
      });

      const raw = response?.choices?.[0]?.message?.content;

      if (!raw) {
        throw new Error("Groq returned empty content.");
      }

      const parsed = JSON.parse(raw);

      return normalizePost(parsed, marketData, coin);
    } catch (error) {
      console.warn(`⚠️ Groq attempt failed: ${error.message}`);

      if (attempt === 3) {
        throw error;
      }

      await sleep(attempt * 1500);
    }
  }
}

/* =======================================================
   NORMALIZE POST
======================================================= */

function normalizePost(post, marketData, coin) {
  const target = Number(post.targetPrice);

  const invalidation = Number(post.invalidationPrice);

  const normalized = {
    title: String(post.title || `$${coin} — what to expect next?`)
      .trim()
      .slice(0, 150),

    content: String(post.content || "").trim(),

    action: ["BUY", "HOLD", "SELL"].includes(post.action)
      ? post.action
      : marketData.signal.action,

    direction: ["BULLISH", "BEARISH", "NEUTRAL"].includes(post.direction)
      ? post.direction
      : marketData.signal.direction,

    confidence: ["LOW", "MEDIUM", "HIGH"].includes(post.confidence)
      ? post.confidence
      : "MEDIUM",

    qualityScore: Number.isFinite(Number(post.qualityScore))
      ? Number(post.qualityScore)
      : 8,

    targetPrice: Number.isFinite(target) ? target : marketData.lastPrice,

    invalidationPrice: Number.isFinite(invalidation)
      ? invalidation
      : marketData.low,

    newsUsed: Boolean(post.newsUsed),

    hashtags: Array.isArray(post.hashtags)
      ? post.hashtags.slice(0, 5).map((tag) => String(tag).trim())
      : [`#${coin}`, "#MarketAnalysis", "#Trading"],
  };

  return normalized;
}

/* =======================================================
   VALIDATION
======================================================= */

function validatePost(post, marketData) {
  const reasons = [];

  if (!post) {
    reasons.push("empty post");
  }

  if (!post.content || post.content.length < 100) {
    reasons.push("post too short");
  }

  if (post.content.length > 3000) {
    reasons.push("post too long");
  }

  const lower = post.content.toLowerCase();

  const forbidden = [
    "guaranteed profit",
    "guaranteed return",
    "risk free",
    "zero risk",
    "100% profit",
    "can't lose",
    "cannot lose",
    "guaranteed gains",
  ];

  for (const phrase of forbidden) {
    if (lower.includes(phrase)) {
      reasons.push(`forbidden phrase: ${phrase}`);
    }
  }

  const coin = marketData.symbol.replace("USDT", "");

  /*
  Prevent Groq accidentally
  discussing unrelated coins.
  */

  const forbiddenCoins = [
    "bitcoin",
    "ethereum",
    "solana",
    "dogecoin",
    "cardano",
    "xrp",
  ].filter((name) => name !== coin.toLowerCase());

  for (const otherCoin of forbiddenCoins) {
    if (lower.includes(otherCoin)) {
      reasons.push(`unrelated coin mentioned: ${otherCoin}`);
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/* =======================================================
   IMAGE PROMPT
======================================================= */

function buildImagePrompt(marketData, post) {
  const coin = marketData.symbol.replace("USDT", "");

  const direction = post.direction;

  const action = post.action;

  const arrow =
    direction === "BULLISH"
      ? "UPWARD"
      : direction === "BEARISH"
        ? "DOWNWARD"
        : "SIDEWAYS";

  /*
  We intentionally make the
  visual exciting and premium,
  but not deceptive.
  */

  return `
Create a premium 1:1 crypto trading
social-media graphic.

VISUAL STYLE:

Dark luxury trading aesthetic.

Black and deep charcoal background.

High contrast neon financial-chart
elements.

Glowing candlestick chart.

Strong directional momentum.

Professional exchange-style interface.

Cinematic lighting.

Subtle metallic reflections.

Powerful depth.

Premium financial advertisement
aesthetic.

The visual should immediately
communicate market movement and
opportunity without making fake
profit promises.

MAIN COIN:

$${coin}

ACTION:

${action}

MARKET DIRECTION:

${direction}

CURRENT PRICE:

$${marketData.lastPrice.toFixed(6)}

24H CHANGE:

${marketData.priceChangePercent.toFixed(2)}%

RSI:

${marketData.rsi.toFixed(1)}

TARGET:

$${Number(post.targetPrice).toFixed(6)}

INVALIDATION:

$${Number(post.invalidationPrice).toFixed(6)}

COMPOSITION:

Large $${coin} ticker at the top.

Huge glowing market-direction
visual in the center.

Use a realistic candlestick chart
behind the main information.

Make the latest candles visually
prominent.

Show:

$${coin}

${action}

24H ${marketData.priceChangePercent.toFixed(2)}%

Target $${Number(post.targetPrice).toFixed(6)}

Do not add random prices.

Do not add random coins.

Do not invent statistics.

Do not show casino machines,
slot machines, gambling tables,
jackpots, fake money or luxury cars.

Do not use human faces.

Do not create fake Binance UI.

Do not claim guaranteed profit.

Make the graphic feel exciting,
premium, modern and highly clickable.

Square 1:1 composition.
Minimal text.
Perfect typography.
No spelling errors.
`;
}

/* =======================================================
   IMAGE GENERATION
======================================================= */

async function generateImage(marketData, post) {
  console.log("\n🎨 Generating trading graphic...");

  const prompt = buildImagePrompt(marketData, post);

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
        prompt,
      }),
    },
    120000,
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(`Cloudflare ${response.status}: ${error}`);
  }

  const contentType = response.headers.get("content-type") || "";

  let imageBuffer;

  if (contentType.includes("application/json")) {
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

    imageBuffer = Buffer.from(image, "base64");
  } else {
    imageBuffer = Buffer.from(await response.arrayBuffer());
  }

  if (!imageBuffer || imageBuffer.length < 1000) {
    throw new Error("Invalid generated image.");
  }

  await fs.mkdir(GENERATED_IMAGE_DIR, {
    recursive: true,
  });

  const filename = `coin-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.png`;

  const imagePath = path.join(GENERATED_IMAGE_DIR, filename);

  await fs.writeFile(imagePath, imageBuffer);

  console.log(`✅ Image saved: ${imagePath}`);

  return imagePath;
}

/* =======================================================
   CLEANUP
======================================================= */

async function cleanupImage(imagePath) {
  if (!imagePath) return;

  try {
    await fs.unlink(imagePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn("⚠️ Image cleanup failed:", error.message);
    }
  }
}

/* =======================================================
   PUBLISH
======================================================= */

function publishImage(content, imagePath) {
  return new Promise((resolve, reject) => {
    console.log("\n📡 Publishing to Binance Square...");

    if (DRY_RUN) {
      console.log("\n========== DRY RUN ==========\n");

      console.log(content);

      console.log("\nIMAGE:", imagePath);

      console.log("\n==============================\n");

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

        const rejectOnce = (error) => {
          if (settled) return;

          settled = true;
          reject(error);
        };

        const resolveOnce = (value) => {
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

        child.on("error", rejectOnce);

        child.on("close", (code) => {
          if (code !== 0) {
            rejectOnce(
              new Error(`Square publisher exited with code ${code}\n${stderr}`),
            );

            return;
          }

          const id = stdout.match(/ID:\s*(.+)/i)?.[1]?.trim() || null;

          const link = stdout.match(/Link:\s*(.+)/i)?.[1]?.trim() || null;

          resolveOnce({
            success: true,
            dryRun: false,
            id,
            link,
            stdout,
          });
        });
      })
      .catch(reject);
  });
}

/* =======================================================
   SAVE HISTORY
======================================================= */

async function savePost(post, marketData, news, result) {
  state.history.push({
    id: result?.id || null,

    coin: marketData.symbol,

    title: post.title,

    text: post.content,

    action: post.action,

    direction: post.direction,

    confidence: post.confidence,

    qualityScore: post.qualityScore,

    targetPrice: post.targetPrice,

    invalidationPrice: post.invalidationPrice,

    currentPrice: marketData.lastPrice,

    priceChange24h: marketData.priceChangePercent,

    rsi: marketData.rsi,

    sma9: marketData.sma9,

    sma21: marketData.sma21,

    newsUsed: post.newsUsed,

    newsCount: news.length,

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

  if (postHistoryCollection) {
    try {
      await postHistoryCollection.insertOne({
        ...state.history.at(-1),
      });
    } catch (error) {
      console.warn("⚠️ History MongoDB save failed:", error.message);
    }
  }
}

/* =======================================================
   MAIN CYCLE
======================================================= */

let cycleRunning = false;

async function runCycle() {
  const today = getLocalDate();

  if (state.date !== today) {
    state.date = today;
    state.postsToday = 0;

    await saveState();
  }

  console.log("\n================================================");

  console.log("🚀 BINANCE SQUARE AI BOT V11.0.0");

  console.log("================================================");

  console.log(
    `🕐 ${new Date().toLocaleString("en-US", {
      timeZone: BOT_TIMEZONE,
    })}`,
  );

  console.log(`📅 Posts: ${state.postsToday}/${MAX_POSTS_PER_DAY}`);

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
    /*
    STEP 1
    Find best 24h coin
    */

    const marketData = await getBest24hCoin();

    const coin = marketData.symbol.replace("USDT", "");

    /*
    STEP 2
    Research that exact coin
    */

    const news = await researchCoinNews(coin);

    /*
    STEP 3
    AI analysis
    */

    const post = await generatePost(marketData, news);

    /*
    STEP 4
    Validate
    */

    const validation = validatePost(post, marketData);

    if (!validation.valid) {
      console.error("❌ Post rejected:");

      for (const reason of validation.reasons) {
        console.error(` • ${reason}`);
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

    /*
    STEP 5
    Show analysis
    */

    console.log("\n================ ANALYSIS ================");

    console.log(`🪙 Coin: ${coin}`);

    console.log(`💵 Price: $${marketData.lastPrice}`);

    console.log(`📈 24H: ${marketData.priceChangePercent}%`);

    console.log(`📊 RSI: ${marketData.rsi.toFixed(2)}`);

    console.log(`📈 SMA9: ${marketData.sma9}`);

    console.log(`📈 SMA21: ${marketData.sma21}`);

    console.log(`🎯 Direction: ${post.direction}`);

    console.log(`🎯 Action: ${post.action}`);

    console.log(`⭐ Confidence: ${post.confidence}`);

    console.log(`🎯 Target: $${post.targetPrice}`);

    console.log(`🛑 Invalidation: $${post.invalidationPrice}`);

    console.log("\n📝 TITLE:");

    console.log(post.title);

    console.log("\n📝 CONTENT:");

    console.log(post.content);

    /*
    STEP 6
    Generate image
    */

    let imagePath = null;

    try {
      imagePath = await generateImage(marketData, post);

      /*
      Add hashtags to final
      */

      const hashtags = post.hashtags.join(" ");

      const finalContent = `${post.content}\n\n${hashtags}`;

      /*
      STEP 7
      Publish
      */

      const result = await publishImage(finalContent, imagePath);

      await savePost(post, marketData, news, result);

      console.log("\n╔══════════════════════════════════════╗");

      console.log("║       ✅ CYCLE COMPLETED             ║");

      console.log("╚══════════════════════════════════════╝");

      if (result.id) {
        console.log(`🆔 ID: ${result.id}`);
      }

      if (result.link) {
        console.log(`🔗 ${result.link}`);
      }

      return {
        success: true,
        id: result.id || null,
        link: result.link || null,
        dryRun: Boolean(result.dryRun),
        coin,
        action: post.action,
        direction: post.direction,
        imageGenerated: true,
      };
    } finally {
      await cleanupImage(imagePath);
    }
  } catch (error) {
    state.totalFailures++;

    await saveState();

    console.error("\n❌ Cycle failed:");

    console.error(error?.stack || error?.message || error);

    return {
      success: false,
      error: error?.message || "Unknown error",
    };
  }
}

/* =======================================================
   SAFE RUN
======================================================= */

async function safeRunCycle() {
  if (cycleRunning) {
    return {
      success: false,
      error: "A Binance cycle is already running.",
    };
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

async function initializeBinanceBot() {
  if (initialized) return;

  console.log("\n==============================================");

  console.log("🤖 INITIALIZING BINANCE BOT V11");

  console.log("==============================================");

  await connectMongo();

  await loadState();

  console.log(`🧠 Groq: ${GROQ_MODEL}`);

  console.log("📊 Strategy: Best 24H liquid performer");

  console.log("🌐 Research: Coin-specific Google News");

  console.log("📈 Indicators: SMA 9 / SMA 21 / RSI 14");

  console.log("🎯 Decision: BUY / HOLD / SELL");

  console.log("🎨 Image: Cloudflare Workers AI");

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  initialized = true;

  console.log("✅ Binance bot initialized.");
}

async function runBinanceBot() {
  await initializeBinanceBot();

  return safeRunCycle();
}

/* =======================================================
   STATUS
======================================================= */

function getBinanceStatus() {
  const today = getLocalDate();

  if (state.date !== today) {
    state.date = today;
    state.postsToday = 0;
  }

  return {
    service: "binance-square-ai-bot",

    version: "11.0.0",

    timezone: BOT_TIMEZONE,

    localDate: today,

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
   EXPORT
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
