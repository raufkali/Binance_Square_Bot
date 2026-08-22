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
BINANCE SQUARE AI BOT V5.0.0
=========================================================

NEW ARCHITECTURE
----------------

The bot NO LONGER uses setInterval().

Instead:

External Scheduler
        ↓
POST /post
        ↓
Render wakes the service
        ↓
Google News RSS
        ↓
Groq AI
        ↓
Safety validation
        ↓
Binance Square
        ↓
Save state
        ↓
Return response

Render can sleep while there are no requests.

The external scheduler should trigger:

01:00
01:40
02:20
03:00
03:40
...

The Node process does NOT wait for the next post.

FEATURES
--------
- Fresh crypto topic research using Google News RSS
- No Binance market-data API required
- No CoinGecko dependency
- No Coinbase dependency
- No technical-analysis dependency
- Groq generates the actual post
- Random topic fallback
- 4+ hashtags
- 36 posts/day
- Fixed external scheduling
- Persistent state
- Duplicate protection disabled
- Safety-only validation
- Dry-run support
- Render-compatible HTTP server
- Secure POST trigger
- No setInterval
- No 40-minute internal timer
=========================================================
*/

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =======================================================
   CONFIG
======================================================= */

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const GROQ_MODEL =
  process.env.GROQ_MODEL || "openai/gpt-oss-20b";

const BINANCE_SQUARE_OPENAPI_KEY =
  process.env.BINANCE_SQUARE_OPENAPI_KEY;

/*
Secret used by the external scheduler.

Example:

POST_TRIGGER_SECRET=my-super-secret-value
*/

const POST_TRIGGER_SECRET =
  process.env.POST_TRIGGER_SECRET;

const MAX_POSTS_PER_DAY =
  Number(process.env.MAX_POSTS_PER_DAY || 36);

const MAX_HISTORY =
  Number(process.env.MAX_HISTORY || 200);

const REQUEST_TIMEOUT_MS =
  Number(process.env.REQUEST_TIMEOUT_MS || 30000);

const DRY_RUN =
  String(process.env.DRY_RUN || "true").toLowerCase() === "true";

const PORT =
  Number(process.env.PORT || 3000);

const STATE_FILE =
  path.join(__dirname, "bot-state.json");

const SQUARE_SCRIPT =
  path.join(
    __dirname,
    ".agents",
    "skills",
    "square-post",
    "scripts",
    "post-text.mjs",
  );

const GENERATION_MAX_TOKENS = 1300;

/*
Google News RSS.
No API key required.
*/

const GOOGLE_NEWS_URL =
  "https://news.google.com/rss/search?q=crypto%20OR%20bitcoin%20OR%20ethereum%20OR%20binance%20OR%20solana&hl=en-US&gl=US&ceid=US:en";

/* =======================================================
   VALIDATION
======================================================= */

if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY is missing.");
  process.exit(1);
}

if (!BINANCE_SQUARE_OPENAPI_KEY) {
  console.error(
    "❌ BINANCE_SQUARE_OPENAPI_KEY is missing.",
  );
  process.exit(1);
}

if (!POST_TRIGGER_SECRET) {
  console.error(
    "❌ POST_TRIGGER_SECRET is missing.",
  );

  console.error(
    "   Add POST_TRIGGER_SECRET to your environment variables.",
  );

  process.exit(1);
}

const groq = new Groq({
  apiKey: GROQ_API_KEY,
});

/* =======================================================
   TOPIC POOL
======================================================= */

const TOPICS = [
  "Bitcoin",
  "Ethereum",
  "BNB",
  "Solana",
  "XRP",
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

  lastTriggerAt: null,

  lastTriggerResult: null,

  history: [],
};

/* =======================================================
   LOAD STATE
======================================================= */

