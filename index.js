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
BINANCE SQUARE AI BOT V3.0.0 – PRODUCTION SAFE
=========================================================

FIXES:
- Render production startup fixed
- HTTP health server starts BEFORE first bot cycle
- Binance 451 handled automatically
- CoinGecko bulk market request
- CoinGecko 429 retry/backoff
- CoinGecko OHLC failure no longer kills cycle
- Market-data degradation support
- Atomic JSON state writes
- Corrupted/missing state recovery
- State errors never kill bot
- Bot remains alive after failed cycles
- 4+ hashtags
- Random topics
- Duplicate protection disabled
- Safety checks do not reject posts
- Binance Square publishing preserved

FLOW:

Render
  ↓
Health server starts immediately
  ↓
Market data
  ↓
Binance
  ↓
CoinGecko bulk fallback
  ↓
Technical data if available
  ↓
Groq
  ↓
Binance Square
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

const STATE_FILE = path.join(__dirname, "bot-state.json");

const SQUARE_SCRIPT = path.join(
  __dirname,
  ".agents",
  "skills",
  "square-post",
  "scripts",
  "post-text.mjs",
);

const GENERATION_MAX_TOKENS = 1300;

const HARD_PROMPT_CHARS = 16000;

/* =======================================================
   API URLS
======================================================= */

const BINANCE_BASE_URLS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
];

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

/* =======================================================
   COIN MAPPING
======================================================= */

const COINS = [
  {
    symbol: "BTCUSDT",
    name: "Bitcoin",
    short: "BTC",
    geckoId: "bitcoin",
  },
  {
    symbol: "ETHUSDT",
    name: "Ethereum",
    short: "ETH",
    geckoId: "ethereum",
  },
  {
    symbol: "BNBUSDT",
    name: "BNB",
    short: "BNB",
    geckoId: "binancecoin",
  },
  {
    symbol: "SOLUSDT",
    name: "Solana",
    short: "SOL",
    geckoId: "solana",
  },
  {
    symbol: "XRPUSDT",
    name: "XRP",
    short: "XRP",
    geckoId: "ripple",
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

  const extras = [
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
  ];

  qs.push(...extras);

  return qs;
}

const QUESTION_POOL = generateQuestions();

/* =======================================================
   VALIDATION
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

const DEFAULT_STATE = {
  date: new Date().toISOString().slice(0, 10),
  postsToday: 0,
  totalPosts: 0,
  totalFailures: 0,
  totalSkipped: 0,
  lastPostAt: null,
  history: [],
};

let state = {
  ...DEFAULT_STATE,
};

/* =======================================================
   LOAD STATE
======================================================= */

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");

    if (!raw.trim()) {
      console.log("⚠️ State file is empty. Starting fresh.");

      state = {
        ...DEFAULT_STATE,
      };

      return;
    }

    const parsed = JSON.parse(raw);

    state = {
      ...DEFAULT_STATE,
      ...parsed,

      history: Array.isArray(parsed.history) ? parsed.history : [],

      postsToday: Number.isFinite(Number(parsed.postsToday))
        ? Number(parsed.postsToday)
        : 0,

      totalPosts: Number.isFinite(Number(parsed.totalPosts))
        ? Number(parsed.totalPosts)
        : 0,

      totalFailures: Number.isFinite(Number(parsed.totalFailures))
        ? Number(parsed.totalFailures)
        : 0,

      totalSkipped: Number.isFinite(Number(parsed.totalSkipped))
        ? Number(parsed.totalSkipped)
        : 0,
    };

    console.log("💾 State loaded successfully.");
    console.log(`   Posts today: ${state.postsToday}`);
    console.log(`   Total posts: ${state.totalPosts}`);
    console.log(`   History: ${state.history.length}`);
  } catch (error) {
    console.warn(`⚠️ Could not load state file: ${error.message}`);

    console.log("🔄 Starting with fresh in-memory state.");

    state = {
      ...DEFAULT_STATE,
    };

    try {
      await saveState();
    } catch {
      console.warn("⚠️ Could not create state file. Continuing in memory.");
    }
  }

  resetDailyCounter();
}

