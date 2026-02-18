#!/usr/bin/env node
/**
 * ProBots Backend — REST API for managing OpenClaw bot containers
 *
 * Endpoints:
 *   GET    /api/bots              List all bots
 *   POST   /api/bots              Spawn a new bot
 *   GET    /api/bots/:name        Bot status
 *   POST   /api/bots/:name/start  Start bot
 *   POST   /api/bots/:name/stop   Stop bot
 *   POST   /api/bots/:name/restart Restart bot
 *   DELETE /api/bots/:name        Destroy bot
 *   GET    /api/bots/:name/logs   Get bot logs
 *   GET    /api/health            Health check
 */

const http = require("http");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PROBOTS_PORT || 4200;
const PROBOTS_HOME = process.env.PROBOTS_HOME || path.join(process.env.HOME, "probots");
const IMAGE = process.env.PROBOTS_IMAGE || "ghcr.io/mcclowin/openclaw-tee:latest";
const API_KEY = process.env.PROBOTS_API_KEY || ""; // empty = no auth

// ── Docker Compose detection ──

let DC;
try { execSync("docker compose version", { stdio: "ignore" }); DC = "docker compose"; }
catch { try { execSync("docker-compose version", { stdio: "ignore" }); DC = "docker-compose"; }
catch { DC = null; } }

// ── Helpers ──

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

