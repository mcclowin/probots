import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";

const PROBOTS_HOME = process.env.PROBOTS_HOME || path.join(process.env.HOME || "/root", "probots");
const IMAGE = process.env.PROBOTS_IMAGE || "ghcr.io/mcclowin/openclaw-tee:latest";
const MASTER_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Phase 2: Swap Docker → Podman for rootless containers + better multi-user isolation
// Phase 3: Swap docker-compose → K3s for scheduling, health checks, resource quotas
// Phase 4: Multi-node K3s + Terraform for cloud provisioning

// Detect docker compose
let DC: string;
try {
  execSync("docker compose version", { stdio: "ignore" });
  DC = "docker compose";
} catch {
  try {
    execSync("docker-compose version", { stdio: "ignore" });
    DC = "docker-compose";
  } catch {
    DC = "";
  }
}

function sh(cmd: string, timeout = 15000): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout }).trim();
  } catch (e: any) {
    return e.stderr || e.message || "";
  }
}

function botDir(name: string) {
  return path.join(PROBOTS_HOME, "bots", name);
}

export function getContainerStatus(name: string): string {
  try {
    return sh(`docker inspect probots-${name} --format '{{.State.Status}}'`) || "unknown";
  } catch {
    return "not found";
  }
}

export interface SpawnOpts {
  name: string;
  telegramToken: string;
  telegramOwnerId: string;
  anthropicKey?: string; // null = use master key
  model?: string;
  soul?: string;
}

export function spawnBot(opts: SpawnOpts): { error?: string } {
  if (!DC) return { error: "Docker Compose not found" };

  const { name, telegramToken, telegramOwnerId, soul } = opts;
  const apiKey = opts.anthropicKey || MASTER_API_KEY;
  const model = opts.model || "anthropic/claude-sonnet-4-20250514";

  if (!apiKey) return { error: "No API key configured. Contact admin." };
  if (!name || !/^[a-z0-9][a-z0-9-]{0,22}[a-z0-9]$/.test(name)) {
    return { error: "Invalid name: 2-24 chars, lowercase alphanumeric + hyphens" };
  }

  const dir = botDir(name);
  if (fs.existsSync(dir)) return { error: `Bot '${name}' already exists` };

  fs.mkdirSync(path.join(dir, "data"), { recursive: true });

  const gwToken = crypto.randomBytes(32).toString("hex");

  // bot.env
  let env = `BOT_NAME=${name}
TELEGRAM_BOT_TOKEN=${telegramToken}
ANTHROPIC_API_KEY=${apiKey}
TELEGRAM_OWNER_ID=${telegramOwnerId}
DEFAULT_MODEL=${model}
GATEWAY_TOKEN=${gwToken}
CREATED=${new Date().toISOString()}`;

  if (soul) env += `\nSOUL_MD=${soul}`;

  fs.writeFileSync(path.join(dir, "bot.env"), env, { mode: 0o600 });

  // docker-compose.yml
  const compose = `services:
  openclaw:
    image: ${IMAGE}
    container_name: probots-${name}
    env_file: bot.env
    environment:
      - NODE_OPTIONS=--max-old-space-size=1536
    volumes:
      - ./data:/root/.openclaw
    restart: unless-stopped
    mem_limit: 2048m
`;
  fs.writeFileSync(path.join(dir, "docker-compose.yml"), compose);

  const result = sh(`cd "${dir}" && ${DC} up -d 2>&1`, 30000);
  if (result.toLowerCase().includes("error")) return { error: result };

  return {};
}

export function stopBot(name: string): { error?: string } {
  if (!fs.existsSync(botDir(name))) return { error: "Bot not found" };
  sh(`cd "${botDir(name)}" && ${DC} stop 2>&1`);
  return {};
}

export function startBot(name: string): { error?: string } {
  if (!fs.existsSync(botDir(name))) return { error: "Bot not found" };
  sh(`cd "${botDir(name)}" && ${DC} up -d 2>&1`);
  return {};
}

export function restartBot(name: string): { error?: string } {
  if (!fs.existsSync(botDir(name))) return { error: "Bot not found" };
  sh(`cd "${botDir(name)}" && ${DC} restart 2>&1`);
  return {};
}

export function destroyBot(name: string): { error?: string } {
  const dir = botDir(name);
  if (!fs.existsSync(dir)) return { error: "Bot not found" };
  sh(`cd "${dir}" && ${DC} down -v 2>&1`);
  sh(`docker rm -f probots-${name} 2>/dev/null`);
  // Clean root-owned files — rm contents, not mount point
  sh(`docker run --rm -v "${dir}":/cleanup alpine sh -c "rm -rf /cleanup/*"`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return {};
}

export function getBotLogs(name: string, lines = 100): string {
  if (!fs.existsSync(botDir(name))) return "Bot not found";
  return sh(`docker logs probots-${name} --tail ${lines} 2>&1`, 10000);
}

export function exportBot(name: string): Buffer | null {
  const dataDir = path.join(botDir(name), "data");
  if (!fs.existsSync(dataDir)) return null;

  // Use tar to create archive — includes root-owned files
  const archivePath = `/tmp/probots-export-${name}-${Date.now()}.tar.gz`;
  sh(`docker run --rm -v "${dataDir}":/data -v /tmp:/out alpine sh -c "cd /data && tar czf /out/$(basename ${archivePath}) workspace/ agents/ 2>/dev/null || tar czf /out/$(basename ${archivePath}) . 2>/dev/null"`, 30000);

  if (!fs.existsSync(archivePath)) return null;
  const buf = fs.readFileSync(archivePath);
  fs.unlinkSync(archivePath);
  return buf;
}

export function listRunningContainers(): string[] {
  const result = sh('docker ps --filter "name=probots-" --format "{{.Names}}"');
  return result ? result.split("\n").filter(Boolean) : [];
}