async function loadState() {
  try {
    const raw = await fs.readFile(
      STATE_FILE,
      "utf8",
    );

    const parsed = JSON.parse(raw);

    state = {
      ...state,
      ...parsed,
    };

    if (!Array.isArray(state.history)) {
      state.history = [];
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

  } catch (error) {
    console.log(
      "ℹ️ No valid state file found. Creating fresh state.",
    );

    await saveState();
  }

  resetDailyCounter();
}

/* =======================================================
   SAVE STATE
======================================================= */

async function saveState() {
  try {
    const tempFile = `${STATE_FILE}.tmp`;

    await fs.writeFile(
      tempFile,
      JSON.stringify(state, null, 2),
      "utf8",
    );

    await fs.rename(
      tempFile,
      STATE_FILE,
    );

  } catch (error) {
    console.error(
      "⚠️ Failed to save state:",
      error.message,
    );
  }
}

/* =======================================================
   DAILY RESET
======================================================= */

function resetDailyCounter() {
  const today =
    new Date().toISOString().slice(0, 10);

  if (state.date !== today) {
    console.log(
      "📅 New day detected. Resetting daily counter.",
    );

    state.date = today;

    state.postsToday = 0;

    saveState().catch(() => {});
  }
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

  const timer = setTimeout(
    () => controller.abort(),
    timeout,
  );

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
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* =======================================================
   GOOGLE NEWS RESEARCH
======================================================= */

async function researchWeb() {
  console.log(
    "\n🌐 Searching the web for fresh crypto topics...",
  );

  try {
    const response =
      await fetchWithTimeout(
        GOOGLE_NEWS_URL,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 CryptoResearchBot/5.0",

            Accept:
              "application/rss+xml, application/xml, text/xml",
          },
        },
        REQUEST_TIMEOUT_MS,
      );

    if (!response.ok) {
      throw new Error(
        `Google News returned HTTP ${response.status}`,
      );
    }

    const xml =
      await response.text();

    const items = [
      ...xml.matchAll(
        /<item>([\s\S]*?)<\/item>/gi,
      ),
    ];

    if (!items.length) {
      throw new Error(
        "No news items found in RSS response",
      );
    }

    const news = [];

    for (
      const itemMatch of items.slice(0, 15)
    ) {
      const item = itemMatch[1];

      const titleMatch =
        item.match(
          /<title>([\s\S]*?)<\/title>/i,
        );

      const descriptionMatch =
        item.match(
          /<description>([\s\S]*?)<\/description>/i,
        );

      const pubDateMatch =
        item.match(
          /<pubDate>([\s\S]*?)<\/pubDate>/i,
        );

      if (!titleMatch) {
        continue;
      }

      const title =
        decodeXml(
          stripHtml(titleMatch[1]),
        );

      const description =
        descriptionMatch
          ? decodeXml(
              stripHtml(
                descriptionMatch[1],
              ),
            )
          : "";

      const pubDate =
        pubDateMatch
          ? decodeXml(
              pubDateMatch[1],
            ).trim()
          : "";

      if (!title) {
        continue;
      }

      news.push({
        title,

        description:
          description.slice(0, 500),

        publishedAt: pubDate,
      });
    }

    if (!news.length) {
      throw new Error(
        "RSS contained no usable articles",
      );
    }

    console.log(
      `   ✅ Found ${news.length} fresh crypto topics.`,
    );

    return news;

  } catch (error) {
    console.warn(
      `   ⚠️ Web research unavailable: ${error.message}`,
    );

    console.log(
      "   ↪️ Using internal crypto topic pool.",
    );

    return [];
  }
}

/* =======================================================
   RANDOM TOPIC
======================================================= */

function getRandomTopic() {
  return TOPICS[
    Math.floor(
      Math.random() * TOPICS.length,
    )
  ];
}

/* =======================================================
   RECENT POST MEMORY
======================================================= */

function getRecentPostMemory() {
  return state.history
    .slice(-12)
    .map(
      (post) =>
        `${post.topic}: ${String(
          post.text || "",
        )
          .replace(/\s+/g, " ")
          .slice(0, 180)`,
    )
    .join("\n");
}

/* =======================================================
   LENIENT JSON PARSING
======================================================= */

function extractJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {}

  const match =
    String(raw || "").match(
      /\{[\s\S]*\}/,
    );

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

