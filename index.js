import Groq from "groq-sdk";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import http from "http";

dotenv.config();

/*
=========================================================
BINANCE SQUARE AI BOT V3.1.0
Production Stable Market Data Version
=========================================================

MARKET DATA FLOW:

1. Binance API
   ↓
2. If Binance = 451 / unavailable
   ↓
3. CoinGecko BULK endpoint for 24h market data
   ↓
4. Coinbase public candles for technical analysis
   ↓
5. If technical data fails, use available ticker data

IMPORTANT:
- We DO NOT call CoinGecko once per coin anymore.
- We DO NOT call CoinGecko OHLC anymore.
- This dramatically reduces 429 rate-limit problems.
- Binance 451 is expected on some Render regions.
- State file is written safely.
- Bot remains alive if one provider fails.
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

const POST_INTERVAL_MINUTES = Number(process.env.POST_INTERVAL_MINUTES || 40);

const MAX_POSTS_PER_DAY = Number(process.env.MAX_POSTS_PER_DAY || 36);

const MAX_HISTORY = Number(process.env.MAX_HISTORY || 200);

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);

const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

/*
IMPORTANT:

Render's filesystem is ephemeral.

The bot can still use a JSON file during runtime,
but it should never depend on the JSON file being
permanently stored after a restart.
*/

const STATE_FILE = path.join(__dirname, "bot-state.json");

const GENERATION_MAX_TOKENS = 1300;

const SQUARE_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-text.mjs",
);

/* =======================================================
   BINANCE
======================================================= */

const BINANCE_BASE_URLS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
];

/* =======================================================
   COINGECKO
======================================================= */

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

/*
One CoinGecko request gets ALL required coins.
*/

const COINGECKO_IDS = {
  BTCUSDT: "bitcoin",
  ETHUSDT: "ethereum",
  BNBUSDT: "binancecoin",
  SOLUSDT: "solana",
  XRPUSDT: "ripple",
};

/* =======================================================
   COINBASE
=======================================================

Coinbase Exchange public candles.

No API key required for public market candles.

BTC → BTC-USD
ETH → ETH-USD
BNB → BNB-USD
SOL → SOL-USD
XRP → XRP-USD

======================================================= */

const COINBASE_PRODUCTS = {
  BTCUSDT: "BTC-USD",
  ETHUSDT: "ETH-USD",
  BNBUSDT: "BNB-USD",
  SOLUSDT: "SOL-USD",
  XRPUSDT: "XRP-USD",
};

const COINBASE_BASE = "https://api.exchange.coinbase.com";

/* =======================================================
   COINS
======================================================= */

const COINS = [
  {
    symbol: "BTCUSDT",
    name: "Bitcoin",
    short: "BTC",
  },
  {
    symbol: "ETHUSDT",
    name: "Ethereum",
    short: "ETH",
  },
  {
    symbol: "BNBUSDT",
    name: "BNB",
    short: "BNB",
  },
  {
    symbol: "SOLUSDT",
    name: "Solana",
    short: "SOL",
  },
  {
    symbol: "XRPUSDT",
    name: "XRP",
    short: "XRP",
  },
];

/* =======================================================
   QUESTIONS
======================================================= */

const subjects = [
  "Bitcoin",
  "BTC",
  "Ethereum",
  "ETH",
  "BNB",
  "Solana",
  "XRP",
  "the crypto market",
  "altcoins",
  "the top 5 coins",
  "market sentiment",
];

const actions = [
  "why is it moving today?",
  "what are the key support and resistance levels?",
  "what is the current trend?",
  "is it overbought or oversold?",
  "what does the volume say?",
  "what is the short-term outlook?",
  "what is the medium-term outlook?",
  "how does it compare to other coins?",
  "what are the main drivers?",
  "what should traders watch?",
  "is there a breakout or breakdown?",
  "what is the risk/reward setup?",
  "what does the momentum indicate?",
  "are bulls or bears in control?",
  "what is the next key level?",
];

function generateQuestions() {
  const qs = [];

  for (const subject of subjects) {
    for (const action of actions) {
      qs.push(`${subject} – ${action}`);
    }
  }

  qs.push(
    "What is the biggest mover today and why?",
    "Which coin shows the strongest momentum?",
    "What is the market cap dominance of Bitcoin?",
    "Are we in a risk-on or risk-off environment?",
    "What is the correlation between BTC and ETH?",
    "How does the 4h trend look for each coin?",
    "What are the top gainers and losers?",
    "Is there a potential reversal signal?",
    "What is the overall market structure?",
    "Which coin is most volatile right now?",
    "What does the volume spike indicate?",
    "Is the market consolidating or trending?",
  );

  return qs;
}