/* =======================================================
   SAVE STATE
======================================================= */

async function saveState() {
  try {
    const tempFile = `${STATE_FILE}.tmp`;

    const data = JSON.stringify(state, null, 2);

    /*
      Atomic write.

      Instead of:

      bot-state.json ← overwrite

      we do:

      bot-state.json.tmp ← write
      ↓
      rename
      ↓
      bot-state.json
    */

    await fs.writeFile(tempFile, data, "utf8");

    await fs.rename(tempFile, STATE_FILE);

    return true;
  } catch (error) {
    console.warn(`⚠️ State persistence failed: ${error.message}`);

    console.warn("⚠️ Bot will continue using in-memory state.");

    return false;
  }
}

/* =======================================================
   DAILY RESET
======================================================= */

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
   SLEEP
======================================================= */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =======================================================
   HTTP FETCH WITH TIMEOUT
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

  const error = new Error(`Binance 24h failed for ${symbol}`);

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
      console.warn(`   ⚠️ Binance klines ${base} failed: ${error.message}`);
    }
  }

  const error = new Error(`Binance klines failed for ${symbol}`);

  error.lastStatus = lastStatus;

  throw error;
}

/* =======================================================
   COINGECKO REQUEST WITH RETRY
======================================================= */

async function fetchCoinGecko(url, retries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 BinanceSquareBot/3.0",
        },
      });

      if (response.ok) {
        return await response.json();
      }

      const status = response.status;

      if (status === 429) {
        const retryAfter = response.headers.get("retry-after");

        let waitMs;

        if (retryAfter) {
          const seconds = Number(retryAfter);

          waitMs = Number.isFinite(seconds) ? seconds * 1000 : 5000;
        } else {
          waitMs = Math.min(15000, 2000 * Math.pow(2, attempt - 1));
        }

        console.warn(
          `   ⚠️ CoinGecko rate limited (429). Waiting ${Math.ceil(
            waitMs / 1000,
          )}s...`,
        );

        await sleep(waitMs);

        continue;
      }

      throw new Error(`CoinGecko HTTP ${status}`);
    } catch (error) {
      lastError = error;

      if (attempt < retries) {
        const waitMs = 1500 * attempt;

        console.warn(`   ⚠️ CoinGecko request failed: ${error.message}`);

        await sleep(waitMs);
      }
    }
  }

  throw lastError || new Error("CoinGecko request failed");
}

/* =======================================================
   COINGECKO BULK 24H DATA
======================================================= */

async function coingeckoBulk24hData() {
  const ids = COINS.map((coin) => coin.geckoId).join(",");

  const url =
    `${COINGECKO_BASE}/coins/markets` +
    `?vs_currency=usd` +
    `&ids=${encodeURIComponent(ids)}` +
    `&order=market_cap_desc` +
    `&per_page=10` +
    `&page=1` +
    `&sparkline=false` +
    `&price_change_percentage=24h`;

  console.log("\n   🌐 CoinGecko bulk request...");

  const data = await fetchCoinGecko(url, 3);

  if (!Array.isArray(data) || !data.length) {
    throw new Error("CoinGecko returned no market data");
  }

  const result = new Map();

  for (const item of data) {
    const coin = COINS.find((c) => c.geckoId === item.id);

    if (!coin) continue;

    const price = Number(item.current_price || 0);

    const changePercent = Number(item.price_change_percentage_24h || 0);

    const change = price * (changePercent / 100);

    const open = price - change;

    result.set(coin.symbol, {
      symbol: coin.symbol,
      price,
      open,
      high: Number(item.high_24h || price),
      low: Number(item.low_24h || price),
      change,
      changePercent,
      volume: Number(item.total_volume || 0),
      quoteVolume: Number(item.total_volume || 0),
      trades: 0,
    });
  }

  return result;
}

/* =======================================================
   COINGECKO OHLC
======================================================= */