async function callGeneration(
  prompt,
  maxTokens,
  retries = 3,
) {
  const system = `
You are an engaging crypto content creator writing for Binance Square.

Your job is to create interesting, natural and readable cryptocurrency posts.

You can discuss:
- Bitcoin
- Ethereum
- BNB
- Solana
- XRP
- altcoins
- crypto adoption
- trading psychology
- market concepts
- blockchain
- DeFi
- Web3
- crypto trends
- general crypto discussions

IMPORTANT:

You do NOT have guaranteed real-time market data.

Therefore:

- Do not invent exact current prices.
- Do not invent exact percentage movements.
- Do not claim a specific breaking event happened unless it appears in the supplied research.
- Do not pretend you personally verified market data.
- When discussing a news topic, clearly frame it as a topic being discussed/reported.
- Focus on useful discussion, opinions, explanations and observations.
- Do not provide financial advice.
- Do not promise profits.
- Do not use "buy now" or "sell now".
- Do not use guaranteed-profit language.

The post should feel like a real Binance Square creator wrote it.

Output ONLY valid JSON.
`;

  for (
    let attempt = 1;
    attempt <= retries;
    attempt++
  ) {
    try {
      const response =
        await groq.chat.completions.create({
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

          temperature: 0.9,

          max_completion_tokens:
            maxTokens,

          response_format: {
            type: "json_object",
          },
        });

      const raw =
        response.choices?.[0]
          ?.message?.content;

      if (!raw) {
        throw new Error(
          "Groq returned an empty response",
        );
      }

      const parsed =
        extractJSON(raw);

      if (!parsed) {
        throw new Error(
          "Groq returned invalid JSON",
        );
      }

      return {
        title:
          parsed.title ||
          "Crypto Market Update",

        topic:
          parsed.topic ||
          "crypto",

        content:
          parsed.content ||
          "Crypto market discussion.",

        qualityScore:
          typeof parsed.qualityScore ===
          "number"
            ? parsed.qualityScore
            : 8,

        newsUsed:
          Boolean(parsed.newsUsed),

        catalystConfidence:
          parsed.catalystConfidence ||
          "NONE",

        skip:
          Boolean(parsed.skip),

        skipReason:
          parsed.skipReason || "",
      };

    } catch (error) {
      console.warn(
        `   ⚠️ Groq attempt ${attempt} failed: ${error.message}`,
      );

      if (attempt === retries) {
        throw error;
      }

      await new Promise(
        (resolve) =>
          setTimeout(resolve, 1500),
      );
    }
  }
}

/* =======================================================
   HASHTAGS
======================================================= */

function ensureHashtags(
  content,
  topic = "crypto",
) {
  const hashtags =
    content.match(
      /#[a-zA-Z0-9_]+/g,
    ) || [];

  const required = 4;

  const missing =
    required - hashtags.length;

  if (missing <= 0) {
    return content;
  }

  const defaultTags = {
    bitcoin: [
      "#Bitcoin",
      "#BTC",
      "#Crypto",
      "#Binance",
    ],

    btc: [
      "#Bitcoin",
      "#BTC",
      "#Crypto",
      "#Trading",
    ],

    ethereum: [
      "#Ethereum",
      "#ETH",
      "#Crypto",
      "#Binance",
    ],

    eth: [
      "#Ethereum",
      "#ETH",
      "#Crypto",
      "#Altcoins",
    ],

    bnb: [
      "#BNB",
      "#Binance",
      "#Crypto",
      "#BSC",
    ],

    solana: [
      "#Solana",
      "#SOL",
      "#Crypto",
      "#Blockchain",
    ],

    sol: [
      "#Solana",
      "#SOL",
      "#Crypto",
      "#Blockchain",
    ],

    xrp: [
      "#XRP",
      "#Ripple",
      "#Crypto",
      "#Payments",
    ],

    market: [
      "#Crypto",
      "#Market",
      "#Trading",
      "#Binance",
    ],

    crypto: [
      "#Crypto",
      "#Binance",
      "#Trading",
      "#Blockchain",
    ],
  };

  const normalizedTopic =
    String(topic || "crypto")
      .toLowerCase()
      .trim();

  const tags =
    defaultTags[normalizedTopic] ||
    defaultTags.crypto;

  const existing =
    new Set(
      hashtags.map(
        (tag) =>
          tag.toLowerCase(),
      ),
    );

  const toAdd = tags
    .filter(
      (tag) =>
        !existing.has(
          tag.toLowerCase(),
        ),
    )
    .slice(0, missing);

  const fallback = [
    "#Crypto",
    "#Binance",
    "#MarketUpdate",
    "#Trading",
    "#Blockchain",
  ];

  for (const tag of fallback) {
    if (toAdd.length >= missing) {
      break;
    }

    if (
      !existing.has(
        tag.toLowerCase(),
      ) &&
      !toAdd.some(
        (x) =>
          x.toLowerCase() ===
          tag.toLowerCase(),
      )
    ) {
      toAdd.push(tag);
    }
  }

  const lines =
    String(content).split("\n");

  let insertIndex =
    lines.length;

  for (
    let i = lines.length - 1;
    i >= 0;
    i--
  ) {
    if (
      lines[i]
        .toLowerCase()
        .includes(
          "not financial advice",
        )
    ) {
      insertIndex = i;
      break;
    }
  }

  lines.splice(
    insertIndex,
    0,
    toAdd.join(" "),
  );

  return lines.join("\n");
}