const QUESTION_POOL = generateQuestions();

/* =======================================================
   ENV VALIDATION
======================================================= */

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY is missing.");
  process.exit(1);
}

if (!BINANCE_SQUARE_OPENAPI_KEY) {
  console.error("❌ BINANCE_SQUARE_OPENAPI_KEY is missing.");
  process.exit(1);
}

const groq = new Groq({
  apiKey: GROQ_API_KEY,
});

/* =======================================================
   STATE
======================================================= */

let state = {
  date: new Date().toISOString().slice(0, 10),
  postsToday: 0,
  totalPosts: 0,
  totalFailures: 0,
  totalSkipped: 0,
  lastPostAt: null,
  history: [],
};

/* =======================================================
   SAFE STATE LOADING
======================================================= */

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");

    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object") {
      state = {
        ...state,
        ...parsed,
      };
    }

    console.log("💾 State file loaded.");
  } catch (error) {
    console.log("ℹ️ No existing state file found. Starting fresh.");

    await saveState();
  }

  resetDailyCounter();
}

/* =======================================================
   SAFE STATE SAVING
======================================================= */

async function saveState() {
  try {
    const tempFile = `${STATE_FILE}.tmp`;

    const data = JSON.stringify(state, null, 2);

    /*
    Write temporary file first.

    This prevents a partially written JSON file
    if the process gets interrupted during writing.
    */

    await fs.writeFile(tempFile, data, "utf8");

    await fs.rename(tempFile, STATE_FILE);
  } catch (error) {
    console.error("⚠️ Failed to save state:", error.message);
  }
}

function resetDailyCounter() {
  const today = new Date().toISOString().slice(0, 10);

  if (state.date !== today) {
    console.log("📅 New day detected. Resetting daily counter.");

    state.date = today;
    state.postsToday = 0;

    saveState().catch(() => {});
  }
}

/* =======================================================
   HTTP
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
   BINANCE 24H
======================================================= */

async function binance24hData(symbol) {
  let lastStatus = null;

  for (const base of BINANCE_BASE_URLS) {
    const url = `${base}/api/v3/ticker/24hr?symbol=${symbol}`;

    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      });

      if (response.ok) {
        const data = await response.json();

        return {
          symbol: data.symbol,
          price: Number(data.lastPrice),
          open: Number(data.openPrice),
          high: Number(data.highPrice),
          low: Number(data.lowPrice),
          change: Number(data.priceChange),
          changePercent: Number(data.priceChangePercent),
          volume: Number(data.volume),
          quoteVolume: Number(data.quoteVolume),
          trades: Number(data.count),
        };
      }

      lastStatus = response.status;
    } catch (error) {
      console.warn(`   ⚠️ Binance 24h ${base} failed: ${error.message}`);
    }
  }

  const error = new Error(`Binance 24h unavailable for ${symbol}`);

  error.lastStatus = lastStatus;

  throw error;
}

/* =======================================================
   BINANCE KLINES
======================================================= */

async function binanceKlines(symbol, interval, limit = 50) {
  let lastStatus = null;

  for (const base of BINANCE_BASE_URLS) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;

    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      });

      if (response.ok) {
        const raw = await response.json();

        return raw.map((candle) => ({
          openTime: Number(candle[0]),
          open: Number(candle[1]),
          high: Number(candle[2]),
          low: Number(candle[3]),
          close: Number(candle[4]),
          volume: Number(candle[5]),
          closeTime: Number(candle[6]),
        }));
      }

      lastStatus = response.status;
    } catch (error) {
      console.warn(
        `   ⚠️ Binance ${interval} ${base} failed: ${error.message}`,
      );
    }
  }

  const error = new Error(`Binance klines unavailable for ${symbol}`);

  error.lastStatus = lastStatus;

  throw error;
}

/* =======================================================
   COINGECKO BULK MARKET DATA
=======================================================

ONE REQUEST FOR ALL COINS.

This is the most important production fix.

Before:

BTC → CoinGecko
ETH → CoinGecko
BNB → CoinGecko
SOL → CoinGecko
XRP → CoinGecko

Now:

ALL 5 COINS → ONE REQUEST

======================================================= */

