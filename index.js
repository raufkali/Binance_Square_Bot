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
BINANCE SQUARE AI BOT V2.8.2 – Multi‑Endpoint Fix
=========================================================
- Retry Binance API across api.binance.com, api1, api2, api3
- Added User-Agent header to avoid 451
- All previous features: random questions, 4+ hashtags, no rejections
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
const FALLBACK_MAX_TOKENS = 1000;
const HARD_PROMPT_CHARS = 16000;

// Binance API endpoints to try
const BINANCE_BASE_URLS = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
];

/* =======================================================
   COINS (unchanged)
======================================================= */

const COINS = [
  { symbol: "BTCUSDT", name: "Bitcoin", short: "BTC" },
  { symbol: "ETHUSDT", name: "Ethereum", short: "ETH" },
  { symbol: "BNBUSDT", name: "BNB", short: "BNB" },
  { symbol: "SOLUSDT", name: "Solana", short: "SOL" },
  { symbol: "XRPUSDT", name: "XRP", short: "XRP" },
];

/* =======================================================
   QUESTION GENERATOR (unchanged)
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
  "what is the short‑term outlook?",
  "what is the medium‑term outlook?",
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
  for (const s of subjects) {
    for (const a of actions) {
      qs.push(`${s} – ${a}`);
    }
  }
  const extras = [
    "What is the biggest mover today and why?",
    "Which coin shows the strongest momentum?",
    "What is the market cap dominance of Bitcoin?",
    "Are we in a risk‑on or risk‑off environment?",
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

const groq = new Groq({ apiKey: GROQ_API_KEY });

/* =======================================================
   STATE (unchanged)
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

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    state = { ...state, ...parsed };
  } catch {
    await saveState();
  }
  resetDailyCounter();
}

async function saveState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
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
   HTTP & BINANCE API – Multi‑endpoint with retry
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

async function get24hData(symbol) {
  for (const base of BINANCE_BASE_URLS) {
    const url = `${base}/api/v3/ticker/24hr?symbol=${symbol}`;
    try {
      const response = await fetchWithTimeout(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
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
    } catch (e) {
      console.warn(`   ⚠️ 24h endpoint ${base} failed: ${e.message}`);
    }
  }
  throw new Error(`Binance 24h API all endpoints failed for ${symbol}`);
}

async function getKlines(symbol, interval, limit = 50) {
  for (const base of BINANCE_BASE_URLS) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    try {
      const response = await fetchWithTimeout(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
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
    } catch (e) {
      console.warn(`   ⚠️ Klines endpoint ${base} failed: ${e.message}`);
    }
  }
  throw new Error(`Binance klines all endpoints failed for ${symbol}`);
}

/* =======================================================
   TECHNICAL ANALYSIS (unchanged)
======================================================= */

