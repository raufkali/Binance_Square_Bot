// ============================================================
// BINANCE SQUARE AI BOT - COMBINED SERVER
//
// ONE HTTP SERVER
//
// Routes:
// GET  /
// GET  /health
// GET  /status
// POST /post
// POST /binance/post
//
// Authentication:
// Authorization: Bearer <POST_TRIGGER_SECRET>
//
// OR:
// X-Post-Secret: <POST_TRIGGER_SECRET>
//
// The Binance bot itself lives in:
// ./binance-bot.js
// ============================================================

import "dotenv/config";
import http from "http";

import {
  runBinanceBot,
  getBinanceStatus,
  shutdownBinanceBot,
} from "./binance-bot.js";

// ============================================================
// ENVIRONMENT
// ============================================================

const PORT = Number(process.env.PORT || 10000);

const HOST = process.env.HOST || "0.0.0.0";

const POST_TRIGGER_SECRET = process.env.POST_TRIGGER_SECRET || "";

const HEALTH_PATH = process.env.HEALTH_PATH || "/health";

const POST_PATH = process.env.POST_PATH || "/post";

const BINANCE_POST_PATH = process.env.BINANCE_POST_PATH || "/binance/post";

const STATUS_PATH = process.env.STATUS_PATH || "/status";

const REQUEST_TIMEOUT_MS = Number(
  process.env.HTTP_REQUEST_TIMEOUT_MS || 120000,
);

const MAX_BODY_BYTES = Number(process.env.MAX_HTTP_BODY_BYTES || 1_000_000);

const PUBLIC_HEALTH =
  String(process.env.PUBLIC_HEALTH || "true").toLowerCase() === "true";

const REQUIRE_SECRET_ON_HEALTH =
  String(process.env.REQUIRE_SECRET_ON_HEALTH || "false").toLowerCase() ===
  "true";

// ============================================================
// RUNTIME STATE
// ============================================================

let server = null;

let shuttingDown = false;

let cycleInFlight = false;

let cycleStartedAt = null;

let totalHttpRequests = 0;

// ============================================================
// UTILITY
// ============================================================

function sendJson(response, statusCode, payload) {
  if (response.headersSent) {
    return;
  }

  const body = JSON.stringify(payload, null, 2);

  response.statusCode = statusCode;

  response.setHeader("Content-Type", "application/json; charset=utf-8");

  response.setHeader("Content-Length", Buffer.byteLength(body));

  response.setHeader("Cache-Control", "no-store");

  response.end(body);
}

function sendText(response, statusCode, text) {
  if (response.headersSent) {
    return;
  }

  response.statusCode = statusCode;

  response.setHeader("Content-Type", "text/plain; charset=utf-8");

  response.end(text);
}

function applyCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

  response.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Post-Secret",
  );

  response.setHeader("Access-Control-Max-Age", "86400");
}

// ============================================================
// AUTHENTICATION
// ============================================================

function getProvidedSecret(request) {
  const xPostSecret = request.headers["x-post-secret"];

  if (typeof xPostSecret === "string") {
    return xPostSecret.trim();
  }

  const authorization = request.headers.authorization;

  if (
    typeof authorization === "string" &&
    authorization.toLowerCase().startsWith("bearer ")
  ) {
    return authorization.slice(7).trim();
  }

  return "";
}

function isAuthorized(request) {
  if (!POST_TRIGGER_SECRET) {
    console.error("❌ POST_TRIGGER_SECRET is missing.");

    return false;
  }

  const providedSecret = getProvidedSecret(request);

  if (!providedSecret) {
    return false;
  }

  return providedSecret === POST_TRIGGER_SECRET;
}

// ============================================================
// REQUEST BODY
// ============================================================

