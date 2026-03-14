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
 *   GET    /api/bots/:name/export Download bot as tar.gz archive
 *   PATCH  /api/bots/:name/config Update bot access mode/users
 *   GET    /api/health            Health check
 */

const http = require("http");
const { execSync, exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PROBOTS_PORT || 4200;
const PROBOTS_HOME = process.env.PROBOTS_HOME || path.join(process.env.HOME, "probots");
const DEFAULT_IMAGE = process.env.PROBOTS_IMAGE || "ghcr.io/mcclowin/openclaw-tee:latest";
const API_KEY = process.env.PROBOTS_API_KEY || ""; // empty = no auth
const SHARED_AI_KEY = process.env.SHARED_AI_KEY || ""; // shared Anthropic key for family

// Known images — shown as choices in the wizard
const KNOWN_IMAGES = [
  { id: "openclaw-tee", name: "OpenClaw TEE", image: "ghcr.io/mcclowin/openclaw-tee:latest", desc: "Default OpenClaw agent" },
  { id: "tevy2", name: "Tevy2.ai", image: "ghcr.io/mcclowin/tevy2.ai/agent:2026.3.12-3a7c72b", desc: "OpenClaw 2026.3.12" },
];

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

function sh(cmd, timeout = 15000) {
  try { return execSync(cmd, { encoding: "utf8", timeout }).trim(); }
  catch (e) { return (e.stderr || e.message || "").trim(); }
}

function shResult(cmd, timeout = 15000) {
  try {
    return {
      ok: true,
      output: execSync(cmd, { encoding: "utf8", timeout }).trim(),
    };
  } catch (e) {
    return {
      ok: false,
      output: (e.stderr || e.message || "").trim(),
    };
  }
}

function botDir(name) { return path.join(PROBOTS_HOME, "bots", name); }

function botExists(name) { return fs.existsSync(botDir(name)); }

function getContainerStatus(name) {
  const info = sh(`docker inspect probots-${name} --format '{{.State.Status}}' 2>/dev/null`);
  if (!info) return "not found";
  if (/^error:/i.test(info) || /no such object/i.test(info)) return "not found";
  return info;
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

// Write a file, handling root-owned files/dirs (created by Docker containers)
function writeFileSafe(filePath, content) {
  try {
    fs.writeFileSync(filePath, content);
  } catch (e) {
    if (e.code === "EACCES") {
      // Dir or file is root-owned. Write to /tmp then sudo-copy.
      const tmp = `/tmp/probots-${process.pid}-${path.basename(filePath)}`;
      fs.writeFileSync(tmp, content);
      try {
        execSync(`sudo cp "${tmp}" "${filePath}" && sudo chmod 644 "${filePath}"`, { timeout: 5000 });
      } finally {
        try { fs.unlinkSync(tmp); } catch {}
      }
    } else {
      throw e;
    }
  }
}

function generateOpenclawJson(dataDir, { telegram_token, owner_id, model, gw_token, mode, allowed_users }) {
  mode = mode || "owner-only";

  // Build allowFrom: always includes owner
  const allowFrom = [String(owner_id)];
  if (allowed_users) {
    const extras = (typeof allowed_users === "string" ? allowed_users.split(",") : allowed_users)
      .map(u => String(u).trim())
      .filter(u => u && u !== String(owner_id));
    allowFrom.push(...extras);
  }

  // Read existing config and merge — OpenClaw adds its own fields we must preserve
  const configPath = path.join(dataDir, "openclaw.json");
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {}

  // Merge our settings into the existing config
  config.gateway = Object.assign(config.gateway || {}, { bind: "lan", port: 3000, auth: { mode: "token", token: gw_token } });
  config.agents = Object.assign(config.agents || {}, { defaults: { model: { primary: model } } });
  config.plugins = Object.assign(config.plugins || {}, { allow: ["telegram"], entries: { telegram: { enabled: true } } });
  config.channels = config.channels || {};

  const telegramConfig = {
    enabled: true,
    botToken: telegram_token,
    dmPolicy: "allowlist",
    allowFrom,
    configWrites: false,  // Prevent OpenClaw from rewriting our config on startup
  };

  if (mode === "group") {
    telegramConfig.groupPolicy = "open";
    telegramConfig.groups = { "*": { requireMention: true } };
  } else {
    telegramConfig.groupPolicy = "disabled";
    delete (config.channels.telegram || {}).groups;
  }

  config.channels.telegram = Object.assign(config.channels.telegram || {}, telegramConfig);

  const content = JSON.stringify(config, null, 2);
  writeFileSafe(configPath, content);
  // Golden copy — restored by entrypoint-wrapper.sh after OpenClaw's configure.js rewrites the config
  writeFileSafe(path.join(dataDir, ".golden-openclaw.json"), content);
}

const VALID_PROVIDERS = ["anthropic", "openai", "openai-codex", "openrouter", "google", "groq", "deepseek"];

const DEFAULT_MODELS = {
  anthropic: "anthropic/claude-sonnet-4-20250514",
  openai: "openai/gpt-4o",
  "openai-codex": "openai-codex/gpt-5.4",
  openrouter: "openrouter/anthropic/claude-sonnet-4-5",
  google: "google/gemini-2.0-flash",
  groq: "groq/llama-3.3-70b-versatile",
  deepseek: "deepseek/deepseek-chat",
};

function normalizeModelForProvider(provider, model) {
  const fallback = DEFAULT_MODELS[provider] || DEFAULT_MODELS.anthropic;
  const value = String(model || "").trim();
  if (!value) return fallback;

  // Guard against provider/model mismatch that causes wrong auth path at runtime.
  if (provider === "openai-codex" && !value.startsWith("openai-codex/")) return DEFAULT_MODELS["openai-codex"];
  if (provider === "openai" && value.startsWith("openai-codex/")) return DEFAULT_MODELS.openai;

  return value;
}

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function extractCodexAccountId(payload) {
  if (!payload || typeof payload !== "object") return "";
  const auth = payload["https://api.openai.com/auth"] || {};
  return auth.chatgpt_account_id || auth.account_id || payload.account_id || payload.accountId || "";
}

function normalizeCodexOAuthInput(codexAuthJson) {
  if (!codexAuthJson) return null;

  let parsed = codexAuthJson;
  if (typeof codexAuthJson === "string") {
    const raw = codexAuthJson.trim();
    if (!raw) return null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: "Invalid codex_auth_json: must be valid JSON from ~/.codex/auth.json" };
    }
  }

  const tokens = parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : parsed;
  const access = tokens.access_token || tokens.access || tokens.token || "";
  const refresh = tokens.refresh_token || tokens.refresh || "";
  let accountId = tokens.account_id || tokens.accountId || "";

  if (!access) {
    return { error: "Invalid codex_auth_json: missing tokens.access_token" };
  }

  const accessPayload = decodeJwtPayload(access);
  if (!accountId) accountId = extractCodexAccountId(accessPayload);

  if (!accountId && tokens.id_token) {
    accountId = extractCodexAccountId(decodeJwtPayload(tokens.id_token));
  }

  if (!accountId) {
    return { error: "Invalid codex_auth_json: could not determine account_id from token payload" };
  }

  let expires = null;
  if (typeof tokens.expires === "number") expires = tokens.expires;
  if (!expires && typeof tokens.expires_at === "number") expires = tokens.expires_at;
  if (!expires && accessPayload && typeof accessPayload.exp === "number") expires = accessPayload.exp * 1000;
  if (!expires) expires = Date.now() + 55 * 60 * 1000;

  return { access, refresh, expires, accountId };
}