/* =======================================================
   GENERATE POST
======================================================= */

async function generatePost(
  newsResearch,
) {
  const recentPosts =
    getRecentPostMemory();

  let selectedNews = null;

  if (
    Array.isArray(newsResearch) &&
    newsResearch.length > 0
  ) {
    selectedNews =
      newsResearch[
        Math.floor(
          Math.random() *
            newsResearch.length,
        )
      ];
  }

  const fallbackTopic =
    getRandomTopic();

  console.log("\n🎯 Selected topic:");

  if (selectedNews) {
    console.log(
      `   📰 ${selectedNews.title}`,
    );
  } else {
    console.log(
      `   💡 ${fallbackTopic}`,
    );
  }

  let researchBlock = "NONE";

  if (selectedNews) {
    researchBlock = `
Headline:
${selectedNews.title}

Description:
${selectedNews.description}

Published:
${selectedNews.publishedAt}
`;
  }

  const prompt = `
Create a Binance Square cryptocurrency post.

CURRENT WEB RESEARCH:
${researchBlock}

FALLBACK TOPIC:
${fallbackTopic}

RECENT POSTS:
${recentPosts || "None"}

Instructions:

1. If current web research is available, use it as inspiration.
2. If web research is unavailable, use the fallback topic.
3. Do not invent facts.
4. Do not invent prices.
5. Do not invent percentages.
6. Do not invent breaking news.
7. Do not make financial promises.
8. Do not tell readers to buy or sell.
9. Make the post engaging and conversational.
10. Encourage discussion.
11. Use emojis naturally.
12. Use at least 4 relevant hashtags.
13. End with exactly:

Not financial advice.

14. Keep the post approximately 700-1400 characters.
15. Avoid sounding like a formal news article.
16. Make it feel like a human Binance Square creator wrote it.

Return:

{
  "title": "short engaging title",
  "topic": "bitcoin|ethereum|bnb|solana|xrp|market|crypto",
  "content": "full post",
  "qualityScore": 8,
  "newsUsed": true,
  "catalystConfidence": "LOW|MEDIUM|HIGH|NONE",
  "skip": false,
  "skipReason": ""
}
`;

  try {
    const post =
      await callGeneration(
        prompt,
        GENERATION_MAX_TOKENS,
        3,
      );

    post.content =
      ensureHashtags(
        post.content,
        post.topic,
      );

    return post;

  } catch (error) {
    console.error(
      "⚠️ Generation failed.",
    );

    console.error(error.message);

    return buildFallbackPost(
      selectedNews,
      fallbackTopic,
    );
  }
}

/* =======================================================
   FALLBACK POST
======================================================= */