async function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    let receivedBytes = 0;

    let settled = false;

    const finish = (error, value) => {
      if (settled) {
        return;
      }

      settled = true;

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    request.setEncoding("utf8");

    request.on("data", (chunk) => {
      receivedBytes += Buffer.byteLength(chunk, "utf8");

      if (receivedBytes > MAX_BODY_BYTES) {
        finish(new Error("Request body too large."));

        request.destroy();

        return;
      }

      body += chunk;
    });

    request.on("end", () => {
      if (!body.trim()) {
        finish(null, null);

        return;
      }

      try {
        finish(null, JSON.parse(body));
      } catch {
        finish(new Error("Invalid JSON request body."));
      }
    });

    request.on("error", (error) => {
      finish(error);
    });
  });
}

// ============================================================
// HEALTH
// ============================================================

function getHealthPayload() {
  const botStatus = getBinanceStatus();

  return {
    ok: true,

    service: "binance-square-ai-bot",

    status: shuttingDown ? "shutting_down" : "running",

    timestamp: new Date().toISOString(),

    uptimeSeconds: Math.floor(process.uptime()),

    port: PORT,

    bot: botStatus,

    cycle: {
      inFlight: cycleInFlight,

      startedAt: cycleStartedAt,
    },

    http: {
      totalRequests: totalHttpRequests,
    },
  };
}

// ============================================================
// RUN BOT
// ============================================================

async function executeBinanceCycle() {
  if (cycleInFlight) {
    return {
      success: false,

      skipped: true,

      reason: "A Binance bot cycle is already running.",

      cycleStartedAt,
    };
  }

  cycleInFlight = true;

  cycleStartedAt = new Date().toISOString();

  console.log("\n🚀 HTTP trigger received.");

  console.log(`⏱️ Cycle started: ${cycleStartedAt}`);

  try {
    const result = await runBinanceBot();

    return result;
  } finally {
    cycleInFlight = false;

    console.log("🏁 Binance cycle finished.");

    cycleStartedAt = null;
  }
}

// ============================================================
// REQUEST HANDLER
// ============================================================

async function handleRequest(request, response) {
  totalHttpRequests += 1;

  applyCors(response);

  // ----------------------------------------------------------
  // OPTIONS
  // ----------------------------------------------------------

  if (request.method === "OPTIONS") {
    response.statusCode = 204;

    response.end();

    return;
  }

  // ----------------------------------------------------------
  // NORMALIZE URL
  // ----------------------------------------------------------

  const parsedUrl = new URL(
    request.url || "/",
    `http://${request.headers.host || "localhost"}`,
  );

  const pathname = parsedUrl.pathname;

  // ----------------------------------------------------------
  // ROOT
  // ----------------------------------------------------------

  if (request.method === "GET" && pathname === "/") {
    sendJson(response, 200, {
      ok: true,

      service: "Binance Square AI Bot",

      version: getBinanceStatus().version,

      status: shuttingDown ? "shutting_down" : "running",

      endpoints: {
        health: HEALTH_PATH,

        status: STATUS_PATH,

        post: POST_PATH,

        binancePost: BINANCE_POST_PATH,
      },

      timestamp: new Date().toISOString(),
    });

    return;
  }

  // ----------------------------------------------------------
  // HEALTH
  // ----------------------------------------------------------

  if (request.method === "GET" && pathname === HEALTH_PATH) {
    if (REQUIRE_SECRET_ON_HEALTH && !PUBLIC_HEALTH) {
      if (!isAuthorized(request)) {
        sendJson(response, 401, {
          ok: false,
          error: "Unauthorized.",
        });

        return;
      }
    }

    sendJson(response, 200, getHealthPayload());

    return;
  }

  // ----------------------------------------------------------
  // STATUS
  // ----------------------------------------------------------

  if (request.method === "GET" && pathname === STATUS_PATH) {
    if (!isAuthorized(request)) {
      sendJson(response, 401, {
        ok: false,
        error: "Unauthorized.",
      });

      return;
    }

    sendJson(response, 200, {
      ok: true,

      status: getBinanceStatus(),

      cycle: {
        inFlight: cycleInFlight,

        startedAt: cycleStartedAt,
      },

      timestamp: new Date().toISOString(),
    });

    return;
  }

  // ----------------------------------------------------------
  // POST ROUTES
  // ----------------------------------------------------------

  if (
    request.method === "POST" &&
    (pathname === POST_PATH || pathname === BINANCE_POST_PATH)
  ) {
    if (!isAuthorized(request)) {
      sendJson(response, 401, {
        ok: false,
        error: "Unauthorized.",
      });

      return;
    }

    if (shuttingDown) {
      sendJson(response, 503, {
        ok: false,
        error: "Server is shutting down.",
      });

      return;
    }

    if (cycleInFlight) {
      sendJson(response, 409, {
        ok: false,

        skipped: true,

        error: "A Binance bot cycle is already running.",

        cycleStartedAt,
      });

      return;
    }

    // Read body if supplied.
    try {
      await readRequestBody(request);
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: error.message,
      });

      return;
    }

    // Run asynchronously but keep this request alive.
    try {
      const result = await executeBinanceCycle();

      const statusCode = result?.success ? 200 : result?.skipped ? 409 : 500;

      sendJson(response, statusCode, {
        ok: Boolean(result?.success),

        result,

        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error("❌ HTTP-triggered cycle failed:", error);

      sendJson(response, 500, {
        ok: false,

        error: error?.message || "Binance bot cycle failed.",

        timestamp: new Date().toISOString(),
      });
    }

    return;
  }

  // ----------------------------------------------------------
  // NOT FOUND
  // ----------------------------------------------------------

  sendJson(response, 404, {
    ok: false,

    error: "Route not found.",

    path: pathname,

    method: request.method,
  });
}