function generateAuthProfiles(dataDir, provider, apiKey, codexOAuth) {
  // OAuth-first provider. If no token was provided, keep existing auth untouched.
  // This allows a post-launch `openclaw models auth add` flow inside the container.
  if (provider === "openai-codex" && !apiKey && !codexOAuth) return;

  const profileDir = path.join(dataDir, "agents", "main", "agent");
  fs.mkdirSync(profileDir, { recursive: true });

  const profileId = `${provider}:default`;
  let credential;
  if (provider === "openai-codex" && codexOAuth) {
    credential = {
      type: "oauth",
      provider,
      access: codexOAuth.access,
      refresh: codexOAuth.refresh,
      expires: codexOAuth.expires,
      accountId: codexOAuth.accountId,
    };
  } else if (provider === "openai-codex") {
    // Backward-compatible fallback for direct token paste.
    credential = { type: "token", provider, token: apiKey };
  } else {
    credential = { type: "api_key", provider, key: apiKey };
  }

  const profiles = {
    version: 1,
    profiles: {
      [profileId]: credential,
    },
  };

  const content = JSON.stringify(profiles, null, 2);
  writeFileSafe(path.join(profileDir, "auth-profiles.json"), content);
  // Golden copy — restored by entrypoint-wrapper.sh after image startup scripts may rewrite auth
  writeFileSafe(path.join(dataDir, ".golden-auth-profiles.json"), content);
}

