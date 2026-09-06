// ============================================================
// BINANCE SQUARE AI BOT V11.0.1
// FIXED: Binance Square hashtag-limit rejection
//
// Flow:
// 1. Scan Binance USDT markets
// 2. Select strongest liquid performer
// 3. Fetch coin-specific news
// 4. Calculate SMA + RSI
// 5. Generate BUY/HOLD/SELL analysis with Groq
// 6. Generate trading graphic with Cloudflare
// 7. Publish image + content to Binance Square
// 8. Save history/state in MongoDB
//
// IMPORTANT FIX:
// Binance Square rejects posts when hashtag count exceeds
// the platform limit. This version:
// - Allows MAX 2 hashtags
// - Removes inline hashtags from generated content
// - Deduplicates hashtags
// - Adds exactly/at most 2 safe hashtags
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

const GENERATED_IMAGES_DIR = path.join(
  __dirname,
  "generated-images"
);

const STATE_FILE = path.join(
  __dirname,
  "bot-state.json"
);

const BACKUP_STATE_FILE = path.join(
  __dirname,
  "bot-state.backup.json"
);

const SQUARE_IMAGE_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-image.mjs"
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

const SMA_SHORT = 9;
const SMA_MEDIUM = 50;
const SMA_LONG = 21;
const RSI_PERIOD = 14;

// HARD Binance Square hashtag safety limit
const MAX_HASHTAGS = 2;

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
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  return Number.isFinite(number)
    ? number
    : fallback;
}

function round(value, decimals = 4) {
  const multiplier = 10 ** decimals;

  return Math.round(value * multiplier) / multiplier;
}

// ============================================================
// HTTP FETCH WITH TIMEOUT
// ============================================================

async function fetchWithTimeout(
  url,
  options = {},
  timeout = Number(REQUEST_TIMEOUT_MS)
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
    const raw = await fs.readFile(
      STATE_FILE,
      "utf8"
    );

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
      "utf8"
    );

    await fs.writeFile(
      STATE_FILE,
      JSON.stringify(state, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error(
      "⚠️ Failed to save state:",
      error.message
    );
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

    console.log(
      `🍃 MongoDB connected: ${MONGODB_DB_NAME}`
    );
  } catch (error) {
    console.error(
      "⚠️ MongoDB connection failed:",
      error.message
    );

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

    await db
      .collection("post_history")
      .deleteMany({
        createdAt: {
          $lt: new Date(
            Date.now() -
              1000 *
                60 *
                60 *
                24 *
                30
          ),
        },
      });
  } catch (error) {
    console.error(
      "⚠️ Mongo history save failed:",
      error.message
    );
  }
}

async function saveNews(coin, news) {
  if (!db || !news?.length) return;

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
      }
    );
  } catch (error) {
    console.error(
      "⚠️ Mongo news save failed:",
      error.message
    );
  }
}

// ============================================================
// BINANCE MARKET DATA
// ============================================================