async function coingeckoKlines(symbol, interval, limit = 50) {
  const coin = COINS.find((c) => c.symbol === symbol);

  if (!coin) {
    throw new Error(`No CoinGecko mapping for ${symbol}`);
  }

  /*
    CoinGecko public OHLC:
    days=1 gives higher-resolution recent data.
    days=7 gives lower-resolution data.

    We use:
      1h → 1 day
      4h → 7 days
  */

  const days = interval === "1h" ? 1 : 7;

  const url =
    `${COINGECKO_BASE}/coins/${coin.geckoId}/ohlc` +
    `?vs_currency=usd&days=${days}`;

  const raw = await fetchCoinGecko(url, 2);

  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`CoinGecko returned no OHLC for ${symbol}`);
  }

  const candles = raw.map((candle) => ({
    openTime: Number(candle[0]),
    open: Number(candle[1]),
    high: Number(candle[2]),
    low: Number(candle[3]),
    close: Number(candle[4]),
    volume: 0,
    closeTime: Number(candle[0]),
  }));

  return candles.slice(-limit);
}

/* =======================================================
   TECHNICAL DATA FALLBACK
======================================================= */

function buildFallbackCandles(ticker) {
  /*
    These are NOT fake historical candles.

    We create a minimal single observation
    so the rest of the application can continue
    without pretending historical technical data
    exists.
  */

  return [
    {
      openTime: Date.now(),
      open: ticker.open,
      high: ticker.high,
      low: ticker.low,
      close: ticker.price,
      volume: ticker.volume,
      closeTime: Date.now(),
    },
  ];
}

/* =======================================================
   UNIFIED 24H DATA
======================================================= */

let coinGeckoBulkCache = null;
let coinGeckoBulkCacheTime = 0;

const COINGECKO_CACHE_MS = 5 * 60 * 1000;

async function get24hData(symbol) {
  /*
    First try Binance.

    Render may receive HTTP 451,
    so we automatically switch to
    CoinGecko.
  */

  try {
    return await binance24hData(symbol);
  } catch (error) {
    console.warn(
      `   ↪️ Binance unavailable for ${symbol} (${error.lastStatus || error.message})`,
    );
  }

  /*
    CoinGecko bulk cache.

    This prevents five separate
    CoinGecko requests.
  */

  const now = Date.now();

  if (
    !coinGeckoBulkCache ||
    now - coinGeckoBulkCacheTime > COINGECKO_CACHE_MS
  ) {
    try {
      coinGeckoBulkCache = await coingeckoBulk24hData();

      coinGeckoBulkCacheTime = now;
    } catch (error) {
      console.warn(`   ❌ CoinGecko bulk request failed: ${error.message}`);

      throw new Error(
        `Binance and CoinGecko unavailable for ${symbol}: ${error.message}`,
      );
    }
  }

  const ticker = coinGeckoBulkCache.get(symbol);

  if (!ticker) {
    throw new Error(`No CoinGecko data for ${symbol}`);
  }

  console.log(`      ✅ CoinGecko bulk fallback succeeded for ${symbol}`);

  return ticker;
}

/* =======================================================
   UNIFIED KLINES
======================================================= */

async function getKlines(symbol, interval, limit = 50, ticker = null) {
  try {
    return await binanceKlines(symbol, interval, limit);
  } catch (error) {
    console.warn(
      `   ↪️ Binance ${interval} klines unavailable for ${symbol} (${error.lastStatus || error.message})`,
    );
  }

  /*
    Try CoinGecko OHLC.

    If CoinGecko is rate limited,
    we don't kill the entire cycle.
  */

  try {
    const data = await coingeckoKlines(symbol, interval, limit);

    console.log(`      ✅ CoinGecko ${interval} data succeeded for ${symbol}`);

    return data;
  } catch (error) {
    console.warn(
      `      ⚠️ CoinGecko ${interval} unavailable for ${symbol}: ${error.message}`,
    );

    /*
      Graceful degradation.

      The bot can still generate
      a market post using current
      ticker data.
    */

    if (ticker) {
      console.log(`      ↪️ Using current market snapshot for ${symbol}`);

      return buildFallbackCandles(ticker);
    }

    return [];
  }
}