function entrypointWrapperScript() {
  return `#!/bin/sh
GOLDEN_CFG="/root/.openclaw/.golden-openclaw.json"
TARGET_CFG="/root/.openclaw/openclaw.json"
GOLDEN_AUTH="/root/.openclaw/.golden-auth-profiles.json"
TARGET_AUTH="/root/.openclaw/agents/main/agent/auth-profiles.json"

if [ -f "$GOLDEN_CFG" ]; then
  ( sleep 15; cp "$GOLDEN_CFG" "$TARGET_CFG"; echo "[probots] Restored golden openclaw.json" ) &
fi

if [ -f "$GOLDEN_AUTH" ]; then
  (
    sleep 15
    mkdir -p "$(dirname "$TARGET_AUTH")"
    cp "$GOLDEN_AUTH" "$TARGET_AUTH"
    echo "[probots] Restored golden auth-profiles.json"
  ) &
fi

exec /entrypoint.sh
`;
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
      mode: env.BOT_MODE || "owner-only",
      allowed_users: env.ALLOWED_USERS || "",
      provider: env.AI_PROVIDER || "anthropic",
      image: env.BOT_IMAGE || DEFAULT_IMAGE,
    };
  });
}

function spawnBot({ name, telegram_token, api_key, codex_auth_json, owner_id, provider, model, soul, mem_limit, mode, allowed_users, image }) {
  // Validate
  if (!name || !/^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$/.test(name)) {
    return { error: "Invalid name: 2-24 chars, lowercase alphanumeric + hyphens" };
  }
  provider = provider || "anthropic";
  if (!VALID_PROVIDERS.includes(provider)) return { error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` };
  if (!telegram_token) return { error: "telegram_token required" };
  if (!owner_id) return { error: "owner_id required" };

  // API-key providers use either explicit key or shared key.
  // openai-codex can run with OAuth login/token flows (no API key required at spawn time).
  if (provider !== "openai-codex" && (!api_key || api_key === "__SHARED_KEY__")) {
    if (!SHARED_AI_KEY) return { error: "No AI API key configured. Contact the admin." };
    api_key = SHARED_AI_KEY;
  }
  let codexOAuth = null;
  if (provider === "openai-codex") {
    if (codex_auth_json) {
      codexOAuth = normalizeCodexOAuthInput(codex_auth_json);
      if (codexOAuth && codexOAuth.error) return { error: codexOAuth.error };
    } else if (api_key) {
      codexOAuth = normalizeCodexOAuthInput({ tokens: { access_token: api_key } });
      if (codexOAuth && codexOAuth.error) {
        return { error: "Invalid openai-codex token: paste full ~/.codex/auth.json or run OAuth login inside the container" };
      }
    }
  }

  mode = mode || "owner-only";
  if (!["owner-only", "group"].includes(mode)) return { error: "mode must be 'owner-only' or 'group'" };
  allowed_users = allowed_users || "";

  if (botExists(name)) return { error: `Bot '${name}' already exists` };

  model = normalizeModelForProvider(provider, model);
  image = image || DEFAULT_IMAGE;
  mem_limit = mem_limit || "512";
  const gw_token = crypto.randomBytes(32).toString("hex");

  const dir = botDir(name);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });

  // bot.env — ANTHROPIC_API_KEY is required by the TEE entrypoint even for non-Anthropic providers.
  // For OAuth-first providers, keep a non-empty placeholder so startup scripts don't choke on missing vars.
  const envApiKey = provider === "openai-codex" ? "__OAUTH__" : (api_key || "__OAUTH__");
  let envContent = `BOT_NAME=${name}
TELEGRAM_BOT_TOKEN=${telegram_token}
ANTHROPIC_API_KEY=${envApiKey}
AI_API_KEY=${envApiKey}
AI_PROVIDER=${provider}
TELEGRAM_OWNER_ID=${owner_id}
DEFAULT_MODEL=${model}
GATEWAY_TOKEN=${gw_token}
MEM_LIMIT=${mem_limit}m
BOT_MODE=${mode}
ALLOWED_USERS=${allowed_users}
BOT_IMAGE=${image}
CREATED=${new Date().toISOString()}`;

  if (soul) envContent += `\nSOUL_MD=${soul}`;

  fs.writeFileSync(path.join(dir, "bot.env"), envContent, { mode: 0o600 });

  // Generate openclaw.json + auth-profiles.json
  generateOpenclawJson(path.join(dir, "data"), {
    telegram_token, owner_id, model, gw_token, mode, allowed_users,
  });
  generateAuthProfiles(path.join(dir, "data"), provider, api_key, codexOAuth);

  // Entrypoint wrapper — restores our config/auth after image startup scripts rewrite them
  fs.writeFileSync(path.join(dir, "data", "entrypoint-wrapper.sh"), entrypointWrapperScript(), { mode: 0o755 });

  // docker-compose.yml
  const compose = `version: "3"
services:
  openclaw:
    image: ${image}
    container_name: probots-${name}
    env_file: bot.env
    entrypoint: ["/bin/sh", "/root/.openclaw/entrypoint-wrapper.sh"]
    environment:
      - NODE_OPTIONS=--max-old-space-size=1536
    volumes:
      - ./data:/root/.openclaw
    restart: unless-stopped
    mem_limit: 2048m
`;
  fs.writeFileSync(path.join(dir, "docker-compose.yml"), compose);

  // Pull can take several minutes for first-time custom images.
  // If pull fails but image already exists locally, proceed with local cache.
  const pull = shResult(`docker pull "${image}" 2>&1`, 10 * 60 * 1000);
  if (!pull.ok) {
    const localImage = sh(`docker image inspect "${image}" --format '{{.Id}}' 2>/dev/null`);
    if (!localImage) {
      return { error: pull.output || `Failed to pull image '${image}'` };
    }
  }

  // Start (also allow extra time for compose/network operations)
  const up = shResult(`cd "${dir}" && ${DC} up -d 2>&1`, 2 * 60 * 1000);
  if (!up.ok) {
    return { error: up.output || "Failed to start container" };
  }

  return {
    name,
    status: "starting",
    provider,
    model,
    image,
    owner_id,
    mode,
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
  // Data files are root-owned (created by container), use docker to clean contents
  // Note: rm -rf /cleanup/* (not /cleanup) — can't delete a mount point from inside
  sh(`docker run --rm -v "${botDir(name)}":/cleanup alpine sh -c "rm -rf /cleanup/*"`);
  fs.rmSync(botDir(name), { recursive: true, force: true });
  return { name, status: "destroyed" };
}

function getBotLogs(name, lines = 100) {
  if (!botExists(name)) return { error: "Bot not found" };
  const logs = sh(`docker logs probots-${name} --tail ${lines} 2>&1`);
  return { name, logs };
}

function configBot(name, updates) {
  if (!botExists(name)) return { error: "Bot not found" };

  // Fix root-owned files left by Docker so we can read/write them
  const dataPath = path.join(botDir(name), "data");
  try { execSync(`sudo chown -R $(id -u):$(id -g) "${dataPath}"`, { timeout: 5000 }); } catch {}

  const env = getBotEnv(name);
  const currentMode = env.BOT_MODE || "owner-only";
  const currentAllowed = env.ALLOWED_USERS || "";
  const currentProvider = env.AI_PROVIDER || "anthropic";
  const currentModel = env.DEFAULT_MODEL || DEFAULT_MODELS[currentProvider];
  const currentApiKeyRaw = env.AI_API_KEY || env.ANTHROPIC_API_KEY || "";
  const currentApiKey = currentApiKeyRaw === "__OAUTH__" ? "" : currentApiKeyRaw;

  let finalMode = updates.mode || currentMode;
  if (!["owner-only", "group"].includes(finalMode)) {
    return { error: "mode must be 'owner-only' or 'group'" };
  }

  let finalProvider = updates.provider || currentProvider;
  if (!VALID_PROVIDERS.includes(finalProvider)) {
    return { error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` };
  }

  let finalModel = normalizeModelForProvider(finalProvider, updates.model || currentModel);

  let finalApiKey = updates.api_key || currentApiKey;
  let codexOAuth = null;
  // Switching into OAuth provider without an explicit token should not reuse API keys from other providers.
  if (updates.provider === "openai-codex" && !updates.api_key) {
    finalApiKey = "";
  }
  if (finalProvider === "openai-codex") {
    if (updates.codex_auth_json) {
      codexOAuth = normalizeCodexOAuthInput(updates.codex_auth_json);
      if (codexOAuth && codexOAuth.error) return { error: codexOAuth.error };
    } else if (updates.api_key) {
      codexOAuth = normalizeCodexOAuthInput({ tokens: { access_token: updates.api_key } });
      if (codexOAuth && codexOAuth.error) {
        return { error: "Invalid openai-codex token: paste full ~/.codex/auth.json or run OAuth login inside the container" };
      }
    }
  }
  if (finalProvider !== "openai-codex" && !finalApiKey) {
    return { error: "api_key required for this provider" };
  }
  let finalAllowed = updates.allowed_users !== undefined ? String(updates.allowed_users) : currentAllowed;

  // Handle add_user
  if (updates.add_user) {
    const currentList = finalAllowed ? finalAllowed.split(",").map(s => s.trim()) : [];
    if (!currentList.includes(String(updates.add_user))) {
      currentList.push(String(updates.add_user));
    }
    finalAllowed = currentList.join(",");
  }

  // Handle remove_user
  if (updates.remove_user) {
    const currentList = finalAllowed ? finalAllowed.split(",").map(s => s.trim()) : [];
    finalAllowed = currentList.filter(u => u !== String(updates.remove_user)).join(",");
  }

  // Update bot.env
  const envFile = path.join(botDir(name), "bot.env");
  let envContent = fs.readFileSync(envFile, "utf8")
    .split("\n")
    .filter(l => !l.startsWith("BOT_MODE=") && !l.startsWith("ALLOWED_USERS=") &&
                 !l.startsWith("AI_API_KEY=") && !l.startsWith("AI_PROVIDER=") &&
                 !l.startsWith("DEFAULT_MODEL=") && !l.startsWith("ANTHROPIC_API_KEY="))
    .join("\n");
  const envApiKey = finalProvider === "openai-codex" ? "__OAUTH__" : finalApiKey;
  envContent += `\nANTHROPIC_API_KEY=${envApiKey}`;
  envContent += `\nAI_API_KEY=${envApiKey}`;
  envContent += `\nAI_PROVIDER=${finalProvider}`;
  envContent += `\nDEFAULT_MODEL=${finalModel}`;
  envContent += `\nBOT_MODE=${finalMode}`;
  if (finalAllowed) envContent += `\nALLOWED_USERS=${finalAllowed}`;

  fs.writeFileSync(envFile, envContent, { mode: 0o600 });

  // Regenerate config files
  const updatedEnv = getBotEnv(name);
  const dataDir = path.join(botDir(name), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  generateOpenclawJson(dataDir, {
    telegram_token: updatedEnv.TELEGRAM_BOT_TOKEN,
    owner_id: updatedEnv.TELEGRAM_OWNER_ID,
    model: finalModel,
    gw_token: updatedEnv.GATEWAY_TOKEN,
    mode: finalMode,
    allowed_users: finalAllowed,
  });
  generateAuthProfiles(dataDir, finalProvider, finalApiKey, codexOAuth);

  // Ensure entrypoint wrapper is up to date (for bots created before/after this feature)
  const wrapperPath = path.join(botDir(name), "data", "entrypoint-wrapper.sh");
  fs.writeFileSync(wrapperPath, entrypointWrapperScript(), { mode: 0o755 });

  // Update docker-compose to use wrapper entrypoint if not already
  const composePath = path.join(botDir(name), "docker-compose.yml");
  let composeContent = fs.readFileSync(composePath, "utf8");
  if (!composeContent.includes("entrypoint-wrapper")) {
    composeContent = composeContent.replace(
      /    env_file: bot\.env\n/,
      `    env_file: bot.env\n    entrypoint: ["/bin/sh", "/root/.openclaw/entrypoint-wrapper.sh"]\n`
    );
    fs.writeFileSync(composePath, composeContent);
  }

  // Recreate container to pick up entrypoint change (restart alone doesn't do it)
  const status = getContainerStatus(name);
  if (status === "running" || status.includes("Restarting")) {
    sh(`cd "${botDir(name)}" && ${DC} up -d --force-recreate 2>&1`);
  }

  return {
    name,
    provider: finalProvider,
    model: finalModel,
    mode: finalMode,
    allowed_users: finalAllowed,
    status: status === "running" ? "restarting" : status,
  };
}