async function fetch24hTickers() {
  const url =
    `${BINANCE_API}/api/v3/ticker/24hr`;

  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(
      `Binance ticker API failed: ${response.status}`
    );
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
      `Binance klines API failed for ${symbol}: ${response.status}`
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

  const minVolume =
    Number(MIN_24H_VOLUME_USDT);

  const candidates = tickers
    .filter((ticker) => {
      const symbol = String(ticker.symbol || "");

      const priceChange =
        safeNumber(ticker.priceChangePercent);

      const volume =
        safeNumber(ticker.quoteVolume);

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
        safeNumber(b.priceChangePercent) -
        safeNumber(a.priceChangePercent)
    )
    .slice(
      0,
      Number(MAX_SCAN_COINS)
    );

  if (!candidates.length) {
    throw new Error(
      "No suitable Binance USDT market found."
    );
  }

  const selected = candidates[0];

  const coin = selected.symbol.replace(
    "USDT",
    ""
  );

  console.log(
    `🏆 Selected ${coin} | ` +
      `24h: ${selected.priceChangePercent}% | ` +
      `Volume: $${Number(
        selected.quoteVolume
      ).toLocaleString()}`
  );

  return {
    symbol: selected.symbol,
    coin,
    price: safeNumber(selected.lastPrice),
    priceChange24h: safeNumber(
      selected.priceChangePercent
    ),
    volume24h: safeNumber(
      selected.quoteVolume
    ),
  };
}

// ============================================================
// TECHNICAL INDICATORS
// ============================================================

function calculateSMA(values, period) {
  if (values.length < period) {
    return null;
  }

  const slice =
    values.slice(-period);

  const sum = slice.reduce(
    (total, value) => total + value,
    0
  );

  return sum / period;
}

function calculateRSI(
  values,
  period = RSI_PERIOD
) {
  if (values.length <= period) {
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
      values[i] - values[i - 1];

    if (difference >= 0) {
      gains += difference;
    } else {
      losses += Math.abs(difference);
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
      values[i] - values[i - 1];

    const gain =
      difference > 0
        ? difference
        : 0;

    const loss =
      difference < 0
        ? Math.abs(difference)
        : 0;

    averageGain =
      ((averageGain * (period - 1)) +
        gain) /
      period;

    averageLoss =
      ((averageLoss * (period - 1)) +
        loss) /
      period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs =
    averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

async function calculateIndicators(symbol) {
  console.log(
    `📊 Calculating indicators for ${symbol}...`
  );

  const klines =
    await fetchKlines(symbol);

  const closes = klines.map(
    (candle) =>
      safeNumber(candle[4])
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

  const trend =
    currentPrice > sma9 &&
    sma9 > sma21 &&
    sma21 > sma50
      ? "BULLISH"
      : currentPrice < sma9 &&
          sma9 < sma21 &&
          sma21 < sma50
        ? "BEARISH"
        : "MIXED";

  console.log(
    `SMA9=${round(sma9, 6)} | ` +
      `SMA21=${round(sma21, 6)} | ` +
      `SMA50=${round(sma50, 6)} | ` +
      `RSI=${round(rsi, 2)} | ` +
      `Trend=${trend}`
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
    .replace(/&gt;/g, ">");
}

async function fetchCoinNews(coin) {
  console.log(
    `📰 Fetching news for ${coin}...`
  );

  const query = encodeURIComponent(
    `"${coin}" crypto OR cryptocurrency`
  );

  const url =
    `https://news.google.com/rss/search?` +
    `q=${query}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const response =
      await fetchWithTimeout(url);

    if (!response.ok) {
      console.log(
        "⚠️ Google News unavailable."
      );

      return [];
    }

    const xml =
      await response.text();

    const items = [
      ...xml.matchAll(
        /<item>([\s\S]*?)<\/item>/gi
      ),
    ];

    const news = items
      .slice(0, Number(NEWS_ITEMS))
      .map((match) => {
        const item = match[1];

        const title =
          item.match(
            /<title>([\s\S]*?)<\/title>/i
          )?.[1] || "";

        const link =
          item.match(
            /<link>([\s\S]*?)<\/link>/i
          )?.[1] || "";

        const pubDate =
          item.match(
            /<pubDate>([\s\S]*?)<\/pubDate>/i
          )?.[1] || "";

        return {
          title: stripHtml(title),
          link: link.trim(),
          pubDate: pubDate.trim(),
        };
      })
      .filter(
        (item) => item.title
      );

    console.log(
      `📰 Found ${news.length} news items.`
    );

    await saveNews(
      coin,
      news
    );

    return news;
  } catch (error) {
    console.error(
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
  hashtags,
  coin
) {
  const fallback = [
    `#${coin}`,
    "#CryptoAnalysis",
  ];

  if (!Array.isArray(hashtags)) {
    return fallback;
  }

  const cleaned = hashtags
    .map((tag) =>
      String(tag || "")
        .trim()
    )
    .filter((tag) =>
      /^#[A-Za-z0-9_]+$/.test(tag)
    )
    .map((tag) => {
      if (!tag.startsWith("#")) {
        return `#${tag}`;
      }

      return tag;
    });

  const unique = [
    ...new Set(cleaned),
  ];

  if (!unique.length) {
    return fallback;
  }

  return unique.slice(
    0,
    MAX_HASHTAGS
  );
}

// ============================================================
// REMOVE INLINE HASHTAGS
//
// This prevents Groq from generating something like:
//
// "RAY is strong today #RAY #Solana #Crypto"
// ============================================================

function removeInlineHashtags(
  content
) {
  if (!content) {
    return "";
  }

  return String(content)
    .replace(
      /(^|\s)#[A-Za-z0-9_]+/g,
      "$1"
    )
    .replace(
      /[ \t]{2,}/g,
      " "
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

// ============================================================
// FINAL CONTENT BUILDER
// ============================================================

function buildFinalContent(
  content,
  hashtags,
  coin
) {
  const cleanContent =
    removeInlineHashtags(
      content
    );

  const safeHashtags =
    sanitizeHashtags(
      hashtags,
      coin
    );

  console.log(
    `🏷️ Final hashtags: ${safeHashtags.join(" ")}`
  );

  return (
    `${cleanContent}\n\n` +
    `${safeHashtags.join(" ")}`
  ).trim();
}

// ============================================================
// GROQ POST GENERATION
// ============================================================

async function generatePost({
  market,
  indicators,
  news,
}) {
  console.log(
    "🤖 Generating AI market analysis..."
  );

  const newsText =
    news.length
      ? news
          .map(
            (item, index) =>
              `${index + 1}. ${item.title}`
          )
          .join("\n")
      : "No recent news available.";

  const prompt = `
You are an expert crypto market analyst creating a Binance Square post.

COIN:
${market.coin}

SYMBOL:
${market.symbol}

CURRENT PRICE:
${market.price}

24H CHANGE:
${market.priceChange24h}%

24H VOLUME:
${market.volume24h}

TECHNICAL DATA:

SMA ${SMA_SHORT}:
${indicators.sma9}

SMA ${SMA_LONG}:
${indicators.sma21}

SMA ${SMA_MEDIUM}:
${indicators.sma50}

RSI:
${indicators.rsi}

TREND:
${indicators.trend}

RECENT NEWS:
${newsText}

Create a useful, concise Binance Square crypto analysis.

Requirements:

- Explain what is happening.
- Explain the technical trend.
- Mention RSI.
- Mention important support/resistance when reasonable.
- Give a realistic target.
- Give an invalidation price.
- Choose BUY, HOLD, or SELL.
- Give confidence as LOW, MEDIUM, or HIGH.
- Do not promise profits.
- Do not claim certainty.
- Do not use excessive emojis.
- Do not include markdown tables.
- Do not put hashtags inside the content.

Return ONLY valid JSON:

{
  "content": "complete Binance Square post",
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
Return at most TWO hashtags.
`;

  const completion =
    await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0.7,
      max_tokens:
        Number(
          GENERATION_MAX_TOKENS
        ),
      response_format: {
        type: "json_object",
      },
      messages: [
        {
          role: "system",
          content:
            "You are a professional crypto market analyst. Return only valid JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

  const raw =
    completion.choices?.[0]?.message?.content;

  if (!raw) {
    throw new Error(
      "Groq returned empty response."
    );
  }

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      "❌ Invalid Groq JSON:",
      raw
    );

    throw new Error(
      "Groq returned invalid JSON."
    );
  }

  return normalizePost(
    parsed,
    market
  );
}

// ============================================================
// NORMALIZE AI POST
// ============================================================

function normalizePost(
  post,
  market
) {
  const action = [
    "BUY",
    "HOLD",
    "SELL",
  ].includes(
    String(
      post.action || ""
    ).toUpperCase()
  )
    ? String(
        post.action
      ).toUpperCase()
    : "HOLD";

  const confidence = [
    "LOW",
    "MEDIUM",
    "HIGH",
  ].includes(
    String(
      post.confidence || ""
    ).toUpperCase()
  )
    ? String(
        post.confidence
      ).toUpperCase()
    : "MEDIUM";

  const content =
    String(
      post.content || ""
    ).trim();

  const hashtags =
    sanitizeHashtags(
      post.hashtags,
      market.coin
    );

  return {
    content,
    action,
    targetPrice:
      safeNumber(
        post.targetPrice
      ),
    invalidationPrice:
      safeNumber(
        post.invalidationPrice
      ),
    confidence,
    qualityScore:
      safeNumber(
        post.qualityScore
      ),
    hashtags,
    newsUsed:
      Boolean(
        post.newsUsed
      ),
  };
}

// ============================================================
// NON-BLOCKING CONTENT VALIDATION
// ============================================================

function validatePost(post) {
  const warnings = [];

  if (
    !post.content ||
    post.content.length < 50
  ) {
    warnings.push(
      "Content is too short."
    );
  }

  if (
    post.content.length > 5000
  ) {
    warnings.push(
      "Content is very long."
    );
  }

  if (
    !["BUY", "HOLD", "SELL"].includes(
      post.action
    )
  ) {
    warnings.push(
      "Invalid action."
    );
  }

  if (
    post.hashtags.length >
    MAX_HASHTAGS
  ) {
    warnings.push(
      "Too many hashtags."
    );
  }

  return {
    valid:
      warnings.length === 0,
    warnings,
  };
}

// ============================================================
// IMAGE GENERATION
// ============================================================

async function generateTradingGraphic({
  market,
  indicators,
  post,
}) {
  console.log(
    "🎨 Generating trading graphic..."
  );

  if (
    !CLOUDFLARE_ACCOUNT_ID ||
    !CLOUDFLARE_API_TOKEN
  ) {
    throw new Error(
      "Cloudflare credentials missing."
    );
  }

  await fs.mkdir(
    GENERATED_IMAGES_DIR,
    {
      recursive: true,
    }
  );

  const imagePrompt = `
Create a professional cryptocurrency trading graphic for Binance Square.

Coin: ${market.coin}
Current Price: $${market.price}
24h Change: ${market.priceChange24h}%
Action: ${post.action}
Target: $${post.targetPrice}
Invalidation: $${post.invalidationPrice}
RSI: ${round(indicators.rsi, 2)}
Trend: ${indicators.trend}

Style:
- premium financial news graphic
- modern crypto trading terminal aesthetic
- clean professional composition
- dark sophisticated background
- large readable ${market.coin} ticker
- current price clearly visible
- technical chart visual
- bullish/bearish visual depending on action
- professional market-analysis presentation
- no fake logos
- no extra hashtags
- no watermark
- no unnecessary text
`;

  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/` +
    `${CLOUDFLARE_ACCOUNT_ID}/ai/run/` +
    `${CLOUDFLARE_IMAGE_MODEL}`;

  const response =
    await fetchWithTimeout(
      endpoint,
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type":
            "application/json",
        },

        body: JSON.stringify({
          prompt: imagePrompt,
        }),
      },
      120000
    );

  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `Cloudflare image API failed: ${response.status} ${errorText}`
    );
  }

  const contentType =
    response.headers.get(
      "content-type"
    ) || "";

  const filename =
    `coin-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 9)}.png`;

  const imagePath =
    path.join(
      GENERATED_IMAGES_DIR,
      filename
    );

  if (
    contentType.includes(
      "application/json"
    )
  ) {
    const json =
      await response.json();

    let imageBuffer;

    if (
      json.result?.image
    ) {
      imageBuffer =
        Buffer.from(
          json.result.image,
          "base64"
        );
    } else if (
      json.result?.image_base64
    ) {
      imageBuffer =
        Buffer.from(
          json.result.image_base64,
          "base64"
        );
    } else {
      throw new Error(
        "Cloudflare returned JSON but no image data."
      );
    }

    await fs.writeFile(
      imagePath,
      imageBuffer
    );
  } else {
    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    await fs.writeFile(
      imagePath,
      buffer
    );
  }

  console.log(
    `✅ Image saved: ${imagePath}`
  );

  return imagePath;
}

// ============================================================
// PUBLISH TO BINANCE SQUARE
// ============================================================

function publishToBinanceSquare(
  content,
  imagePath
) {
  return new Promise(
    (resolve, reject) => {
      console.log(
        "📡 Publishing to Binance Square..."
      );

      // FINAL DEFENSIVE HASHTAG CLEANUP
      const cleanContent =
        removeInlineHashtags(
          content
        );

      // Extract existing final hashtags
      const hashtagMatches =
        cleanContent.match(
          /#[A-Za-z0-9_]+/g
        ) || [];

      const safeHashtags =
        sanitizeHashtags(
          hashtagMatches,
          "Crypto"
        );

      // Remove all hashtags again
      // and append only two controlled ones.
      const contentWithoutHashtags =
        cleanContent
          .replace(
            /(^|\s)#[A-Za-z0-9_]+/g,
            "$1"
          )
          .replace(
            /[ \t]{2,}/g,
            " "
          )
          .trim();

      const finalContent =
        `${contentWithoutHashtags}\n\n` +
        `${safeHashtags.join(" ")}`;

      console.log(
        "🏷️ Publishing with hashtags:",
        safeHashtags.join(" ")
      );

      console.log(
        `🏷️ Hashtag count: ${safeHashtags.length}`
      );

      if (
        safeHashtags.length >
        MAX_HASHTAGS
      ) {
        return reject(
          new Error(
            "Internal safety check: hashtag limit exceeded."
          )
        );
      }

      const args = [
        SQUARE_IMAGE_SCRIPT,
        "--text",
        finalContent,
        "--images",
        imagePath,
      ];

      const child =
        spawn(
          process.execPath,
          args,
          {
            cwd: path.dirname(
              SQUARE_IMAGE_SCRIPT
            ),

            env: {
              ...process.env,
              BINANCE_SQUARE_OPENAPI_KEY,
            },

            stdio: [
              "ignore",
              "pipe",
              "pipe",
            ],
          }
        );

      let stdout = "";
      let stderr = "";

      child.stdout.on(
        "data",
        (data) => {
          const text =
            data.toString();

          stdout += text;

          process.stdout.write(
            text
          );
        }
      );

      child.stderr.on(
        "data",
        (data) => {
          const text =
            data.toString();

          stderr += text;

          process.stderr.write(
            text
          );
        }
      );

      child.on(
        "error",
        (error) => {
          reject(error);
        }
      );

      child.on(
        "close",
        (code) => {
          if (code === 0) {
            resolve({
              success: true,
              stdout,
              stderr,
              finalContent,
              hashtags:
                safeHashtags,
            });
          } else {
            reject(
              new Error(
                `Square publisher exited with code ${code}\n` +
                  `${stderr || stdout}`
              )
            );
          }
        }
      );
    }
  );
}

// ============================================================
// POST LIMIT
// ============================================================

function canPostToday() {
  const today =
    getDateKey();

  if (
    state.lastPostDate !== today
  ) {
    state.postsToday = 0;
    state.lastPostDate = today;
  }

  return (
    state.postsToday <
    Number(MAX_POSTS_PER_DAY)
  );
}

// ============================================================
// MAIN BOT CYCLE
// ============================================================

async function runCycle() {
  console.log(
    "\n============================================================"
  );

  console.log(
    "🚀 BINANCE SQUARE AI BOT CYCLE"
  );

  console.log(
    "============================================================\n"
  );

  if (!canPostToday()) {
    console.log(
      `⛔ Daily post limit reached: ${state.postsToday}/${MAX_POSTS_PER_DAY}`
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

    market =
      await selectStrongestCoin();

    // --------------------------------------------------------
    // 2. TECHNICAL ANALYSIS
    // --------------------------------------------------------

    indicators =
      await calculateIndicators(
        market.symbol
      );

    // --------------------------------------------------------
    // 3. NEWS
    // --------------------------------------------------------

    news =
      await fetchCoinNews(
        market.coin
      );

    // --------------------------------------------------------
    // 4. AI POST
    // --------------------------------------------------------

    post =
      await generatePost({
        market,
        indicators,
        news,
      });

    // --------------------------------------------------------
    // 5. VALIDATION
    // --------------------------------------------------------

    const validation =
      validatePost(post);

    if (!validation.valid) {
      console.log(
        "⚠️ Content validation warnings:"
      );

      for (
        const warning of validation.warnings
      ) {
        console.log(
          `   - ${warning}`
        );
      }

      // IMPORTANT:
      // Validation is NON-BLOCKING.
      // Binance publication continues.
    } else {
      console.log(
        "✅ Content validation passed."
      );
    }

    // --------------------------------------------------------
    // 6. FINAL CONTENT
    // --------------------------------------------------------

    const finalContent =
      buildFinalContent(
        post.content,
        post.hashtags,
        market.coin
      );

    console.log(
      "\n📝 FINAL POST:"
    );

    console.log(
      "------------------------------------------------------------"
    );

    console.log(
      finalContent
    );

    console.log(
      "------------------------------------------------------------"
    );

    console.log(
      `Action: ${post.action}`
    );

    console.log(
      `Target Price: $${post.targetPrice}`
    );

    console.log(
      `Invalidation Price: $${post.invalidationPrice}`
    );

    console.log(
      `Confidence: ${post.confidence}`
    );

    console.log(
      `newsUsed: ${post.newsUsed}`
    );

    console.log(
      `qualityScore: ${post.qualityScore}`
    );

    console.log(
      `hashtags: ${post.hashtags.join(" ")}`
    );

    // --------------------------------------------------------
    // 7. IMAGE
    // --------------------------------------------------------

    imagePath =
      await generateTradingGraphic({
        market,
        indicators,
        post,
      });

    // --------------------------------------------------------
    // 8. DRY RUN
    // --------------------------------------------------------

    if (
      String(DRY_RUN).toLowerCase() ===
      "true"
    ) {
      console.log(
        "\n🧪 DRY_RUN enabled."
      );

      console.log(
        "⏭️ Skipping Binance Square publication."
      );

      await saveHistory({
        success: true,
        dryRun: true,
        coin: market.coin,
        symbol: market.symbol,
        action: post.action,
        targetPrice:
          post.targetPrice,
        invalidationPrice:
          post.invalidationPrice,
        confidence:
          post.confidence,
        qualityScore:
          post.qualityScore,
        content: finalContent,
        hashtags:
          post.hashtags,
        imagePath,
      });

      return {
        success: true,
        dryRun: true,
        coin: market.coin,
      };
    }

    // --------------------------------------------------------
    // 9. PUBLISH
    // --------------------------------------------------------

    const publication =
      await publishToBinanceSquare(
        finalContent,
        imagePath
      );

    // --------------------------------------------------------
    // 10. UPDATE STATE
    // --------------------------------------------------------

    state.postsToday += 1;
    state.totalPosts += 1;
    state.lastCoin =
      market.coin;
    state.lastPostAt =
      new Date().toISOString();
    state.lastPostDate =
      getDateKey();

    await saveState();

    // --------------------------------------------------------
    // 11. SAVE HISTORY
    // --------------------------------------------------------

    await saveHistory({
      success: true,
      coin: market.coin,
      symbol: market.symbol,
      action: post.action,
      targetPrice:
        post.targetPrice,
      invalidationPrice:
        post.invalidationPrice,
      confidence:
        post.confidence,
      qualityScore:
        post.qualityScore,
      newsUsed:
        post.newsUsed,
      hashtags:
        post.hashtags,
      content: finalContent,
      imagePath,
      publication,
    });

    console.log(
      "\n============================================================"
    );

    console.log(
      "🎉 BINANCE SQUARE POST PUBLISHED SUCCESSFULLY"
    );

    console.log(
      "============================================================"
    );

    return {
      success: true,
      coin: market.coin,
      action: post.action,
      targetPrice:
        post.targetPrice,
      invalidationPrice:
        post.invalidationPrice,
      confidence:
        post.confidence,
      hashtags:
        post.hashtags,
    };
  } catch (error) {
    state.totalFailures += 1;

    await saveState();

    await saveHistory({
      success: false,
      coin:
        market?.coin ||
        null,
      symbol:
        market?.symbol ||
        null,
      error:
        error.message,
      createdAt:
        new Date(),
    });

    console.error(
      "\n❌ Cycle failed:"
    );

    console.error(
      error
    );

    return {
      success: false,
      error:
        error.message,
    };
  }
}

// ============================================================
// HTTP SERVER
// ============================================================

import http from "http";

const PORT =
  Number(
    process.env.PORT
  ) || 3000;

const server =
  http.createServer(
    async (req, res) => {
      // ------------------------------------------------------
      // CORS
      // ------------------------------------------------------

      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );

      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, OPTIONS"
      );

      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization"
      );

      // ------------------------------------------------------
      // OPTIONS
      // ------------------------------------------------------

      if (
        req.method === "OPTIONS"
      ) {
        res.writeHead(204);
        res.end();
        return;
      }

      // ------------------------------------------------------
      // GET /
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        req.url === "/"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json",
          }
        );

        res.end(
          JSON.stringify({
            success: true,
            service:
              "Binance Square AI Bot",
            version:
              "11.0.1",
            status:
              "online",
            postsToday:
              state.postsToday,
            maxPostsPerDay:
              Number(
                MAX_POSTS_PER_DAY
              ),
            totalPosts:
              state.totalPosts,
            totalFailures:
              state.totalFailures,
            hashtagLimit:
              MAX_HASHTAGS,
            timezone:
              BOT_TIMEZONE,
          })
        );

        return;
      }

      // ------------------------------------------------------
      // GET /health
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json",
          }
        );

        res.end(
          JSON.stringify({
            success: true,
            status: "healthy",
            timestamp:
              new Date().toISOString(),
          })
        );

        return;
      }

      // ------------------------------------------------------
      // POST /post
      // ------------------------------------------------------

      if (
        req.method === "POST" &&
        (
          req.url === "/post" ||
          req.url === "/binance/post"
        )
      ) {
        let body = "";

        req.on(
          "data",
          (chunk) => {
            body += chunk.toString();
          }
        );

        req.on(
          "end",
          async () => {
            try {
              let parsed = {};

              if (body.trim()) {
                try {
                  parsed =
                    JSON.parse(body);
                } catch {
                  parsed = {};
                }
              }

              const providedSecret =
                req.headers[
                  "x-post-secret"
                ] ||
                req.headers[
                  "authorization"
                ]?.replace(
                  /^Bearer\s+/i,
                  ""
                ) ||
                parsed.secret;

              if (
                providedSecret !==
                POST_TRIGGER_SECRET
              ) {
                res.writeHead(
                  401,
                  {
                    "Content-Type":
                      "application/json",
                  }
                );

                res.end(
                  JSON.stringify({
                    success: false,
                    error:
                      "Unauthorized",
                  })
                );

                return;
              }

              const result =
                await runCycle();

              res.writeHead(
                result.success
                  ? 200
                  : 500,
                {
                  "Content-Type":
                    "application/json",
                }
              );

              res.end(
                JSON.stringify(
                  result,
                  null,
                  2
                )
              );
            } catch (error) {
              res.writeHead(
                500,
                {
                  "Content-Type":
                    "application/json",
                }
              );

              res.end(
                JSON.stringify({
                  success: false,
                  error:
                    error.message,
                })
              );
            }
          }
        );

        return;
      }

      // ------------------------------------------------------
      // 404
      // ------------------------------------------------------

      res.writeHead(
        404,
        {
          "Content-Type":
            "application/json",
        }
      );

      res.end(
        JSON.stringify({
          success: false,
          error: "Not found",
        })
      );
    }
  );

// ============================================================
// STARTUP
// ============================================================

async function start() {
  console.log(
    "\n============================================================"
  );

  console.log(
    "🤖 BINANCE SQUARE AI BOT V11.0.1"
  );

  console.log(
    "============================================================"
  );

  console.log(
    `🌎 Timezone: ${BOT_TIMEZONE}`
  );

  console.log(
    `🏷️ Max hashtags: ${MAX_HASHTAGS}`
  );

 