function buildFallbackPost(
  selectedNews,
  fallbackTopic,
) {
  const topic =
    selectedNews?.title ||
    fallbackTopic;

  const templates = [
    `🚀 Crypto is always moving, but the interesting part isn't just the price.

Today's conversation is around ${topic}.

Crypto markets are influenced by sentiment, liquidity, adoption, technology and investor psychology. Sometimes the biggest opportunities for learning come from simply understanding why traders are paying attention to a particular topic.

What do you think matters most here?

Share your view 👇

Not financial advice.`,

    `👀 Here's a crypto topic worth watching:

${topic}

The crypto market is full of narratives, and narratives can change quickly. Bitcoin, Ethereum and the wider altcoin market all have different drivers, but sentiment remains one of the biggest forces behind market behavior.

Do you think this topic will become more important for crypto?

Let me know your thoughts 👇

Not financial advice.`,

    `🔥 Crypto discussion of the day:

${topic}

One thing I find interesting about crypto is how quickly market attention can move from one narrative to another.

Technology, adoption, regulation, liquidity and trader sentiment can all influence what the market focuses on next.

Which crypto narrative are you watching?

Drop your opinion below 👇

Not financial advice.`,
  ];

  const content =
    templates[
      Math.floor(
        Math.random() *
          templates.length,
      )
    ];

  return {
    title:
      `Crypto Talk: ${String(
        topic,
      ).slice(0, 55)}`,

    topic: "crypto",

    content:
      ensureHashtags(
        content,
        "crypto",
      ),

    qualityScore: 7,

    newsUsed:
      Boolean(selectedNews),

    catalystConfidence:
      selectedNews
        ? "LOW"
        : "NONE",

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

  const content =
    String(
      post.content || "",
    ).trim();

  if (content.length < 50) {
    reasons.push(
      "post is too short",
    );
  }

  const lower =
    content.toLowerCase();

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
    if (
      lower.includes(phrase)
    ) {
      reasons.push(
        `forbidden phrase: ${phrase}`,
      );
    }
  }

  const hashtags =
    content.match(
      /#[a-zA-Z0-9_]+/g,
    ) || [];

  if (hashtags.length < 4) {
    reasons.push(
      `hashtags count: ${hashtags.length}`,
    );
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/* =======================================================
   DUPLICATE CHECK
======================================================= */

function isDuplicate() {
  return {
    duplicate: false,
    score: 0,
  };
}

/* =======================================================
   PUBLISH TO BINANCE SQUARE
======================================================= */

function publishToSquare(
  content,
) {
  return new Promise(
    (resolve, reject) => {
      console.log(
        "\n📡 Publishing to Binance Square...",
      );

      if (DRY_RUN) {
        console.log(
          "🧪 DRY_RUN=true",
        );

        console.log(
          "   No real publication will occur.",
        );

        console.log(
          "\n----- GENERATED POST -----\n",
        );

        console.log(content);

        console.log(
          "\n--------------------------\n",
        );

        resolve({
          success: true,
          dryRun: true,
        });

        return;
      }

      const child =
        spawn(
          "node",
          [
            SQUARE_SCRIPT,
            "--text",
            content,
          ],
          {
            cwd: path.join(
              __dirname,
              ".agents",
              "skills",
              "square-post",
            ),

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

      child.stdout.on(
        "data",
        (data) => {
          const text =
            data.toString();

          stdout += text;

          process.stdout.write(
            text,
          );
        },
      );

      child.stderr.on(
        "data",
        (data) => {
          const text =
            data.toString();

          stderr += text;

          process.stderr.write(
            text,
          );
        },
      );

      child.on(
        "error",
        reject,
      );

      child.on(
        "close",
        (code) => {
          if (code !== 0) {
            reject(
              new Error(
                `Square publisher exited with code ${code}\n${stderr}`,
              ),
            );

            return;
          }

          const id =
            stdout.match(
              /ID:\s*(.+)/i,
            )?.[1]?.trim() ||
            null;

          const link =
            stdout.match(
              /Link:\s*(.+)/i,
            )?.[1]?.trim() ||
            null;

          resolve({
            success: true,
            id,
            link,
            stdout,
          });
        },
      );
    },
  );
}

/* =======================================================
   SAVE POST
======================================================= */

async function savePost(
  post,
  result,
) {
  state.history.push({
    id:
      result.id || null,

    title:
      post.title || null,

    topic:
      post.topic || "crypto",

    text:
      post.content,

    qualityScore:
      post.qualityScore,

    newsUsed:
      Boolean(post.newsUsed),

    catalystConfidence:
      post.catalystConfidence,

    publishedAt:
      new Date().toISOString(),

    dryRun:
      Boolean(result.dryRun),
  });

  if (
    state.history.length >
    MAX_HISTORY
  ) {
    state.history =
      state.history.slice(
        -MAX_HISTORY,
      );
  }

  if (!result.dryRun) {
    state.postsToday++;

    state.totalPosts++;

    state.lastPostAt =
      new Date().toISOString();
  }

  await saveState();
}

/* =======================================================
   MAIN POST CYCLE
======================================================= */

async function runCycle() {
  resetDailyCounter();

  console.log(
    "\n================================================",
  );

  console.log(
    "🚀 BINANCE SQUARE AI BOT V5.0.0",
  );

  console.log(
    "================================================",
  );

  console.log(
    `🕐 ${new Date().toLocaleString()}`,
  );

  console.log(
    `📅 Posts: ${state.postsToday}/${MAX_POSTS_PER_DAY}`,
  );

  if (
    state.postsToday >=
    MAX_POSTS_PER_DAY
  ) {
    console.log(
      "\n🛑 Daily limit reached.",
    );

    return {
      success: false,
      skipped: true,
      reason: "daily_limit",
    };
  }

  try {
    /* ==============================================
       WEB RESEARCH
       ============================================== */

    const news =
      await researchWeb();

    console.log(
      `\n📰 Research items available: ${news.length}`,
    );

    /* ==============================================
       AI GENERATION
       ============================================== */

    const post =
      await generatePost(news);

    console.log(
      "\n📝 Topic:",
      post.topic,
    );

    console.log(
      "⭐ Quality:",
      `${post.qualityScore}/10`,
    );

    console.log(
      "📰 Web research used:",
      post.newsUsed,
    );

    console.log(
      "🎯 Catalyst confidence:",
      post.catalystConfidence,
    );

    if (post.skip) {
      console.log(
        "\n⏭️ AI skipped this cycle.",
      );

      console.log(
        "Reason:",
        post.skipReason,
      );

      state.totalSkipped++;

      await saveState();

      return {
        success: false,
        skipped: true,
        reason:
          post.skipReason ||
          "ai_skip",
      };
    }

    /* ==============================================
       SAFETY CHECK
       ============================================== */

    console.log(
      "\n🛡️ Running basic safety check...",
    );

    const validation =
      validatePost(post);

    if (
      validation.reasons.length > 0
    ) {
      console.log(
        "⚠️ Warnings (posting anyway):",
      );

      for (
        const reason of validation.reasons
      ) {
        console.log(
          `   • ${reason}`,
        );
      }
    } else {
      console.log(
        "   ✓ Safety checks passed.",
      );
    }

    /* ==============================================
       DUPLICATE CHECK
       ============================================== */

    console.log(
      "   ✓ Duplicate protection disabled.",
    );

    /* ==============================================
       PUBLISH
       ============================================== */

    const result =
      await publishToSquare(
        post.content,
      );

    await savePost(
      post,
      result,
    );

    console.log(
      "\n╔══════════════════════════════════════════╗",
    );

    console.log(
      "║        ✅ CYCLE COMPLETED               ║",
    );

    console.log(
      "╚══════════════════════════════════════════╝",
    );

    if (result.id) {
      console.log(
        `🆔 ID: ${result.id}`,
      );
    }

    if (result.link) {
      console.log(
        `🔗 ${result.link}`,
      );
    }

    if (result.dryRun) {
      console.log(
        "🧪 DRY RUN — not published.",
      );
    }

    return {
      success: true,
      id: result.id || null,
      link: result.link || null,
      dryRun:
        Boolean(result.dryRun),
    };

  } catch (error) {
    state.totalFailures++;

    await saveState();

    console.error(
      "\n❌ Cycle error:",
    );

    console.error(
      error?.message || error,
    );

    return {
      success: false,
      error:
        error?.message ||
        "Unknown cycle error",
    };
  }
}

/* =======================================================
   SAFE CYCLE WRAPPER
======================================================= */

let cycleRunning = false;

async function safeRunCycle() {
  if (cycleRunning) {
    console.log(
      "⚠️ Previous cycle is still running.",
    );

    return {
      success: false,
      error:
        "A post cycle is already running.",
    };
  }

  cycleRunning = true;

  try {
    return await runCycle();

  } catch (error) {
    console.error(
      "❌ Unexpected cycle error:",
      error.message,
    );

    return {
      success: false,
      error: error.message,
    };

  } finally {
    cycleRunning = false;
  }
}

/* =======================================================
   AUTHORIZATION
======================================================= */

function isAuthorized(req) {
  const authorization =
    req.headers.authorization;

  if (!authorization) {
    return false;
  }

  const expected =
    `Bearer ${POST_TRIGGER_SECRET}`;

  return authorization === expected;
}

/* =======================================================
   REQUEST BODY
======================================================= */

async function readRequestBody(
  req,
) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        (chunk) => {
          body += chunk.toString();

          /*
          Protect against unnecessarily
          large request bodies.
          */

          if (body.length > 10000) {
            reject(
              new Error(
                "Request body too large.",
              ),
            );

            req.destroy();
          }
        },
      );

      req.on(
        "end",
        () => {
          resolve(body);
        },
      );

      req.on(
        "error",
        reject,
      );
    },
  );
}