let coinGeckoCache = null;
let coinGeckoCacheTime = 0;

const COINGECKO_CACHE_MS = 5 * 60 * 1000;

async function getCoinGeckoBulk() {
  const now = Date.now();

  if (coinGeckoCache && now - coinGeckoCacheTime < COINGECKO_CACHE_MS) {
    return coinGeckoCache;
  }

  const ids = Object.values(COINGECKO_IDS).join(",");

  const url =
    `${COINGECKO_BASE}/coins/markets` +
    `?vs_currency=usd` +
    `&ids=${ids}` +
    `&price_change_percentage=24h` +
    `&per_page=10` +
    `&page=1`;

  console.log("   🌐 CoinGecko bulk request...");

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (response.status === 429) {
    throw new Error("CoinGecko rate limited (429)");
  }

  if (!response.ok) {
    throw new Error(`CoinGecko API failed: ${response.status}`);
  }

  const raw = await response.json();

  const map = {};

  for (const coin of raw) {
    map[coin.id] = coin;
  }

  coinGeckoCache = map;

  coinGeckoCacheTime = now;

  return map;
}

/* =======================================================
   COINGECKO SINGLE TICKER FROM BULK CACHE
======================================================= */

async function coingecko24hData(symbol) {
  const id = COINGECKO_IDS[symbol];

  if (!id) {
    throw new Error(`No CoinGecko mapping for ${symbol}`);
  }

  const dataMap = await getCoinGeckoBulk();

  const data = dataMap[id];

  if (!data) {
    throw new Error(`CoinGecko returned no data for ${symbol}`);
  }

  const price = Number(data.current_price);

  const change = Number(data.price_change_24h ?? 0);

  const changePercent = Number(data.price_change_percentage_24h ?? 0);

  return {
    symbol,
    price,
    open: price - change,
    high: Number(data.high_24h ?? price),
    low: Number(data.low_24h ?? price),
    change,
    changePercent,
    volume: Number(data.total_volume ?? 0),
    quoteVolume: Number(data.total_volume ?? 0),
    trades: 0,
  };
}

/* =======================================================
   COINBASE CANDLES
======================================================= */

