#!/usr/bin/env node
/**
 * test-api.js — test all ProBots API routes, then spawn abuclaw
 *
 * Usage: node test-api.js
 */

const http = require("http");

const BASE = "http://localhost:4200";
let pass = 0;
let fail = 0;

function request(method, path, body) {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {}
    };
    if (body) {
      const data = JSON.stringify(body);
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => chunks += c);
      res.on("end", () => {
        let json;
        try { json = JSON.parse(chunks); } catch { json = chunks; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function check(label, actual, expected) {
  if (actual === expected) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label} (${actual})`);
    pass++;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m ${label} (got ${actual}, expected ${expected})`);
    fail++;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function run() {
  console.log("========================================");
  console.log("       ProBots API Test Suite");
  console.log("========================================\n");

  // 1. Health check
  let r = await request("GET", "/api/health");
  check("GET /api/health", r.status, 200);

  // 2. List bots (empty)
  r = await request("GET", "/api/bots");
  check("GET /api/bots (empty list)", r.status, 200);

  // 3. Get non-existent bot
  r = await request("GET", "/api/bots/ghost");
  check("GET /api/bots/ghost (not found)", r.status, 404);

  // 4. Stop non-existent bot
  r = await request("POST", "/api/bots/ghost/stop");
  check("POST /api/bots/ghost/stop (not found)", r.status, 404);

  // 5. Start non-existent bot
  r = await request("POST", "/api/bots/ghost/start");
  check("POST /api/bots/ghost/start (not found)", r.status, 404);

  // 6. Restart non-existent bot
  r = await request("POST", "/api/bots/ghost/restart");
  check("POST /api/bots/ghost/restart (not found)", r.status, 404);

  // 7. Delete non-existent bot
  r = await request("DELETE", "/api/bots/ghost");
  check("DELETE /api/bots/ghost (not found)", r.status, 404);

  // 8. Logs for non-existent bot
  r = await request("GET", "/api/bots/ghost/logs");
  check("GET /api/bots/ghost/logs (not found)", r.status, 200);

  // 9. Spawn with missing fields
  r = await request("POST", "/api/bots", { name: "test" });
  check("POST /api/bots (missing fields)", r.status, 400);

  // 10. Spawn with invalid name
  r = await request("POST", "/api/bots", { name: "X!", telegram_token: "t", api_key: "k", owner_id: "o" });
  check("POST /api/bots (bad name)", r.status, 400);

  // 11. Unknown route
  r = await request("GET", "/api/nope");
  check("GET /api/nope (unknown route)", r.status, 404);

  console.log("\n========================================");
  console.log("       Spawning abuclaw");
  console.log("========================================\n");

  // 12. Spawn abuclaw
  r = await request("POST", "/api/bots", {
    name: "abuclaw",
    telegram_token: "8277487172:AAH18ku-nGWLz7Iz_6USr7OPbNrmXNEZfkc",
    api_key: "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",
    owner_id: "1310278446",
    soul: "You are AbuClaw. Be helpful and concise.",
  });
  check("POST /api/bots (spawn abuclaw)", r.status, 201);

  // 13. Spawn duplicate
  r = await request("POST", "/api/bots", { name: "abuclaw", telegram_token: "t", api_key: "k", owner_id: "o" });
  check("POST /api/bots (duplicate abuclaw)", r.status, 400);

  await sleep(2000);

  // 14. Get abuclaw status
  r = await request("GET", "/api/bots/abuclaw");
  check("GET /api/bots/abuclaw (status)", r.status, 200);

  // 15. List bots (has abuclaw)
  r = await request("GET", "/api/bots");
  check("GET /api/bots (has abuclaw)", r.status, 200);

  // 16. Get logs
  r = await request("GET", "/api/bots/abuclaw/logs?lines=10");
  check("GET /api/bots/abuclaw/logs", r.status, 200);

  // 17. Stop
  r = await request("POST", "/api/bots/abuclaw/stop");
  check("POST /api/bots/abuclaw/stop", r.status, 200);

  await sleep(1000);

  // 18. Start
  r = await request("POST", "/api/bots/abuclaw/start");
  check("POST /api/bots/abuclaw/start", r.status, 200);

  await sleep(1000);

  // 19. Restart
  r = await request("POST", "/api/bots/abuclaw/restart");
  check("POST /api/bots/abuclaw/restart", r.status, 200);

  console.log("\n========================================");
  console.log(`  Results: \x1b[32m${pass} passed\x1b[0m, \x1b[31m${fail} failed\x1b[0m`);
  console.log("========================================");
  process.exit(fail > 0 ? 1 : 0);
}

run();