/* =======================================================
   TECHNICAL ANALYSIS
======================================================= */

function calculateSMA(candles, period) {
  if (!candles || candles.length < period) {
    return null;
  }

  const values = candles.slice(-period).map((c) => c.close);

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function calculateRange(candles) {
  if (!candles || !candles.length) {
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
  if (!candles || candles.length <= lookback) {
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
  if (!candles || candles.length <= period) {
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

/* =======================================================
   ANALYZE CANDLES
======================================================= */

function analyzeCandles(candles) {
  if (!candles || !candles.length) {
    return {
      latestClose: null,
      sma20: null,
      sma50: null,
      momentum: null,
      volumeRatio: null,
      recent20Range: null,
      trend: "neutral",
      dataAvailable: false,
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

    dataAvailable: candles.length > 1,
  };
}

/* =======================================================
   MARKET DATA
======================================================= */

async function getMarketData() {
  console.log("\n📊 Collecting live market intelligence...");

  const markets = [];

  for (const coin of COINS) {
    try {
      console.log(`\n   🔎 ${coin.name}`);

      /*
        24h ticker.

        Binance first.
        CoinGecko bulk fallback second.
      */

      const ticker = await get24hData(coin.symbol);

      /*
        Technical data.

        Binance first.
        CoinGecko second.
        Current snapshot fallback third.
      */

      const candles1h = await getKlines(coin.symbol, "1h", 50, ticker);

      const candles4h = await getKlines(coin.symbol, "4h", 50, ticker);

      const technical1h = analyzeCandles(candles1h);

      const technical4h = analyzeCandles(candles4h);

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
        `      Technical data: ${
          technical4h.dataAvailable ? "AVAILABLE" : "LIMITED"
        }`,
      );
    } catch (error) {
      console.error(`      ❌ Failed: ${error.message}`);
    }
  }

  /*
    IMPORTANT:

    Previously the entire cycle failed
    when no market data was collected.

    We still require at least one coin,
    but one failed API should not kill
    everything.
  */

  if (!markets.length) {
    throw new Error(
      "No market data could be collected from Binance or CoinGecko.",
    );
  }

  console.log(
    `\n📊 Market data collected for ${markets.length}/${COINS.length} coins.`,
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
   NEWS RESEARCH
======================================================= */

async function researchNews(markets) {
  console.log("\n📰 No external news research – using market data only.");

  return (
    "No external news research performed. " +
    "All analysis is based on available market data."
  );
}

/* =======================================================
   RECENT POST MEMORY
======================================================= */

function getRecentPostMemory() {
  if (!Array.isArray(state.history)) {
    return "";
  }

  return state.history
    .slice(-12)
    .map(
      (post) =>
        `${post.topic}: ${String(post.text || "")
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

  const match = String(raw).match(/\{[\s\S]*\}/);

  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {}
  }

  return null;
}

/* =======================================================
   GROQ GENERATION
======================================================= */

async function callGeneration(prompt, maxTokens, retries = 3) {
  const system = `
You are a crypto journalist creating casual Binance Square content.

Output ONLY valid JSON with:

title,
topic,
content,
qualityScore,
newsUsed,
catalystConfidence,
skip,
skipReason.

Do not invent market data.
Do not claim unverified news as fact.
If a catalyst is unknown, say:
"No confirmed catalyst found."
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
        throw new Error("Groq returned invalid JSON");
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

      await sleep(1500 * attempt);
    }
  }
}

/* =======================================================
   HASHTAGS
======================================================= */

function ensureHashtags(content, topic = "crypto") {
  const hashtags = String(content).match(/#[a-zA-Z0-9_]+/g) || [];

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

  if (toAdd.length < missing) {
    const fallback = ["#Crypto", "#Trading", "#MarketUpdate", "#Binance"];

    const additional = fallback
      .filter(
        (tag) =>
          !existing.has(tag.toLowerCase()) &&
          !toAdd.some((x) => x.toLowerCase() === tag.toLowerCase()),
      )
      .slice(0, missing - toAdd.length);

    toAdd.push(...additional);
  }

  while (toAdd.length < missing) {
    toAdd.push("#CryptoUpdate");
  }

  const lines = String(content).split("\n");

  let insertIndex = lines.length;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].toLowerCase().includes("not financial advice")) {
      insertIndex = i;
      break;
    }
  }

  lines.splice(insertIndex, 0, toAdd.join(" "));

  return lines.join("\n");
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

NEWS RESEARCH:
${compactNews}

RECENT POSTS:
${recentPosts || "None"}

Create a Binance Square post that directly answers the question.

Rules:

- Use only the supplied market data.
- Do not invent news.
- If no catalyst is known, say "No confirmed catalyst found."
- Do not give direct buy/sell instructions.
- Do not promise profits.
- End with "Not financial advice."
- Use at least 4 relevant hashtags.
- Keep the post readable and engaging.
- Target approximately 900-1600 characters.
- Casual crypto-community style is acceptable.
- Ask a simple question at the end to encourage comments.

Return JSON:

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
`.slice(0, HARD_PROMPT_CHARS);

  try {
    let post = await callGeneration(prompt, GENERATION_MAX_TOKENS, 3);

    post.content = ensureHashtags(post.content, post.topic);

    return post;
  } catch (error) {
    console.error("⚠️ Generation failed. Building fallback post.");

    let post = buildFallbackPost(markets, question);

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

  const name = top.name;

  const symbol = top.short;

  const intros = [
    `Here's my take on "${question}" based on the latest market data.`,
    `Let's look at "${question}" using the latest numbers.`,
    `Quick market check: "${question}"`,
    `Answering "${question}" with the current market snapshot.`,
  ];

  const intro = intros[Math.floor(Math.random() * intros.length)];

  const content = `
📊 ${intro}

Top mover:
${name} (${symbol}) is currently around $${formatNumber(
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

4h trend snapshot:

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

⚠️ Important:
Market conditions can change quickly. Watch price structure, momentum and volume rather than relying on one indicator.

What's your view on the market right now?

Not financial advice.
`.trim();

  return {
    title: `Market Update: ${question.slice(0, 50)}`,

    topic: symbol.toLowerCase(),

    content,

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

function validatePost(post, markets) {
  const reasons = [];

  if (!post) {
    return {
      valid: false,
      reasons: ["empty post"],
    };
  }

  const content = String(post.content || "").trim();

  if (content.length < 50) {
    reasons.push("post is too short (<50 chars)");
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
    reasons.push(`hashtags count: ${hashtags.length} (expected 4+)`);
  }

  return {
    valid: true,
    reasons,
  };
}

/* =======================================================
   DUPLICATE
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
  if (!Array.isArray(state.history)) {
    state.history = [];
  }

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

  console.log("🚀 BINANCE SQUARE AI BOT V3.0.0");

  console.log("================================================");

  console.log(`🕐 ${new Date().toLocaleString()}`);

  console.log(`📅 Posts: ${state.postsToday}/${MAX_POSTS_PER_DAY}`);

  if (state.postsToday >= MAX_POSTS_PER_DAY) {
    console.log("\n🛑 Daily limit reached.");

    return;
  }

  try {
    const markets = await getMarketData();

    const news = await researchNews(markets);

    console.log("\n📰 Research summary received.");

    const post = await generatePost(markets, news);

    console.log("\n📝 Topic:", post.topic);

    console.log("⭐ Quality:", `${post.qualityScore}/10`);

    console.log("📰 News used:", post.newsUsed);

    console.log("🎯 Catalyst confidence:", post.catalystConfidence);

    if (post.skip) {
      console.log("\n⏭️ AI skipped this cycle.");

      console.log("Reason:", post.skipReason);

      state.totalSkipped++;

      await saveState();

      return;
    }

    console.log("\n🛡️ Running basic safety check...");

    const validation = validatePost(post, markets);

    if (validation.reasons.length > 0) {
      console.log("⚠️ Warnings (but we'll still post):");

      for (const reason of validation.reasons) {
        console.log(`   • ${reason}`);
      }
    } else {
      console.log("   ✓ All safety checks passed.");
    }

    console.log("   ✓ Duplicate check disabled – posting.");

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

    /*
      Safety timeout.

      If the HTTP server refuses
      to close, don't keep the
      process hanging forever.
    */

    setTimeout(() => {
      console.log("👋 Force stopping process.");

      process.exit(0);
    }, 5000);
  } else {
    console.log("👋 Bot stopped safely.");

    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

/* =======================================================
   START – BOT + HTTP SERVER
======================================================= */

async function startBotAndServer() {
  await loadState();

  console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║       🤖 BINANCE SQUARE AI BOT V3.0.0           ║
║                                                  ║
║       PRODUCTION SAFE                            ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);

  console.log(`🧠 Provider: Groq`);

  console.log(`🧠 Model: ${GROQ_MODEL}`);

  console.log(`⚡ TPM optimization: ENABLED`);

  console.log(`⏱️ Interval: ${POST_INTERVAL_MINUTES} minutes`);

  console.log(`🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`);

  console.log(`📊 Binance: multi-endpoint`);

  console.log(`🔄 CoinGecko: bulk fallback + retry`);

  console.log(`📰 Live news research: DISABLED`);

  console.log(`🛡️ Quality gate: SAFETY ONLY`);

  console.log(`🔎 Duplicate protection: DISABLED`);

  console.log(`📡 Binance Square: ENABLED`);

  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);

  console.log(`❓ Question pool size: ${QUESTION_POOL.length}`);

  /* =====================================================
     HEALTH SERVER FIRST
  ===================================================== */

  const PORT = Number(process.env.PORT) || 3000;

  httpServer = http.createServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "application/json",

      "Cache-Control": "no-cache",
    });

    res.end(
      JSON.stringify({
        status: "alive",

        postsToday: state.postsToday,

        totalPosts: state.totalPosts,

        totalFailures: state.totalFailures,

        totalSkipped: state.totalSkipped,

        uptime: process.uptime(),

        timestamp: new Date().toISOString(),
      }),
    );
  });

  httpServer.on("error", (error) => {
    console.error("❌ HTTP server error:", error.message);
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);

    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`🟢 Health server running on port ${PORT}`);

      resolve();
    });
  });

  /* =====================================================
     SERVER READY
  ===================================================== */

  console.log("\n🚀 Production server is ready.");

  console.log("🚀 Starting first cycle...");

  /*
    IMPORTANT:

    Do NOT await the first cycle here.

    Render already sees the HTTP server.
  */

  runCycle()
    .then(() => {
      console.log(`\n⏳ Next cycle in ${POST_INTERVAL_MINUTES} minutes.`);
    })
    .catch((error) => {
      console.error("❌ First cycle failed:", error.message);
    });

  /* =====================================================
     CONTINUOUS LOOP
  ===================================================== */

  const interval = POST_INTERVAL_MINUTES * 60 * 1000;

  console.log("\n🟢 Bot is running continuously.");

  console.log(`⏳ Next scheduled cycle in ${POST_INTERVAL_MINUTES} minutes.`);

  setInterval(async () => {
    if (shuttingDown) {
      return;
    }

    try {
      await runCycle();
    } catch (error) {
      console.error("❌ Scheduled cycle failed:", error.message);
    }

    console.log(`\n⏳ Next cycle in ${POST_INTERVAL_MINUTES} minutes.`);
  }, interval);
}

/* =======================================================
   START
======================================================= */

startBotAndServer().catch(async (error) => {
  console.error("💥 Fatal startup error:", error);

  try {
    await saveState();
  } catch {}

  process.exit(1);
});