async function coinbaseKlines(symbol, interval, limit = 50) {
  const product = COINBASE_PRODUCTS[symbol];

  if (!product) {
    throw new Error(`No Coinbase product for ${symbol}`);
  }

  let granularity;

  if (interval === "1h") {
    granularity = 3600;
  } else if (interval === "4h") {
    granularity = 14400;
  } else {
    granularity = 3600;
  }

  /*
  Coinbase maximum candle request
  is limited, so 50 is safe.
  */

  const url =
    `${COINBASE_BASE}/products/${product}/candles` +
    `?granularity=${granularity}`;

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Coinbase ${interval} API failed: ${response.status}`);
  }

  const raw = await response.json();

  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`Coinbase returned no ${interval} candles for ${symbol}`);
  }

  /*
  Coinbase format:

  [
    time,
    low,
    high,
    open,
    close,
    volume
  ]

  Coinbase returns newest first,
  so reverse it.
  */

  return raw
    .slice(0, limit)
    .reverse()
    .map((candle) => ({
      openTime: Number(candle[0]) * 1000,

      low: Number(candle[1]),

      high: Number(candle[2]),

      open: Number(candle[3]),

      close: Number(candle[4]),

      volume: Number(candle[5]),

      closeTime: Number(candle[0]) * 1000,
    }));
}

/* =======================================================
   UNIFIED 24H DATA
======================================================= */

async function get24hData(symbol) {
  try {
    return await binance24hData(symbol);
  } catch (error) {
    console.warn(
      `   ↪️ Binance unavailable for ${symbol} (${error.lastStatus || error.message})`,
    );

    try {
      const data = await coingecko24hData(symbol);

      console.log(`      ✅ CoinGecko bulk fallback succeeded for ${symbol}`);

      return data;
    } catch (fallbackError) {
      console.warn(
        `      ⚠️ CoinGecko fallback failed for ${symbol}: ${fallbackError.message}`,
      );

      throw new Error(`All 24h providers failed for ${symbol}`);
    }
  }
}

/* =======================================================
   UNIFIED KLINES
======================================================= */

async function getKlines(symbol, interval, limit = 50) {
  try {
    return await binanceKlines(symbol, interval, limit);
  } catch (error) {
    console.warn(
      `   ↪️ Binance ${interval} klines unavailable for ${symbol} (${error.lastStatus || error.message})`,
    );

    try {
      const data = await coinbaseKlines(symbol, interval, limit);

      console.log(`      ✅ Coinbase ${interval} data succeeded for ${symbol}`);

      return data;
    } catch (fallbackError) {
      console.warn(
        `      ⚠️ Coinbase ${interval} failed for ${symbol}: ${fallbackError.message}`,
      );

      /*
      Do NOT kill the entire coin.

      Return empty data.
      The bot will use ticker data.
      */

      return [];
    }
  }
}

/* =======================================================
   TECHNICAL ANALYSIS
======================================================= */

function calculateSMA(candles, period) {
  if (candles.length < period) {
    return null;
  }

  const values = candles.slice(-period).map((c) => c.close);

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateRange(candles) {
  if (!candles.length) {
    return null;
  }

  const high = Math.max(...candles.map((c) => c.high));

  const low = Math.min(...candles.map((c) => c.low));

  return {
    high,
    low,
    range: high - low,
  };
}

function calculateMomentum(candles, lookback = 10) {
  if (candles.length <= lookback) {
    return null;
  }

  const current = candles.at(-1).close;

  const previous = candles[candles.length - 1 - lookback].close;

  if (!previous) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function calculateVolumeRatio(candles, period = 20) {
  if (candles.length <= period) {
    return null;
  }

  const current = candles.at(-1).volume;

  const previous = candles.slice(-period - 1, -1).map((c) => c.volume);

  const average =
    previous.reduce((sum, value) => sum + value, 0) / previous.length;

  if (!average) {
    return null;
  }

  return current / average;
}

function analyzeCandles(candles, fallbackPrice) {
  if (!candles || candles.length < 5) {
    return {
      latestClose: fallbackPrice,
      sma20: null,
      sma50: null,
      momentum: null,
      volumeRatio: null,
      recent20Range: null,
      trend: "unknown",
    };
  }

  const latest = candles.at(-1);

  const sma20 = calculateSMA(candles, 20);

  const sma50 = calculateSMA(candles, 50);

  const range = calculateRange(candles.slice(-20));

  const momentum = calculateMomentum(candles, 10);

  const volumeRatio = calculateVolumeRatio(candles, 20);

  let trend = "neutral";

  if (sma20 && latest.close > sma20 && momentum > 0) {
    trend = "bullish";
  }

  if (sma20 && latest.close < sma20 && momentum < 0) {
    trend = "bearish";
  }

  if (Math.abs(momentum || 0) < 1) {
    trend = "sideways";
  }

  return {
    latestClose: latest.close,

    sma20,

    sma50,

    momentum,

    volumeRatio,

    recent20Range: range,

    trend,
  };
}

/* =======================================================
   MARKET DATA
======================================================= */

async function getMarketData() {
  console.log("\n📊 Collecting live market intelligence...");

  const markets = [];

  /*
  IMPORTANT:

  Warm up CoinGecko once.

  If Binance is blocked, all coins
  will share this one request.
  */

  let coinGeckoReady = false;

  try {
    await getCoinGeckoBulk();

    coinGeckoReady = true;

    console.log("   🌐 CoinGecko bulk cache ready.");
  } catch (error) {
    console.warn(`   ⚠️ CoinGecko bulk unavailable: ${error.message}`);
  }

  for (const coin of COINS) {
    try {
      console.log(`\n   🔎 ${coin.name}`);

      let ticker;

      try {
        ticker = await get24hData(coin.symbol);
      } catch (error) {
        console.error(`      ❌ Ticker failed: ${error.message}`);

        /*
        If one coin fails, continue
        with the next coin.
        */

        continue;
      }

      let candles1h = [];
      let candles4h = [];

      try {
        candles1h = await getKlines(coin.symbol, "1h", 50);
      } catch (error) {
        console.warn(`      ⚠️ 1h data unavailable`);
      }

      try {
        candles4h = await getKlines(coin.symbol, "4h", 50);
      } catch (error) {
        console.warn(`      ⚠️ 4h data unavailable`);
      }

      const technical1h = analyzeCandles(candles1h, ticker.price);

      const technical4h = analyzeCandles(candles4h, ticker.price);

      const market = {
        ...coin,

        ticker,

        technical: {
          oneHour: technical1h,

          fourHour: technical4h,
        },
      };

      markets.push(market);

      console.log(`      Price: $${formatNumber(ticker.price)}`);

      console.log(`      24h: ${formatPercent(ticker.changePercent)}`);

      console.log(`      1h trend: ${technical1h.trend}`);

      console.log(`      4h trend: ${technical4h.trend}`);

      console.log(`      4h momentum: ${formatPercent(technical4h.momentum)}`);

      console.log(
        `      Technical data: ${candles4h.length ? "AVAILABLE" : "LIMITED"}`,
      );
    } catch (error) {
      console.error(`      ❌ Failed ${coin.symbol}: ${error.message}`);
    }
  }

  /*
  Do not fail the cycle unless absolutely
  no market data was obtained.
  */

  if (markets.length === 0) {
    throw new Error(
      "No market data could be collected from Binance, CoinGecko, or Coinbase.",
    );
  }

  console.log(
    `\n📊 Successfully collected ${markets.length}/${COINS.length} markets.`,
  );

  return markets;
}

/* =======================================================
   COMPACT MARKET DATA
======================================================= */

function buildCompactMarketData(markets) {
  return markets
    .map((coin) => {
      const t = coin.ticker;

      const h = coin.technical.fourHour;

      const o = coin.technical.oneHour;

      return [
        `${coin.short} ${coin.name}`,
        `price=${t.price}`,
        `24h=${t.changePercent}%`,
        `high=${t.high}`,
        `low=${t.low}`,
        `volume=${t.volume}`,
        `quoteVol=${t.quoteVolume}`,
        `1h=${o.trend}`,
        `1hMom=${o.momentum?.toFixed(2) ?? "NA"}%`,
        `4h=${h.trend}`,
        `4hMom=${h.momentum?.toFixed(2) ?? "NA"}%`,
        `4hVolRatio=${h.volumeRatio?.toFixed(2) ?? "NA"}x`,
        `4hSMA20=${h.sma20 ?? "NA"}`,
        `4hSMA50=${h.sma50 ?? "NA"}`,
        `rangeHigh=${h.recent20Range?.high ?? "NA"}`,
        `rangeLow=${h.recent20Range?.low ?? "NA"}`,
      ].join(" | ");
    })
    .join("\n");
}

/* =======================================================
   NEWS
======================================================= */

async function researchNews(markets) {
  console.log("\n📰 No external news research – using market data only.");

  return (
    "No external news research performed. " +
    "All analysis based on current market data."
  );
}

/* =======================================================
   POST MEMORY
======================================================= */

function getRecentPostMemory() {
  return state.history
    .slice(-12)
    .map(
      (post) =>
        `${post.topic}: ${String(post.text)
          .replace(/\s+/g, " ")
          .slice(0, 180)}`,
    )
    .join("\n");
}

/* =======================================================
   JSON PARSER
======================================================= */

function extractJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {}

  const match = raw.match(/\{[\s\S]*\}/);

  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

/* =======================================================
   GROQ
======================================================= */

async function callGeneration(prompt, maxTokens, retries = 3) {
  const system = `
You are a crypto journalist creating Binance Square posts.

Return ONLY valid JSON.

Required fields:
title
topic
content
qualityScore
newsUsed
catalystConfidence
skip
skipReason

Do not invent market data.
Do not make guaranteed profit claims.
Do not give direct financial advice.
`.trim();

  for (let attempt = 1; attempt <= retries; attempt++) {
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

        temperature: 0.85,

        max_completion_tokens: maxTokens,

        response_format: {
          type: "json_object",
        },
      });

      const raw = response.choices?.[0]?.message?.content;

      if (!raw) {
        throw new Error("Empty Groq response");
      }

      const parsed = extractJSON(raw);

      if (!parsed) {
        throw new Error("Invalid JSON from Groq");
      }

      return {
        title: parsed.title || "Market Update",

        topic: parsed.topic || "market",

        content: parsed.content || "No content generated.",

        qualityScore:
          typeof parsed.qualityScore === "number" ? parsed.qualityScore : 8,

        newsUsed: Boolean(parsed.newsUsed),

        catalystConfidence: parsed.catalystConfidence || "NONE",

        skip: Boolean(parsed.skip),

        skipReason: parsed.skipReason || "",
      };
    } catch (error) {
      console.warn(`   ⚠️ Groq attempt ${attempt} failed: ${error.message}`);

      if (attempt === retries) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
}

/* =======================================================
   HASHTAGS
======================================================= */

function ensureHashtags(content, topic = "crypto") {
  const hashtags = content.match(/#[a-zA-Z0-9_]+/g) || [];

  const missing = 4 - hashtags.length;

  if (missing <= 0) {
    return content;
  }

  const defaultTags = {
    btc: ["#Bitcoin", "#BTC", "#Crypto", "#Trading"],

    eth: ["#Ethereum", "#ETH", "#Crypto", "#Altcoins"],

    bnb: ["#BNB", "#Binance", "#Crypto", "#BSC"],

    sol: ["#Solana", "#SOL", "#Crypto", "#Blockchain"],

    xrp: ["#XRP", "#Ripple", "#Crypto", "#Payments"],

    market: ["#Crypto", "#MarketAnalysis", "#Trading", "#Binance"],
  };

  const tags = defaultTags[String(topic).toLowerCase()] || defaultTags.market;

  const existing = new Set(hashtags.map((tag) => tag.toLowerCase()));

  const toAdd = tags
    .filter((tag) => !existing.has(tag.toLowerCase()))
    .slice(0, missing);

  while (toAdd.length < missing) {
    toAdd.push("#CryptoUpdate");
  }

  return content.trim() + "\n\n" + toAdd.join(" ");
}

/* =======================================================
   GENERATE POST
======================================================= */

async function generatePost(markets, newsResearch) {
  const question =
    QUESTION_POOL[Math.floor(Math.random() * QUESTION_POOL.length)];

  console.log(`\n❓ Question: ${question}`);

  const marketData = buildCompactMarketData(markets);

  const recentPosts = getRecentPostMemory();

  const compactNews = String(newsResearch || "").slice(0, 2000);

  const prompt = `
Answer the following question using the provided market data.

Question:
${question}

MARKET DATA:
${marketData}

NEWS:
${compactNews}

RECENT POSTS:
${recentPosts || "None"}

Create a Binance Square post that directly answers the question.

Rules:

- Use only the provided market data.
- Do not invent news.
- If no catalyst exists, say "No confirmed catalyst found."
- No buy/sell commands.
- No profit promises.
- No guaranteed returns.
- Use at least 4 relevant hashtags.
- Keep the post around 900-1600 characters.
- Make it natural and engaging.
- Ask a simple question at the end to encourage comments.

Return:

{
  "title": "short title",
  "topic": "btc|eth|bnb|sol|xrp|market",
  "content": "full post",
  "qualityScore": 8,
  "newsUsed": false,
  "catalystConfidence": "NONE",
  "skip": false,
  "skipReason": ""
}
`;

  try {
    const post = await callGeneration(prompt, GENERATION_MAX_TOKENS, 3);

    post.content = ensureHashtags(post.content, post.topic);

    return post;
  } catch (error) {
    console.error("⚠️ Groq generation failed. Building fallback post.");

    const post = buildFallbackPost(markets, question);

    post.content = ensureHashtags(post.content, post.topic);

    return post;
  }
}

/* =======================================================
   FALLBACK POST
======================================================= */

function buildFallbackPost(markets, question) {
  const movers = [...markets].sort(
    (a, b) =>
      Math.abs(b.ticker.changePercent) - Math.abs(a.ticker.changePercent),
  );

  const top = movers[0];

  const price = top.ticker.price;

  const change = top.ticker.changePercent;

  const introOptions = [
    `Here's a quick look at "${question}" using the latest market data.`,
    `Let's break down "${question}" using the current numbers.`,
    `Quick market check: "${question}"`,
    `Looking at "${question}" through the latest crypto data.`,
  ];

  const intro = introOptions[Math.floor(Math.random() * introOptions.length)];

  const content = `
📊 ${intro}

${top.name} (${top.short}) is currently trading around $${formatNumber(
    price,
  )}, with a 24h move of ${change >= 0 ? "+" : ""}${change.toFixed(2)}%.

Market snapshot:

${markets
  .map(
    (coin) =>
      `${coin.short}: $${formatNumber(coin.ticker.price)} (${
        coin.ticker.changePercent >= 0 ? "+" : ""
      }${coin.ticker.changePercent.toFixed(2)}%)`,
  )
  .join("\n")}

4h trend overview:

${markets
  .map((coin) => {
    const technical = coin.technical.fourHour;

    return `${coin.short}: ${technical.trend}${
      technical.momentum !== null
        ? ` | momentum ${technical.momentum.toFixed(2)}%`
        : ""
    }`;
  })
  .join("\n")}

No confirmed catalyst found.

The key thing to watch is whether current momentum continues or fades as price approaches recent levels.

What's your view on the market?

Not financial advice.
`;

  return {
    title: `Market Update: ${top.short}`,

    topic: top.short.toLowerCase(),

    content: content.trim(),

    qualityScore: 7,

    newsUsed: false,

    catalystConfidence: "NONE",

    skip: false,

    skipReason: "",
  };
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

  if (content.length < 50) {
    reasons.push("post too short");
  }

  const lower = content.toLowerCase();

  const forbidden = [
    "guaranteed profit",
    "guaranteed return",
    "risk free",
    "risk-free",
    "100% profit",
    "double your money",
    "can't lose",
    "cannot lose",
    "buy now",
    "sell now",
    "easy money",
  ];

  for (const phrase of forbidden) {
    if (lower.includes(phrase)) {
      reasons.push(`forbidden phrase: ${phrase}`);
    }
  }

  const hashtags = content.match(/#[a-zA-Z0-9_]+/g) || [];

  if (hashtags.length < 4) {
    reasons.push(`hashtags count: ${hashtags.length}`);
  }

  return {
    valid: true,
    reasons,
  };
}