/* =======================================================
   JSON RESPONSE
======================================================= */

function sendJSON(
  res,
  statusCode,
  data,
) {
  res.writeHead(
    statusCode,
    {
      "Content-Type":
        "application/json; charset=utf-8",

      "Cache-Control":
        "no-store",
    },
  );

  res.end(
    JSON.stringify(
      data,
      null,
      2,
    ),
  );
}

/* =======================================================
   HTTP SERVER
======================================================= */

let httpServer = null;

async function startServer() {
  httpServer =
    http.createServer(
      async (req, res) => {
        try {
          /* ==========================================
             HEALTH / ROOT
             ========================================== */

          if (
            req.method === "GET" &&
            (req.url === "/" ||
              req.url === "/health")
          ) {
            resetDailyCounter();

            return sendJSON(
              res,
              200,
              {
                status: "alive",

                service:
                  "binance-square-ai-bot",

                version:
                  "5.0.0",

                postsToday:
                  state.postsToday,

                maxPostsPerDay:
                  MAX_POSTS_PER_DAY,

                totalPosts:
                  state.totalPosts,

                totalFailures:
                  state.totalFailures,

                totalSkipped:
                  state.totalSkipped,

                uptime:
                  process.uptime(),

                lastPostAt:
                  state.lastPostAt,

                lastTriggerAt:
                  state.lastTriggerAt,

                lastTriggerResult:
                  state.lastTriggerResult,

                cycleRunning,
              },
            );
          }

          /* ==========================================
             POST TRIGGER
             ========================================== */

          if (
            req.method === "POST" &&
            req.url === "/post"
          ) {
            console.log(
              "\n📥 POST trigger received.",
            );

            /* ------------------------------------------
               AUTH
               ------------------------------------------ */

            if (!isAuthorized(req)) {
              console.log(
                "❌ Unauthorized POST trigger.",
              );

              return sendJSON(
                res,
                401,
                {
                  success: false,
                  error:
                    "Unauthorized.",
                },
              );
            }

            /* ------------------------------------------
               CONCURRENT PROTECTION
               ------------------------------------------ */

            if (cycleRunning) {
              console.log(
                "⚠️ Post cycle already running.",
              );

              return sendJSON(
                res,
                409,
                {
                  success: false,
                  error:
                    "A post cycle is already running.",
                },
              );
            }

            /*
            Read body even though we don't
            currently require anything from it.
            This allows schedulers that send
            JSON bodies to work normally.
            */

            try {
              await readRequestBody(req);
            } catch (error) {
              console.warn(
                "⚠️ Request body warning:",
                error.message,
              );
            }

            state.lastTriggerAt =
              new Date().toISOString();

            await saveState();

            console.log(
              "🚀 Starting requested post cycle...",
            );

            const result =
              await safeRunCycle();

            state.lastTriggerResult =
              result;

            await saveState();

            if (result.success) {
              return sendJSON(
                res,
                200,
                {
                  success: true,

                  message:
                    "Post cycle completed.",

                  result,

                  postsToday:
                    state.postsToday,

                  totalPosts:
                    state.totalPosts,

                  lastPostAt:
                    state.lastPostAt,
                },
              );
            }

            if (result.skipped) {
              return sendJSON(
                res,
                200,
                {
                  success: false,

                  skipped: true,

                  reason:
                    result.reason,

                  postsToday:
                    state.postsToday,
                },
              );
            }

            return sendJSON(
              res,
              500,
              {
                success: false,

                message:
                  "Post cycle failed.",

                error:
                  result.error ||
                  "Unknown error",

                postsToday:
                  state.postsToday,

                totalFailures:
                  state.totalFailures,
              },
            );
          }

          /* ==========================================
             UNKNOWN ROUTE
             ========================================== */

          return sendJSON(
            res,
            404,
            {
              success: false,

              error:
                "Route not found.",

              availableRoutes: [
                "GET /",
                "GET /health",
                "POST /post",
              ],
            },
          );

        } catch (error) {
          console.error(
            "❌ HTTP request error:",
            error,
          );

          return sendJSON(
            res,
            500,
            {
              success: false,

              error:
                "Internal server error.",
            },
          );
        }
      },
    );

  await new Promise(
    (resolve, reject) => {
      httpServer.once(
        "error",
        reject,
      );

      httpServer.listen(
        PORT,
        "0.0.0.0",
        () => {
          console.log(
            `🟢 HTTP server running on port ${PORT}`,
          );

          console.log(
            "🚀 Production server is ready.",
          );

          resolve();
        },
      );
    },
  );
}

