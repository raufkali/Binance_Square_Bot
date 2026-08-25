import dotenv from "dotenv";
import http from "http";

import {
  runBinanceBot,
  getBinanceStatus,
  shutdownBinanceBot,
  POST_TRIGGER_SECRET as BINANCE_POST_TRIGGER_SECRET,
} from "./binance-bot.js";

import {
  runLinkedInBot,
  getLinkedInStatus,
  shutdownLinkedInBot,
  getLinkedInAuthorizationUrl,
  handleLinkedInAuthCallback,
  POST_TRIGGER_SECRET as LINKEDIN_POST_TRIGGER_SECRET,
} from "./linkedin-bot.js";

dotenv.config();

/*
=========================================================
COMBINED SERVER — ONE PROCESS, ONE PORT

Routes:

  GET  /                         -> combined health/status
  GET  /health                   -> combined health/status
  GET  /auth/linkedin            -> start LinkedIn OAuth
  GET  /auth/linkedin/callback   -> finish LinkedIn OAuth
  POST /post                     -> trigger Binance Square cycle
  POST /linkedin/post            -> trigger LinkedIn cycle

Each bot keeps its own secret, its own MongoDB
collections, its own state file, and its own posting
logic exactly as before. This file only owns the HTTP
server and routes requests to the right bot module.
=========================================================
*/

const PORT = parsePositiveInteger(process.env.PORT, 3000);

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  if (Number.isInteger(number) && number > 0) return number;
  return fallback;
}

/* =======================================================
   AUTH HELPERS
======================================================= */

function isAuthorized(req, secret) {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !secret) return false;
  return authorization === `Bearer ${secret}`;
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let finished = false;

    const finishReject = (error) => {
      if (finished) return;
      finished = true;
      reject(error);
    };
    const finishResolve = () => {
      if (finished) return;
      finished = true;
      resolve(body);
    };

    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 10000) {
        finishReject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", finishResolve);
    req.on("error", finishReject);
  });
}

function sendJSON(res, statusCode, data) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendHTML(res, statusCode, html) {
  if (res.headersSent) return;
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

/* =======================================================
   SERVER
======================================================= */

let httpServer = null;
let binanceCycleInFlight = false;
let linkedinCycleInFlight = false;

async function startServer() {
  httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      /* ---------------------------------------------
         COMBINED HEALTH CHECK
      --------------------------------------------- */
      if (
        req.method === "GET" &&
        (url.pathname === "/" || url.pathname === "/health")
      ) {
        const [binance, linkedin] = await Promise.all([
          Promise.resolve(getBinanceStatus()).catch((error) => ({
            error: error.message,
          })),
          getLinkedInStatus().catch((error) => ({ error: error.message })),
        ]);

        return sendJSON(res, 200, {
          status: "alive",
          uptime: process.uptime(),
          binance,
          linkedin,
        });
      }

      /* ---------------------------------------------
         LINKEDIN OAUTH START
      --------------------------------------------- */
      if (req.method === "GET" && url.pathname === "/auth/linkedin") {
        const authUrl = getLinkedInAuthorizationUrl();
        res.writeHead(302, { Location: authUrl });
        return res.end();
      }

      /* ---------------------------------------------
         LINKEDIN OAUTH CALLBACK
      --------------------------------------------- */
      if (req.method === "GET" && url.pathname === "/auth/linkedin/callback") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        const { statusCode, html } = await handleLinkedInAuthCallback({
          code,
          state,
          error,
        });

        return sendHTML(res, statusCode, html);
      }

      /* ---------------------------------------------
         BINANCE TRIGGER
      --------------------------------------------- */
      if (req.method === "POST" && url.pathname === "/post") {
        console.log("\n📥 POST /post (Binance) trigger received.");

        if (!isAuthorized(req, BINANCE_POST_TRIGGER_SECRET)) {
          console.log("❌ Unauthorized Binance trigger.");
          return sendJSON(res, 401, { success: false, error: "Unauthorized." });
        }

        if (binanceCycleInFlight) {
          return sendJSON(res, 409, {
            success: false,
            error: "A Binance post cycle is already running.",
          });
        }

        try {
          await readRequestBody(req);
        } catch (error) {
          return sendJSON(res, 400, { success: false, error: error.message });
        }

        binanceCycleInFlight = true;
        try {
          const result = await runBinanceBot();
          return sendJSON(res, result.success || result.skipped ? 200 : 500, {
            ...result,
          });
        } finally {
          binanceCycleInFlight = false;
        }
      }

      /* ---------------------------------------------
         LINKEDIN TRIGGER
      --------------------------------------------- */
      if (req.method === "POST" && url.pathname === "/linkedin/post") {
        console.log("\n📥 POST /linkedin/post trigger received.");

        if (!isAuthorized(req, LINKEDIN_POST_TRIGGER_SECRET)) {
          console.log("❌ Unauthorized LinkedIn trigger.");
          return sendJSON(res, 401, { success: false, error: "Unauthorized." });
        }

        if (linkedinCycleInFlight) {
          return sendJSON(res, 409, {
            success: false,
            error: "A LinkedIn post cycle is already running.",
          });
        }

        try {
          await readRequestBody(req);
        } catch (error) {
          return sendJSON(res, 400, { success: false, error: error.message });
        }

        linkedinCycleInFlight = true;
        try {
          const result = await runLinkedInBot();
          return sendJSON(res, result.success || result.skipped ? 200 : 500, {
            ...result,
          });
        } finally {
          linkedinCycleInFlight = false;
        }
      }

      /* ---------------------------------------------
         404
      --------------------------------------------- */
      return sendJSON(res, 404, {
        success: false,
        error: "Route not found.",
        availableRoutes: [
          "GET /",
          "GET /health",
          "GET /auth/linkedin",
          "GET /auth/linkedin/callback",
          "POST /post",
          "POST /linkedin/post",
        ],
      });
    } catch (error) {
      console.error("❌ HTTP request error:", error?.stack || error);
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
      console.log(`🟢 HTTP server running on port ${PORT}`);
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

  console.log(`\n🛑 ${signal} received. Shutting down both bots...`);

  await Promise.allSettled([shutdownBinanceBot(), shutdownLinkedInBot()]);

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
   STARTUP
======================================================= */

async function start() {
  console.log(`
╔══════════════════════════════════════════════════╗
║      COMBINED BOT SERVER (Binance + LinkedIn)     ║
╚══════════════════════════════════════════════════╝
`);

  await startServer();

  console.log("\n🟢 Waiting for triggers.");
  console.log("📡 POST /post            -> Binance Square");
  console.log("📡 POST /linkedin/post   -> LinkedIn");
  console.log("🔐 GET  /auth/linkedin   -> connect LinkedIn account");
  console.log("💚 GET  /health          -> combined status for both bots");
}

start().catch(async (error) => {
  console.error("💥 Fatal startup error:", error?.stack || error);
  process.exit(1);
});