function checkAuth(req) {
  if (!API_KEY) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${API_KEY}`;
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 15000 }).trim(); }
  catch (e) { return e.stderr || e.message; }
}

function botDir(name) { return path.join(PROBOTS_HOME, "bots", name); }

function botExists(name) { return fs.existsSync(botDir(name)); }

function getContainerStatus(name) {
  try {
    const info = sh(`docker inspect probots-${name} --format '{{.State.Status}}'`);
    return info || "unknown";
  } catch { return "not found"; }
}

function getBotEnv(name) {
  const envFile = path.join(botDir(name), "bot.env");
  if (!fs.existsSync(envFile)) return {};
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  const env = {};
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

// ── Bot Operations ──

function listBots() {
  const botsDir = path.join(PROBOTS_HOME, "bots");
  if (!fs.existsSync(botsDir)) return [];
  return fs.readdirSync(botsDir).filter(d =>
    fs.statSync(path.join(botsDir, d)).isDirectory()
  ).map(name => {
    const env = getBotEnv(name);
    return {
      name,
      status: getContainerStatus(name),
      model: env.DEFAULT_MODEL || "unknown",
      owner_id: env.TELEGRAM_OWNER_ID || "unknown",
      created: env.CREATED || "unknown",
      mem_limit: env.MEM_LIMIT || "512m",
    };
  });
}

function spawnBot({ name, telegram_token, api_key, owner_id, model, soul, mem_limit }) {
  // Validate
  if (!name || !/^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$/.test(name)) {
    return { error: "Invalid name: 2-24 chars, lowercase alphanumeric + hyphens" };
  }
  if (!telegram_token) return { error: "telegram_token required" };
  if (!api_key) return { error: "api_key required" };
  if (!owner_id) return { error: "owner_id required" };

  if (botExists(name)) return { error: `Bot '${name}' already exists` };

  model = model || "anthropic/claude-sonnet-4-20250514";
  mem_limit = mem_limit || "512";
  const gw_token = crypto.randomBytes(32).toString("hex");

  const dir = botDir(name);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });

  // bot.env
  let envContent = `BOT_NAME=${name}
TELEGRAM_BOT_TOKEN=${telegram_token}
ANTHROPIC_API_KEY=${api_key}
TELEGRAM_OWNER_ID=${owner_id}
DEFAULT_MODEL=${model}
GATEWAY_TOKEN=${gw_token}
MEM_LIMIT=${mem_limit}m
CREATED=${new Date().toISOString()}`;

  if (soul) envContent += `\nSOUL_MD=${soul}`;

  fs.writeFileSync(path.join(dir, "bot.env"), envContent, { mode: 0o600 });

  // docker-compose.yml
  const compose = `version: "3"
services:
  openclaw:
    image: ${IMAGE}
    container_name: probots-${name}
    env_file: bot.env
    volumes:
      - ./data:/root/.openclaw
    restart: unless-stopped
    mem_limit: ${mem_limit}m
`;
  fs.writeFileSync(path.join(dir, "docker-compose.yml"), compose);

  // Start
  const result = sh(`cd "${dir}" && ${DC} up -d 2>&1`);
  if (result.includes("error") || result.includes("Error")) {
    return { error: result };
  }

  return {
    name,
    status: "starting",
    model,
    owner_id,
    container: `probots-${name}`,
  };
}

function stopBot(name) {
  if (!botExists(name)) return { error: "Bot not found" };
  sh(`cd "${botDir(name)}" && ${DC} stop 2>&1`);
  return { name, status: "stopped" };
}

function startBot(name) {
  if (!botExists(name)) return { error: "Bot not found" };
  sh(`cd "${botDir(name)}" && ${DC} up -d 2>&1`);
  return { name, status: "starting" };
}

function restartBot(name) {
  if (!botExists(name)) return { error: "Bot not found" };
  sh(`cd "${botDir(name)}" && ${DC} restart 2>&1`);
  return { name, status: "restarting" };
}

function destroyBot(name) {
  if (!botExists(name)) return { error: "Bot not found" };
  sh(`cd "${botDir(name)}" && ${DC} down -v 2>&1`);
  sh(`docker rm -f probots-${name} 2>/dev/null`);
  fs.rmSync(botDir(name), { recursive: true, force: true });
  return { name, status: "destroyed" };
}

function getBotLogs(name, lines = 100) {
  if (!botExists(name)) return { error: "Bot not found" };
  const logs = sh(`docker logs probots-${name} --tail ${lines} 2>&1`);
  return { name, logs };
}

// ── Router ──

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  // Auth check
  if (!checkAuth(req)) return json(res, 401, { error: "Unauthorized" });

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "bots", ...]

  // GET /api/health
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { status: "ok", docker: !!DC, image: IMAGE });
  }

  // GET /api/bots
  if (req.method === "GET" && url.pathname === "/api/bots") {
    return json(res, 200, { bots: listBots() });
  }

  // POST /api/bots — spawn
  if (req.method === "POST" && url.pathname === "/api/bots") {
    const body = await readBody(req);
    const result = spawnBot(body);
    return json(res, result.error ? 400 : 201, result);
  }

  // Routes with :name
  if (parts[0] === "api" && parts[1] === "bots" && parts[2]) {
    const name = parts[2];
    const action = parts[3]; // start, stop, restart, logs, or undefined

    // GET /api/bots/:name
    if (req.method === "GET" && !action) {
      if (!botExists(name)) return json(res, 404, { error: "Bot not found" });
      const env = getBotEnv(name);
      return json(res, 200, {
        name,
        status: getContainerStatus(name),
        model: env.DEFAULT_MODEL || "unknown",
        owner_id: env.TELEGRAM_OWNER_ID || "unknown",
        created: env.CREATED || "unknown",
      });
    }

    // GET /api/bots/:name/logs
    if (req.method === "GET" && action === "logs") {
      const lines = url.searchParams.get("lines") || 100;
      return json(res, 200, getBotLogs(name, lines));
    }

    // POST /api/bots/:name/start
    if (req.method === "POST" && action === "start") {
      const result = startBot(name);
      return json(res, result.error ? 404 : 200, result);
    }

    // POST /api/bots/:name/stop
    if (req.method === "POST" && action === "stop") {
      const result = stopBot(name);
      return json(res, result.error ? 404 : 200, result);
    }

    // POST /api/bots/:name/restart
    if (req.method === "POST" && action === "restart") {
      const result = restartBot(name);
      return json(res, result.error ? 404 : 200, result);
    }

    // DELETE /api/bots/:name
    if (req.method === "DELETE" && !action) {
      const result = destroyBot(name);
      return json(res, result.error ? 404 : 200, result);
    }
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🤖 ProBots API running on http://0.0.0.0:${PORT}`);
  console.log(`   Docker: ${DC || "NOT FOUND"}`);
  console.log(`   Image:  ${IMAGE}`);
  console.log(`   Home:   ${PROBOTS_HOME}`);
  console.log(`   Auth:   ${API_KEY ? "enabled" : "disabled (set PROBOTS_API_KEY)"}`);
});