// ── Router ──

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    return res.end();
  }

  // Serve static files
  if (req.method === "GET" && !req.url.startsWith("/api/")) {
    const publicDir = path.join(__dirname, "public");
    let filePath = path.join(publicDir, req.url === "/" ? "index.html" : req.url);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
      res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
      return res.end(fs.readFileSync(filePath));
    }
  }

  // Auth check
  if (!checkAuth(req)) return json(res, 401, { error: "Unauthorized" });

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api", "bots", ...]

  // GET /api/health
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, { status: "ok", docker: !!DC, default_image: DEFAULT_IMAGE, known_images: KNOWN_IMAGES, shared_key: !!SHARED_AI_KEY });
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
        mode: env.BOT_MODE || "owner-only",
        allowed_users: env.ALLOWED_USERS || "",
        provider: env.AI_PROVIDER || "anthropic",
        image: env.BOT_IMAGE || DEFAULT_IMAGE,
      });
    }

    // GET /api/bots/:name/logs
    if (req.method === "GET" && action === "logs") {
      const lines = url.searchParams.get("lines") || 100;
      return json(res, 200, getBotLogs(name, lines));
    }

    // GET /api/bots/:name/export — download bot as tar.gz
    if (req.method === "GET" && action === "export") {
      if (!botExists(name)) return json(res, 404, { error: "Bot not found" });

      // Fix root-owned files so tar can read them
      const dataPath = path.join(botDir(name), "data");
      try { execSync(`sudo chown -R $(id -u):$(id -g) "${dataPath}"`, { timeout: 5000 }); } catch {}

      const tmpFile = `/tmp/probots-export-${name}-${Date.now()}.tar.gz`;
      try {
        execSync(`tar czf "${tmpFile}" -C "${path.join(PROBOTS_HOME, "bots")}" "${name}"`, { timeout: 30000 });
        const stat = fs.statSync(tmpFile);
        res.writeHead(200, {
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${name}.tar.gz"`,
          "Content-Length": stat.size,
          "Access-Control-Allow-Origin": "*",
        });
        const stream = fs.createReadStream(tmpFile);
        stream.pipe(res);
        stream.on("end", () => { try { fs.unlinkSync(tmpFile); } catch {} });
        stream.on("error", () => { try { fs.unlinkSync(tmpFile); } catch {} });
        return;
      } catch (e) {
        try { fs.unlinkSync(tmpFile); } catch {}
        return json(res, 500, { error: "Export failed: " + e.message });
      }
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

    // PATCH /api/bots/:name/config
    if (req.method === "PATCH" && action === "config") {
      if (!botExists(name)) return json(res, 404, { error: "Bot not found" });
      const body = await readBody(req);
      try {
        const result = configBot(name, body);
        return json(res, result.error ? 400 : 200, result);
      } catch (e) {
        return json(res, 500, { error: "Config update failed: " + e.message });
      }
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
  console.log(`   Image:  ${DEFAULT_IMAGE} (default)`);
  console.log(`   Home:   ${PROBOTS_HOME}`);
  console.log(`   Auth:   ${API_KEY ? "enabled" : "disabled (set PROBOTS_API_KEY)"}`);
});
