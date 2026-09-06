// ============================================================
// BINANCE SQUARE AI BOT SERVER
// V11
//
// ONE PROCESS
// ONE PORT
// ONE BOT
//
// Routes:
// GET  /
// GET  /health
// POST /post
//
// FIXES:
// - Removed invalid POST_TRIGGER_SECRET import
// - Server reads POST_TRIGGER_SECRET directly from env
// - Proper authentication
// - Prevents overlapping bot cycles
// - Safe request-body handling
// - Proper Render PORT handling
// - Graceful shutdown
// ============================================================

import dotenv from "dotenv";
dotenv.config();

import http from "http";

import {
  runBinanceBot,
  getBinanceStatus,
  shutdownBinanceBot,
} from "./binance-bot.js";

// ============================================================
// ENVIRONMENT
// ============================================================

const POST_TRIGGER_SECRET = process.env.POST_TRIGGER_SECRET;

if (!POST_TRIGGER_SECRET) {
  throw new Error("Missing required environment variable: POST_TRIGGER_SECRET");
}

// ============================================================
// PORT
// ============================================================

function parsePositiveInteger(value, fallback) {
  const number = Number(value);

  if (Number.isInteger(number) && number > 0) {
    return number;
  }

  return fallback;
}

const PORT = parsePositiveInteger(process.env.PORT, 3000);

// ============================================================
// AUTH
// ============================================================

function isAuthorized(req) {
  const authorization = req.headers.authorization;

  if (typeof authorization !== "string") {
    return false;
  }

  return authorization === `Bearer ${POST_TRIGGER_SECRET}`;
}

// ============================================================
// REQUEST BODY
// ============================================================

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let finished = false;

    function rejectOnce(error) {
      if (finished) return;

      finished = true;
      reject(error);
    }

    function resolveOnce() {
      if (finished) return;

      finished = true;
      resolve(body);
    }

    req.on("data", (chunk) => {
      body += chunk.toString();

      // Prevent unnecessarily large requests
      if (body.length > 10000) {
        rejectOnce(new Error("Request body too large."));

        req.destroy();
      }
    });

    req.on("end", resolveOnce);

    req.on("error", rejectOnce);
  });
}

// ============================================================
// JSON RESPONSE
// ============================================================

function sendJSON(res, statusCode, data) {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",

    "Cache-Control": "no-store",

    "X-Content-Type-Options": "nosniff",
  });

  res.end(JSON.stringify(data, null, 2));
}

// ============================================================
// SERVER STATE
// ============================================================

let httpServer = null;

let cycleInFlight = false;

// ============================================================
// START SERVER
// ============================================================

async function startServer() {
  httpServer = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `localhost:${PORT}`;

      const url = new URL(req.url, `http://${host}`);

      // ==================================================
      // CORS
      // ==================================================

      res.setHeader("Access-Control-Allow-Origin", "*");

      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization",
      );

      // ==================================================
      // OPTIONS
      // ==================================================

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // ==================================================
      // GET /
      // GET /health
      // ==================================================

      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/health")
      ) {
        return sendJSON(res, 200, {
          success: true,

          status: "alive",

          service: "Binance Square AI Bot",

          version: "11",

          uptime: process.uptime(),

          binance: getBinanceStatus(),
        });
      }

      // ==================================================
      // POST /post
      // ==================================================

      if (req.method === "POST" && url.pathname === "/post") {
        console.log("\n📥 POST /post trigger received.");

        // ----------------------------------------------
        // AUTH
        // ----------------------------------------------

        if (!isAuthorized(req)) {
          console.log("❌ Unauthorized trigger.");

          return sendJSON(res, 401, {
            success: false,
            error: "Unauthorized.",
          });
        }

        console.log("🔐 Trigger authenticated.");

        // ----------------------------------------------
        // PREVENT DOUBLE EXECUTION
        // ----------------------------------------------

        if (cycleInFlight) {
          console.log("⚠️ Bot cycle already running.");

          return sendJSON(res, 409, {
            success: false,

            error: "A Binance post cycle is already running.",
          });
        }

        // ----------------------------------------------
        // READ REQUEST BODY
        // ----------------------------------------------

        try {
          await readRequestBody(req);
        } catch (error) {
          console.error("❌ Request body error:", error.message);

          return sendJSON(res, 400, {
            success: false,

            error: error.message,
          });
        }

        // ----------------------------------------------
        // RUN BOT
        // ----------------------------------------------

        cycleInFlight = true;

        console.log("🚀 Starting Binance bot cycle...");

        try {
          const result = await runBinanceBot();

          const statusCode = result?.success || result?.skipped ? 200 : 500;

          return sendJSON(res, statusCode, result);
        } catch (error) {
          console.error("❌ Binance bot cycle failed:", error?.stack || error);

          return sendJSON(res, 500, {
            success: false,

            error: error?.message || "Binance bot cycle failed.",
          });
        } finally {
          cycleInFlight = false;

          console.log("🏁 Binance bot cycle finished.");
        }
      }

      // ==================================================
      // 404
      // ==================================================

      return sendJSON(res, 404, {
        success: false,

        error: "Route not found.",

        availableRoutes: ["GET /", "GET /health", "POST /post"],
      });
    } catch (error) {
      console.error("❌ HTTP error:", error?.stack || error);

      if (!res.headersSent) {
        return sendJSON(res, 500, {
          success: false,

          error: "Internal server error.",
        });
      }

      res.end();
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);

    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`🟢 Binance server running on port ${PORT}`);

      resolve();
    });
  });
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(`\n🛑 ${signal} received.`);

  try {
    await shutdownBinanceBot();
  } catch (error) {
    console.error("⚠️ Binance shutdown error:", error?.message || error);
  }

  if (!httpServer) {
    process.exit(0);
    return;
  }

  httpServer.close(() => {
    console.log("👋 HTTP server closed.");

    process.exit(0);
  });

  // Don't wait forever for open connections
  setTimeout(() => {
    console.log("⚠️ Forced shutdown.");

    process.exit(0);
  }, 10000).unref();
}

// ============================================================
// PROCESS SIGNALS
// ============================================================

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============================================================
// START
// ============================================================

async function start() {
  console.log(`
╔══════════════════════════════════════════════╗
║        BINANCE SQUARE AI BOT V11             ║
║                                              ║
║        24H MOMENTUM + NEWS ANALYSIS          ║
╚══════════════════════════════════════════════╝
`);

  console.log(`🌎 Node.js: ${process.version}`);

  console.log(`🔐 Trigger authentication: ENABLED`);

  await startServer();

  console.log("\n🟢 Waiting for Binance triggers.");

  console.log("📡 POST /post     -> Binance Square");

  console.log("💚 GET  /health   -> Bot status");
}

// ============================================================
// BOOT
// ============================================================

start().catch(async (error) => {
  console.error("💥 Fatal startup error:", error?.stack || error);

  try {
    await shutdownBinanceBot();
  } catch {}

  process.exit(1);
});