/* =======================================================
   DUPLICATE CHECK
======================================================= */

function isDuplicate(content) {
  return {
    duplicate: false,
    score: 0,
  };
}

/* =======================================================
   PUBLISH
======================================================= */

function publishToSquare(content) {
  return new Promise((resolve, reject) => {
    console.log("\n📡 Publishing to Binance Square...");

    if (DRY_RUN) {
      console.log("🧪 DRY_RUN=true");

      console.log("   No real publication will occur.");

      console.log("\n----- GENERATED POST -----\n");

      console.log(content);

      console.log("\n--------------------------\n");

      resolve({
        success: true,
        dryRun: true,
      });

      return;
    }

    const child = spawn("node", [SQUARE_SCRIPT, "--text", content], {
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

    child.on("error", reject);

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Square publisher exited with code ${code}\n${stderr}`),
        );

        return;
      }

      const id = stdout.match(/ID:\s*(.+)/i)?.[1]?.trim() || null;

      const link = stdout.match(/Link:\s*(.+)/i)?.[1]?.trim() || null;

      resolve({
        success: true,
        id,
        link,
        stdout,
      });
    });
  });
}

/* =======================================================
   SAVE POST
======================================================= */

async function savePost(post, result) {
  state.history.push({
    id: result.id || null,

    title: post.title || null,

    topic: post.topic || "market",

    text: post.content,

    qualityScore: post.qualityScore,

    newsUsed: Boolean(post.newsUsed),

    catalystConfidence: post.catalystConfidence,

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
}

/* =======================================================
   MAIN CYCLE
======================================================= */

async function runCycle() {
  resetDailyCounter();

  console.log("\n================================================");

  console.log("🚀 BINANCE SQUARE AI BOT V3.1.0");

  console.log("================================================");

  console.log(`🕐 ${new Date().toLocaleString()}`);

  console.log(`📅 Posts: ${state.postsToday}/${MAX_POSTS_PER_DAY}`);

  if (state.postsToday >= MAX_POSTS_PER_DAY) {
    console.log("\n🛑 Daily limit reached.");

    return;
  }

  try {
    const markets = await getMarketData();

    console.log("\n📰 Researching...");

    const news = await researchNews(markets);

    console.log("📰 Research summary received.");

    const post = await generatePost(markets, news);

    console.log("\n📝 Topic:", post.topic);

    console.log("⭐ Quality:", post.qualityScore + "/10");

    console.log("📰 News used:", post.newsUsed);

    console.log("🎯 Catalyst confidence:", post.catalystConfidence);

    if (post.skip) {
      console.log("\n⏭️ AI skipped this cycle.");

      console.log("Reason:", post.skipReason);

      state.totalSkipped++;

      await saveState();

      return;
    }

    console.log("\n🛡️ Running safety check...");

    const validation = validatePost(post);

    if (validation.reasons.length > 0) {
      console.log("⚠️ Warnings:");

      for (const reason of validation.reasons) {
        console.log(`   • ${reason}`);
      }

      /*
      We intentionally don't reject.
      */
    } else {
      console.log("   ✓ Safety checks passed.");
    }

    const duplicate = isDuplicate(post.content);

    if (duplicate.duplicate) {
      console.log(
        "⚠️ Duplicate detected, but duplicate protection is disabled.",
      );
    }

    console.log("   ✓ Duplicate protection disabled.");

    const result = await publishToSquare(post.content);

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
  } catch (error) {
    state.totalFailures++;

    await saveState();

    console.error("\n❌ Cycle error:");

    console.error(error?.message || error);

    console.log("🛡️ Bot remains alive.");
  }
}

/* =======================================================
   HELPERS
======================================================= */

function formatNumber(number) {
  if (!Number.isFinite(number)) {
    return "N/A";
  }

  return number.toLocaleString("en-US", {
    maximumFractionDigits: 4,
  });
}

function formatPercent(number) {
  if (!Number.isFinite(number)) {
    return "N/A";
  }

  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

/* =======================================================
   SHUTDOWN
======================================================= */

let shuttingDown = false;
let httpServer = null;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`\n\n🛑 ${signal} received.`);

  console.log("💾 Saving state...");

  await saveState();

  if (httpServer) {
    httpServer.close(() => {
      console.log("👋 HTTP server closed.");

      process.exit(0);
    });
  } else {
    console.log("👋 Bot stopped safely.");

    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

/* =======================================================
   HEALTH SERVER
======================================================= */

function startHealthServer() {
  const PORT = process.env.PORT || 3000;

  httpServer = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
    });

    res.end(
      JSON.stringify({
        status: "alive",

        postsToday: state.postsToday,

        totalPosts: state.totalPosts,

        totalFailures: state.totalFailures,

        uptime: process.uptime(),

        timestamp: new Date().toISOString(),
      }),
    );
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`🟢 Health server running on port ${PORT}`);

    console.log("🚀 Production server is ready.");
  });
}

/* =======================================================
   START
======================================================= */

async function startBotAndServer() {
  await loadState();

  console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║       🤖 BINANCE SQUARE AI BOT V3.1.0           ║
║                                                  ║
║     Binance → CoinGecko → Coinbase fallback     ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);

  console.log(`🧠 Provider: Groq`);

  console.log(`🧠 Model: ${GROQ_MODEL}`);

  console.log(`⚡ Production fallback: ENABLED`);

  console.log(`⏱️ Interval: ${POST_INTERVAL_MINUTES} minutes`);

  console.log(`🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`);

  console.log(`📊 Binance market data: PRIMARY`);

  console.log(`🌐 CoinGecko: BULK FALLBACK`);

  console.log(`📈 Coinbase candles: TECHNICAL FALLBACK`);

  console.log(`📰 Live news research: DISABLED`);

  console.log(`🛡️ Quality gate: SAFETY ONLY`);

  console.log(`🔎 Duplicate protection: DISABLED`);

  console.log(`📡 Binance Square: ENABLED`);

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`❓ Question pool size: ${QUESTION_POOL.length}`);

  /*
  START HEALTH SERVER FIRST.

  This is important on Render.

  Render sees the service as healthy
  even if market-data collection takes
  some time.
  */

  startHealthServer();

  console.log("🚀 Starting first cycle...");

  /*
  Do NOT block startup forever.
  */

  await runCycle();

  const interval = POST_INTERVAL_MINUTES * 60 * 1000;

  console.log("\n🟢 Bot is running continuously.");

  console.log(`⏳ Next scheduled cycle in ${POST_INTERVAL_MINUTES} minutes.`);

  setInterval(async () => {
    if (shuttingDown) {
      return;
    }

    await runCycle();

    console.log(
      `\n⏳ Next scheduled cycle in ${POST_INTERVAL_MINUTES} minutes.`,
    );
  }, interval);
}

/* =======================================================
   BOOT
======================================================= */

startBotAndServer().catch(async (error) => {
  console.error("💥 Fatal startup error:", error);

  await saveState();

  process.exit(1);
});