/* =======================================================
   SHUTDOWN
======================================================= */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `\n\n🛑 ${signal} received.`,
  );

  console.log(
    "💾 Saving state...",
  );

  await saveState();

  if (httpServer) {
    httpServer.close(
      () => {
        console.log(
          "👋 HTTP server closed.",
        );

        process.exit(0);
      },
    );

  } else {
    console.log(
      "👋 Bot stopped safely.",
    );

    process.exit(0);
  }
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT"),
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM"),
);

/* =======================================================
   START
======================================================= */

async function startBotAndServer() {
  await loadState();

  console.log(`
╔══════════════════════════════════════════════════╗
║                                                  ║
║       🤖 BINANCE SQUARE AI BOT V5.0.0           ║
║                                                  ║
║       ⚡ HTTP TRIGGER ARCHITECTURE               ║
║                                                  ║
╚══════════════════════════════════════════════════╝
`);

  console.log(
    `🧠 Provider: Groq`,
  );

  console.log(
    `🧠 Model: ${GROQ_MODEL}`,
  );

  console.log(
    `🌐 Web research: Google News RSS`,
  );

  console.log(
    `📊 Binance market API: DISABLED`,
  );

  console.log(
    `📈 Technical analysis: DISABLED`,
  );

  console.log(
    `📰 Live news research: ENABLED`,
  );

  console.log(
    `🛡️ Quality gate: SAFETY ONLY`,
  );

  console.log(
    `🔎 Duplicate protection: DISABLED`,
  );

  console.log(
    `📡 Binance Square: ENABLED`,
  );

  console.log(
    `🧪 Dry run: ${
      DRY_RUN ? "YES" : "NO"
    }`,
  );

  console.log(
    `🎯 Maximum: ${MAX_POSTS_PER_DAY}/day`,
  );

  console.log(
    `❓ Topic pool size: ${TOPICS.length}`,
  );

  console.log(
    `🔐 POST trigger authentication: ENABLED`,
  );

  console.log(
    `⏱️ Internal interval: DISABLED`,
  );

  console.log(
    `📡 External HTTP scheduling: ENABLED`,
  );

  /*
  IMPORTANT:

  There is NO first cycle here.

  The server starts and waits for:

  POST /post

  This prevents Render startup/health checks
  from accidentally creating a Binance post.
  */

  await startServer();

  console.log(
    "\n🟢 Bot is waiting for external triggers.",
  );

  console.log(
    "📡 POST /post → creates exactly ONE post.",
  );

  console.log(
    "💤 No internal timer is running.",
  );

  console.log(
    "⏰ External scheduler controls posting times.",
  );
}

/* =======================================================
   START APPLICATION
======================================================= */

startBotAndServer().catch(
  async (error) => {
    console.error(
      "💥 Fatal startup error:",
      error,
    );

    await saveState();

    process.exit(1);
  },
);