// ============================================================
// SERVER
// ============================================================

server = http.createServer(
  {
    requestTimeout: REQUEST_TIMEOUT_MS,

    headersTimeout: Math.min(REQUEST_TIMEOUT_MS, 60000),

    keepAliveTimeout: 5000,
  },

  (request, response) => {
    handleRequest(request, response).catch((error) => {
      console.error("❌ Unhandled HTTP request error:", error);

      if (!response.headersSent) {
        sendJson(response, 500, {
          ok: false,

          error: "Internal server error.",
        });
      } else {
        response.end();
      }
    });
  },
);

// ============================================================
// SERVER ERRORS
// ============================================================

server.on("error", (error) => {
  console.error("❌ HTTP server error:", error);
});

// ============================================================
// START
// ============================================================

server.listen(PORT, HOST, () => {
  console.log("\n============================================================");

  console.log("🚀 BINANCE SQUARE AI BOT SERVER");

  console.log("============================================================");

  console.log(`🌐 Listening on http://${HOST}:${PORT}`);

  console.log(`❤️ Health: ${HEALTH_PATH}`);

  console.log(`📊 Status: ${STATUS_PATH}`);

  console.log(`📡 Post: ${POST_PATH}`);

  console.log(`📡 Binance Post: ${BINANCE_POST_PATH}`);

  console.log(`🔐 Secret configured: ${POST_TRIGGER_SECRET ? "YES" : "NO"}`);

  console.log("============================================================\n");
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`\n🛑 Received ${signal}. Shutting down...`);

  if (cycleInFlight) {
    console.log(
      "⏳ A Binance cycle is still running. Waiting for it to finish...",
    );
  }

  try {
    await shutdownBinanceBot();
  } catch (error) {
    console.error("⚠️ Bot shutdown error:", error);
  }

  if (!server) {
    process.exit(0);
  }

  server.close(() => {
    console.log("✅ HTTP server closed.");

    process.exit(0);
  });

  setTimeout(() => {
    console.warn("⚠️ Forced shutdown after timeout.");

    process.exit(1);
  }, 15000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

process.on("uncaughtException", (error) => {
  console.error("💥 Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled rejection:", reason);
});
