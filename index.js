import dotenv from "dotenv";
import http from "http";

import {
  runBinanceBot,
  getBinanceStatus,
  shutdownBinanceBot,
  POST_TRIGGER_SECRET,
} from "./binance-bot.js";

dotenv.config();

/*
=========================================================
BINANCE SQUARE BOT SERVER
=========================================================

ONE PROCESS
ONE PORT
ONE BOT

Routes:

GET  /
GET  /health

POST /post

=========================================================
*/

const PORT = parsePositiveInteger(process.env.PORT, 3000);

function parsePositiveInteger(value, fallback) {
  const number = Number(value);

  if (Number.isInteger(number) && number > 0) {
    return number;
  }

  return fallback;
}

/* =======================================================
   AUTH
======================================================= */

function isAuthorized(req) {
  const authorization = req.headers.authorization;

  if (typeof authorization !== "string" || !POST_TRIGGER_SECRET) {
    return false;
  }

  return authorization === `Bearer ${POST_TRIGGER_SECRET}`;
}

/* =======================================================
   REQUEST BODY
======================================================= */

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

      if (body.length > 10000) {
        rejectOnce(new Error("Request body too large."));

        req.destroy();
      }
    });

    req.on("end", resolveOnce);

    req.on("error", rejectOnce);
  });
}

/* =======================================================
   RESPONSES
======================================================= */

function sendJSON(res, statusCode, data) {
  if (res.headersSent) return;

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",

    "Cache-Control": "no-store",

    "X-Content-Type-Options": "nosniff",
  });

  res.end(JSON.stringify(data, null, 2));
}

/* =======================================================
   SERVER
======================================================= */

let httpServer = null;

let cycleInFlight = false;

async function startServer() {
  httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      /* =========================================
             HEALTH
          ========================================= */

      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/health")
      ) {
        return sendJSON(res, 200, {
          status: "alive",

          uptime: process.uptime(),

          binance: getBinanceStatus(),
        });
      }

      /* =========================================
             BINANCE POST
          ========================================= */

      if (req.method === "POST" && url.pathname === "/post") {
        console.log("\n📥 POST /post trigger received.");

        if (!isAuthorized(req)) {
          console.log("❌ Unauthorized trigger.");

          return sendJSON(res, 401, {
            success: false,

            error: "Unauthorized.",
          });
        }

        if (cycleInFlight) {
          return sendJSON(res, 409, {
            success: false,

            error: "A Binance post cycle is already running.",
          });
        }

        try {
          await readRequestBody(req);
        } catch (error) {
          return sendJSON(res, 400, {
            success: false,

            error: error.message,
          });
        }

        cycleInFlight = true;

        try {
          const result = await runBinanceBot();

          const statusCode = result.success || result.skipped ? 200 : 500;

          return sendJSON(res, statusCode, result);
        } finally {
          cycleInFlight = false;
        }
      }

      /* =========================================
             404
          ========================================= */

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

/* =======================================================
   SHUTDOWN
======================================================= */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`\n🛑 ${signal} received.`);

  await shutdownBinanceBot();

  if (httpServer) {
    httpServer.close(() => {
      console.log("👋 HTTP server closed.");

      process.exit(0);
    });

    setTimeout(() => process.exit(0), 10000).unref();
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));

process.on("SIGTERM", () => shutdown("SIGTERM"));

/* =======================================================
   START
======================================================= */

async function start() {
  console.log(`
╔══════════════════════════════════════════════╗
║        BINANCE SQUARE AI BOT V11             ║
║                                              ║
║        24H MOMENTUM + NEWS ANALYSIS          ║
╚══════════════════════════════════════════════╝
`);

  await startServer();

  console.log("\n🟢 Waiting for Binance triggers.");

  console.log("📡 POST /post     -> Binance Square");

  console.log("💚 GET  /health   -> Bot status");
}

start().catch(async (error) => {
  console.error("💥 Fatal startup error:", error?.stack || error);

  await shutdownBinanceBot();

  process.exit(1);
});