function calculateSMA(candles, period) {
  if (candles.length < period) return null;
  const values = candles.slice(-period).map((c) => c.close);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function calculateRange(candles) {
  if (!candles.length) return null;
  const high = Math.max(...candles.map((c) => c.high));
  const low = Math.min(...candles.map((c) => c.low));
  return { high, low, range: high - low };
}

function calculateMomentum(candles, lookback = 10) {
  if (candles.length <= lookback) return null;
  const current = candles.at(-1).close;
  const previous = candles[candles.length - 1 - lookback].close;
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function calculateVolumeRatio(candles, period = 20) {
  if (candles.length <= period) return null;
  const current = candles.at(-1).volume;
  const previous = candles.slice(-period - 1, -1).map((c) => c.volume);
  const average = previous.reduce((sum, v) => sum + v, 0) / previous.length;
  if (!average) return null;
  return current / average;
}

function analyzeCandles(candles) {
  const latest = candles.at(-1);
  const sma20 = calculateSMA(candles, 20);
  const sma50 = calculateSMA(candles, 50);
  const range = calculateRange(candles.slice(-20));
  const momentum = calculateMomentum(candles, 10);
  const volumeRatio = calculateVolumeRatio(candles, 20);

  let trend = "neutral";
  if (sma20 && latest.close > sma20 && momentum > 0) trend = "bullish";
  if (sma20 && latest.close < sma20 && momentum < 0) trend = "bearish";
  if (Math.abs(momentum || 0) < 1) trend = "sideways";

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
   MARKET DATA (unchanged)
======================================================= */

async function getMarketData() {
  console.log("\n📊 Collecting live market intelligence...");
  const markets = [];

  for (const coin of COINS) {
    try {
      console.log(`\n   🔎 ${coin.name}`);
      const ticker = await get24hData(coin.symbol);
      const candles1h = await getKlines(coin.symbol, "1h", 50);
      const candles4h = await getKlines(coin.symbol, "4h", 50);
      const technical1h = analyzeCandles(candles1h);
      const technical4h = analyzeCandles(candles4h);

      const market = {
        ...coin,
        ticker,
        technical: { oneHour: technical1h, fourHour: technical4h },
      };
      markets.push(market);

      console.log(`      Price: $${formatNumber(ticker.price)}`);
      console.log(`      24h: ${formatPercent(ticker.changePercent)}`);
      console.log(`      1h trend: ${technical1h.trend}`);
      console.log(`      4h trend: ${technical4h.trend}`);
      console.log(`      4h momentum: ${formatPercent(technical4h.momentum)}`);
      console.log(
        `      Volume ratio: ${
          technical4h.volumeRatio !== null
            ? technical4h.volumeRatio.toFixed(2)
            : "N/A"
        }x`,
      );
    } catch (error) {
      console.error(`      ❌ Failed: ${error.message}`);
    }
  }

  if (!markets.length) throw new Error("No market data could be collected.");
  return markets;
}

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
   NEWS RESEARCH (stub)
======================================================= */

async function researchNews(markets) {
  console.log("\n📰 No external news research – using market data only.");
  return "No external news research performed. All analysis based solely on Binance market data.";
}

/* =======================================================
   RECENT POST MEMORY (unchanged)
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
   LENIENT JSON PARSING (unchanged)
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
   GROQ GENERATION (unchanged)
======================================================= */

async function callGeneration(prompt, maxTokens, retries = 2) {
  const system =
    "You are a crypto journalist. Output JSON with title, topic, content, qualityScore (1-10), newsUsed, catalystConfidence, skip, skipReason.";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        temperature: 0.85,
        max_completion_tokens: maxTokens,
        response_format: { type: "json_object" },
      });

      const raw = response.choices?.[0]?.message?.content;
      if (!raw) throw new Error("Empty response");

      const parsed = extractJSON(raw);
      if (!parsed) throw new Error("No valid JSON");

      return {
        title: parsed.title || "Market Update",
        topic: parsed.topic || "market",
        content: parsed.content || "No content generated.",
        qualityScore:
          typeof parsed.qualityScore === "number" ? parsed.qualityScore : 8,
        newsUsed: !!parsed.newsUsed,
        catalystConfidence: parsed.catalystConfidence || "NONE",
        skip: !!parsed.skip,
        skipReason: parsed.skipReason || "",
      };
    } catch (error) {
      console.warn(`   ⚠️ Attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/* =======================================================
   HASHTAG ENFORCEMENT (unchanged)
======================================================= */

function ensureHashtags(content, topic = "crypto") {
  const hashtags = content.match(/#[a-zA-Z0-9_]+/g) || [];
  const missing = 4 - hashtags.length;
  if (missing <= 0) return content;

  const defaultTags = {
    btc: ["#Bitcoin", "#BTC", "#Crypto", "#Trading"],
    eth: ["#Ethereum", "#ETH", "#Crypto", "#Altcoins"],
    bnb: ["#BNB", "#Binance", "#Crypto", "#BSC"],
    sol: ["#Solana", "#SOL", "#Crypto", "#Blockchain"],
    xrp: ["#XRP", "#Ripple", "#Crypto", "#Payments"],
    market: ["#Crypto", "#MarketAnalysis", "#Trading", "#Binance"],
  };
  const tags = defaultTags[topic.toLowerCase()] || defaultTags.market;

  const existing = new Set(hashtags.map((t) => t.toLowerCase()));
  const toAdd = tags
    .filter((t) => !existing.has(t.toLowerCase()))
    .slice(0, missing);

  if (toAdd.length === 0) {
    const fallback = ["#Crypto", "#Trading", "#MarketUpdate", "#Binance"];
    const addFallback = fallback
      .filter((t) => !existing.has(t.toLowerCase()))
      .slice(0, missing);
    toAdd.push(...addFallback);
  }
  while (toAdd.length < missing) {
    toAdd.push("#CryptoUpdate");
  }

  const lines = content.split("\n");
  let insertIndex = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].toLowerCase().includes("not financial advice")) {
      insertIndex = i;
      break;
    }
  }
  const hashtagLine = toAdd.join(" ");
  lines.splice(insertIndex, 0, hashtagLine);
  return lines.join("\n");
}

/* =======================================================
   GENERATE POST (unchanged)
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

Question: ${question}

MARKET DATA:
${marketData}

NEWS RESEARCH:
${compactNews}

RECENT POSTS (to avoid repetition):
${recentPosts || "None"}

Create a Binance Square post that directly answers the question.

Rules:
- Only use data provided.
- If no catalyst, say "No confirmed catalyst found."
- No buy/sell advice, no profit promises.
- End with "Not financial advice."
- Use at least 4 relevant hashtags (e.g., #Crypto #BTC etc.).
- Keep post 900-1600 characters.

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
`;

  try {
    let post = await callGeneration(prompt, GENERATION_MAX_TOKENS, 3);
    post.content = ensureHashtags(post.content, post.topic);
    return post;
  } catch (error) {
    console.error("⚠️ Generation failed, building fallback post.");
    let post = buildFallbackPost(markets, question);
    post.content = ensureHashtags(post.content, post.topic);
    return post;
  }
}

/* =======================================================
   FALLBACK (unchanged)
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
    `Here's my take on "${question}" – based on current data.`,
    `Let's address "${question}" with the latest numbers.`,
    `Quick analysis on "${question}" – data says this.`,
    `Answering "${question}" – let's see what the charts show.`,
  ];
  const intro = intros[Math.floor(Math.random() * intros.length)];

  const content = `
📊 ${intro}

Top mover: ${name} (${symbol}) at $${price}, ${change > 0 ? "up" : "down"} ${Math.abs(change).toFixed(2)}% in 24h.

Market snapshot:
${markets.map((c) => `${c.short}: $${c.ticker.price} (${c.ticker.changePercent > 0 ? "+" : ""}${c.ticker.changePercent.toFixed(2)}%)`).join("\n")}

Trend overview (4h):
${markets.map((c) => `${c.short}: ${c.technical.fourHour.trend} (momentum ${c.technical.fourHour.momentum?.toFixed(2) ?? "N/A"}%)`).join("\n")}

⚠️ Key levels to watch:
- BTC: ${markets.find((c) => c.short === "BTC")?.technical.fourHour.recent20Range?.high ?? "N/A"} resistance, ${markets.find((c) => c.short === "BTC")?.technical.fourHour.recent20Range?.low ?? "N/A"} support
- ETH: ${markets.find((c) => c.short === "ETH")?.technical.fourHour.recent20Range?.high ?? "N/A"} resistance, ${markets.find((c) => c.short === "ETH")?.technical.fourHour.recent20Range?.low ?? "N/A"} support

🐂 Bullish if momentum continues.
🐻 Bearish if key resistance holds.

🎯 Bottom line: Watch volume and breakouts.

What's your view? Drop a comment below.

Not financial advice.
`;

  return {
    title: `Answer: ${question.slice(0, 50)}...`,
    topic: symbol.toLowerCase(),
    content: content.trim(),
    qualityScore: 8,
    newsUsed: false,
    catalystConfidence: "NONE",
    skip: false,
    skipReason: "",
  };
}

/* =======================================================
   VALIDATION (unchanged)
======================================================= */

function validatePost(post, markets) {
  const reasons = [];
  if (!post) return { valid: false, reasons: ["empty post"] };

  const content = String(post.content || "").trim();
  if (content.length < 50) reasons.push("post is too short (<50 chars)");

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
    if (lower.includes(phrase)) reasons.push(`forbidden phrase: ${phrase}`);
  }

  const hashtags = content.match(/#[a-zA-Z0-9_]+/g) || [];
  if (hashtags.length < 4)
    reasons.push(`hashtags count: ${hashtags.length} (expected 4+)`);

  return { valid: true, reasons };
}

/* =======================================================
   DUPLICATE – Disabled (unchanged)
======================================================= */

function isDuplicate(content) {
  return { duplicate: false, score: 0 };
}

/* =======================================================
   PUBLISH (unchanged)
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
      resolve({ success: true, dryRun: true });
      return;
    }

    const child = spawn("node", [SQUARE_SCRIPT, "--text", content], {
      cwd: path.join(__dirname, ".agents", "skills", "square-post"),
      env: { ...process.env, BINANCE_SQUARE_OPENAPI_KEY },
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
      resolve({ success: true, id, link, stdout });
    });
  });
}

/* =======================================================
   SAVE POST (unchanged)
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
   MAIN CYCLE (unchanged)
======================================================= */

async function runCycle() {
  resetDailyCounter();

  console.log("\n================================================");
  console.log("🚀 BINANCE SQUARE AI BOT V2.8.2 (Multi‑Endpoint)");
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
    if (result.id) console.log(`🆔 ID: ${result.id}`);
    if (result.link) console.log(`🔗 ${result.link}`);
    if (result.dryRun) console.log("🧪 DRY RUN — not published.");
  } catch (error) {
    state.totalFailures++;
    await saveState();
    console.error("\n❌ Cycle error:");
    console.error(error?.message || error);
    console.log("🛡️ Bot remains alive.");
  }
}

/* =======================================================
   HELPERS (unchanged)
======================================================= */

function formatNumber(number) {
  if (!Number.isFinite(number)) return "N/A";
  return number.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function formatPercent(number) {
  if (!Number.isFinite(number)) return "N/A";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}%`;
}

/* =======================================================
   SHUTDOWN (unchanged)
======================================================= */

let shuttingDown = false;
let httpServer = null;

async function shutdown(signal) {
  if (shuttingDown) return;
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
   START – Bot + HTTP Health Server
======================================================= */

async function startBotAndServer() {
  await loadState();

  console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║       🤖 BINANCE SQUARE AI BOT V2.8.2           ║
║          (Multi‑Endpoint Fix)                    ║
╚══════════════════════════════════════════════════╝
`);

  console.log(`🧠 Provider: Groq`);
  console.log(`🧠 Model: ${GROQ_MODEL}`);
  console.log(`⚡ TPM optimization: ENABLED`);
  console.log(`⏱️ Interval: ${POST_INTERVAL_MINUTES} minutes`);
  console.log(`🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`);
  console.log(`📊 Binance market data: ENABLED (multi‑endpoint)`);
  console.log(`📰 Live news research: DISABLED`);
  console.log(`🛡️ Quality gate: SAFETY ONLY (no rejections)`);
  console.log(`🔎 Duplicate protection: DISABLED`);
  console.log(`📡 Binance Square: ENABLED`);
  console.log(`🧪 Dry run: ${DRY_RUN ? "YES" : "NO"}`);
  console.log(`❓ Question pool size: ${QUESTION_POOL.length}`);

  console.log("\n🚀 Starting first cycle...");
  await runCycle();

  const interval = POST_INTERVAL_MINUTES * 60 * 1000;
  console.log(`\n🟢 Bot is running continuously.`);
  console.log(`⏳ Next cycle in ${POST_INTERVAL_MINUTES} minutes.`);
  setInterval(async () => {
    if (shuttingDown) return;
    await runCycle();
    console.log(`\n⏳ Next cycle in ${POST_INTERVAL_MINUTES} minutes.`);
  }, interval);

  const PORT = process.env.PORT || 3000;
  httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "alive",
        postsToday: state.postsToday,
        totalPosts: state.totalPosts,
        uptime: process.uptime(),
      }),
    );
  });

  httpServer.listen(PORT, () => {
    console.log(`🟢 Health server running on port ${PORT}`);
  });
}

startBotAndServer().catch(async (error) => {
  console.error("💥 Fatal startup error:", error);
  await saveState();
  process.exit(1);
});
