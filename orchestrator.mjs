#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

function loadDotEnv(file) {
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const HOME = os.homedir();
loadDotEnv(path.join(HOME, "whatsapp-mcp", "wa-orchestrator", ".env"));
loadDotEnv(path.join(process.cwd(), ".env"));

const BRIDGE_DIR =
  process.env.WA_BRIDGE_DIR || path.join(HOME, "whatsapp-mcp", "whatsapp-bridge");
const TOKEN_FILE = path.join(BRIDGE_DIR, "store", ".bridge-token");
const STATE_FILE = path.join(HOME, "whatsapp-mcp", "wa-orchestrator", "state.json");
const LOG_FILE = path.join(HOME, "whatsapp-mcp", "wa-orchestrator", "orchestrator.log");

const ALLOWED_NUMBER = (process.env.WA_ALLOWED_NUMBER || "").replace(/\D/g, "");
if (!ALLOWED_NUMBER) {
  console.error(
    "FATAL: WA_ALLOWED_NUMBER is not set. Set it in .env or the environment " +
      "to the only phone number (digits only, with country code, e.g. 5511999999999) " +
      "this bot is allowed to talk to.",
  );
  process.exit(1);
}

const ORCH_PORT = Number(process.env.WA_ORCH_PORT || 8090);
const BRIDGE_URL = process.env.WA_BRIDGE_URL || "http://127.0.0.1:8080";
const CLAUDE_CWD = process.env.WA_CLAUDE_CWD || path.join(HOME, "Dev", "agnus");
const CLAUDE_BIN = process.env.WA_CLAUDE_BIN || "claude";
const CLAUDE_PERMISSION_MODE = process.env.WA_CLAUDE_PERMISSION_MODE || "auto";
const USER_SHELL = process.env.WA_SHELL || "zsh";
const CLAUDE_TIMEOUT_MS = Number(process.env.WA_CLAUDE_TIMEOUT_MS) || 15 * 60 * 1000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const TRANSCRIPTION_MODEL = process.env.WA_TRANSCRIPTION_MODEL || "google/gemini-2.5-flash";
const START_TIME = Date.now();

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
  }
}

function readBridgeToken() {
  try {
    return fs.readFileSync(TOKEN_FILE, "utf8").trim();
  } catch (err) {
    log("ERROR: could not read bridge token at", TOKEN_FILE, err.message);
    return "";
  }
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function markdownToWhatsApp(text) {
  let out = text;

  const codeBlocks = [];
  out = out.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");

  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");

  out = out
    .split("\n")
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(line) || !line.includes("-"))
    .map((line) => {
      const m = line.match(/^\s*\|(.+)\|\s*$/);
      if (!m) return line;
      const cells = m[1].split("|").map((c) => c.trim());
      return cells.join(" - ");
    })
    .join("\n");

  out = out.replace(/^(\s*)[-*]\s+/gm, "$1\u2022 ");

  out = out.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);

  return out.trim();
}

const DEFAULT_SHELL_COMMANDS = [
  "ls", "ll", "la", "lt", "pwd", "git", "whoami", "date", "echo", "cat",
  "head", "tail", "wc", "find", "grep", "du", "df", "top", "ps", "which",
  "tree", "gco", "gst", "gaa", "ga", "gcm", "gc", "gp", "gl", "glog", "glg",
  "gd", "gds", "gb", "gba", "gbd", "gcb", "gcp", "gpull", "gpush",
  "grb", "gm", "gss", "gsta", "gstp",
];
const SHELL_COMMANDS = new Set(
  (process.env.WA_SHELL_COMMANDS
    ? process.env.WA_SHELL_COMMANDS.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_SHELL_COMMANDS
  ).map((c) => c.toLowerCase()),
);

const MAX_REPLY_CHARS = 3500;

function truncate(text) {
  if (text.length <= MAX_REPLY_CHARS) return text;
  return `${text.slice(0, MAX_REPLY_CHARS)}\n… (cortado, ${text.length} chars no total)`;
}

function resolveCdTarget(currentCwd, arg) {
  if (!arg || arg === "~") return HOME;
  let target = arg;
  if (target.startsWith("~/")) target = path.join(HOME, target.slice(2));
  if (!path.isAbsolute(target)) target = path.resolve(currentCwd, target);
  return path.normalize(target);
}

const EZA_ALIASED_COMMANDS = new Set(["ls", "ll", "la", "lt", "tree"]);
function withExplicitPathIfNeeded(command) {
  const tokens = command.trim().split(/\s+/);
  const [first, ...rest] = tokens;
  if (!EZA_ALIASED_COMMANDS.has(first.toLowerCase())) return command;
  const hasPathArg = rest.some((t) => !t.startsWith("-"));
  return hasPathArg ? command : `${command} .`;
}

const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function runShellCommand(rawCommand, cwd) {
  const command = withExplicitPathIfNeeded(rawCommand);
  return new Promise((resolve, reject) => {
    const child = spawn(USER_SHELL, ["-ic", command], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("comando travou por mais de 30s"));
    }, 30 * 1000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output: stripAnsi(output).trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

const bridgeToken = readBridgeToken();
const recentMessageIds = new Set();

let queueTail = Promise.resolve();
function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  queueTail = run.catch(() => {});
  return run;
}

const MEDIA_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
};

async function transcribeAudio(file) {
  if (!OPENROUTER_API_KEY) {
    log("audio received but OPENROUTER_API_KEY is not set");
    return "";
  }
  const mp3 = `${file}.mp3`;
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-ar", "16000", "-ac", "1", mp3]);
      ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg saiu com ${code}`))));
      ff.on("error", reject);
    });

    const request = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: TRANSCRIPTION_MODEL,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Transcreva o áudio literalmente, sem comentários nem formatação." },
              {
                type: "input_audio",
                input_audio: { data: fs.readFileSync(mp3).toString("base64"), format: "mp3" },
              },
            ],
          },
        ],
      }),
    };

    let res, body;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        res = await fetch("https://openrouter.ai/api/v1/chat/completions", request);
        body = await res.json();
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        log("transcription attempt", attempt, "failed:", err.message, "— retrying");
      }
    }
    if (!res.ok) {
      log("ERROR transcribing audio:", res.status, JSON.stringify(body).slice(0, 300));
      return "";
    }
    const text = (body.choices?.[0]?.message?.content || "").trim();
    log("transcribed audio,", text.length, "chars");
    return text;
  } catch (err) {
    log("ERROR transcribing audio:", err.message, "| cause:", err.cause?.message || "-");
    return "";
  } finally {
    fs.rmSync(mp3, { force: true });
  }
}

function saveIncomingMedia(payload) {
  if (!payload.mediaBase64) return null;
  const ext = MEDIA_EXT[payload.mimeType] || (payload.mediaFilename || "").split(".").pop() || "bin";
  const dir = path.join(os.tmpdir(), "wa-media");
  const file = path.join(dir, `${payload.messageId || Date.now()}.${ext}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(payload.mediaBase64, "base64"));
    log("saved incoming", payload.mediaType, "->", file);
    return { path: file, type: payload.mediaType || "" };
  } catch (err) {
    log("ERROR saving incoming media:", err.message);
    return null;
  }
}

async function sendWhatsApp(recipient, message) {
  const res = await fetch(`${BRIDGE_URL}/api/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bridgeToken}`,
    },
    body: JSON.stringify({ recipient, message }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    log("ERROR sending WhatsApp reply:", res.status, JSON.stringify(body));
  }
  return body;
}

async function revokeWhatsApp(recipient, messageId) {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bridgeToken}`,
      },
      body: JSON.stringify({ recipient, message_id: messageId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      log("WARN could not revoke message", messageId, JSON.stringify(body));
      return false;
    }
    return true;
  } catch (err) {
    log("WARN revoke request failed:", messageId, err.message);
    return false;
  }
}

function runClaude({ message, sessionId, sessionCwd, cwd }) {
  return new Promise((resolve, reject) => {
    const spawnCwd = sessionId && sessionCwd ? sessionCwd : cwd;
    const args = [
      "-p",
      message,
      "--output-format",
      "json",
      "--permission-mode",
      CLAUDE_PERMISSION_MODE,
    ];
    if (sessionId) {
      args.push("--resume", sessionId);
    }
    if (spawnCwd !== cwd) {
      args.push("--add-dir", cwd);
    }

    log("spawning:", CLAUDE_BIN, JSON.stringify(args), "cwd=", spawnCwd);

    const child = spawn(CLAUDE_BIN, args, {
      cwd: spawnCwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const err = new Error(
        `a resposta demorou demais (>${Math.round(CLAUDE_TIMEOUT_MS / 60000)}min). Tente de novo, ou mande /novo para começar outra conversa.`,
      );
      reject(err);
    }, CLAUDE_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeout);
      let out;
      try {
        out = JSON.parse(stdout.trim());
      } catch {
        reject(new Error(`claude exited with code ${code}: ${(stderr || stdout).slice(-2000)}`));
        return;
      }
      const text =
        (typeof out.result === "string" && out.result.trim()) ||
        (out.is_error
          ? `(o Claude parou com erro: ${out.subtype || "desconhecido"})`
          : "(sem resposta em texto — tente reformular a pergunta)");
      resolve({ sessionId: out.session_id || sessionId || null, text });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function handleIncomingMessage(payload) {
  const senderNumber = String(payload.sender || "").split("@")[0].split(":")[0];
  if (senderNumber !== ALLOWED_NUMBER) {
    return;
  }
  if (payload.isFromMe) return;
  if (payload.eventType && payload.eventType !== "message") return;
  const hasMedia = Boolean(payload.mediaBase64);
  if (!hasMedia && (!payload.content || !payload.content.trim())) return;

  if (payload.messageId) {
    if (recentMessageIds.has(payload.messageId)) return;
    recentMessageIds.add(payload.messageId);
    if (recentMessageIds.size > 500) {
      const first = recentMessageIds.values().next().value;
      recentMessageIds.delete(first);
    }
  }

  const state = loadState();
  const entry = state[ALLOWED_NUMBER] || {};
  const cwd = entry.cwd || CLAUDE_CWD;
  const chatTarget = payload.chatJID || senderNumber;
  const raw = (payload.content || "").trim();
  const normalized = raw.toLowerCase();
  log("incoming from", senderNumber, "->", JSON.stringify(payload.content).slice(0, 200));

  if (["/novo", "/new", "/reset", "/limpar", "/clear"].includes(normalized)) {
    if (entry.cwd) {
      state[ALLOWED_NUMBER] = { cwd: entry.cwd };
    } else {
      delete state[ALLOWED_NUMBER];
    }
    saveState(state);
    await sendWhatsApp(
      chatTarget,
      "\u{1F195} Sessão anterior descartada. A próxima mensagem começa uma conversa nova.",
    );
    log("session reset by command");
    return;
  }

  if (normalized === "/status") {
    const lines = [
      "*Status do orquestrador*",
      `Uptime: ${formatUptime(Date.now() - START_TIME)}`,
      `Diretório atual: \`${cwd}\``,
      `Sessão ativa: ${entry.sessionId ? `\`${entry.sessionId}\`` : "nenhuma (próxima mensagem cria uma nova)"}`,
    ];
    if (entry.sessionId) {
      lines.push(`Continuar no terminal: \`cd ${entry.sessionCwd || cwd} && claude -r ${entry.sessionId}\``);
    }
    await sendWhatsApp(chatTarget, markdownToWhatsApp(lines.join("\n")));
    log("status requested");
    return;
  }

  const firstWord = raw.split(/\s+/)[0]?.toLowerCase();

  if (firstWord === "cd") {
    const arg = raw.slice(2).trim();
    const target = resolveCdTarget(cwd, arg);
    let ok = false;
    try {
      ok = fs.statSync(target).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      await sendWhatsApp(chatTarget, `\u26A0\uFE0F Diretório não existe: \`${target}\``);
      return;
    }
    state[ALLOWED_NUMBER] = { ...entry, cwd: target };
    saveState(state);
    await sendWhatsApp(chatTarget, `\uD83D\uDCC2 \`${target}\``);
    log("cd ->", target);
    return;
  }

  if (SHELL_COMMANDS.has(firstWord)) {
    try {
      const { code, output } = await runShellCommand(raw, cwd);
      const body = output || "(sem saída)";
      const status = code === 0 ? "" : `\n\n_(saiu com código ${code})_`;
      await sendWhatsApp(
        chatTarget,
        markdownToWhatsApp(`\`\`\`\n${truncate(body)}\n\`\`\`${status}`),
      );
      log("shell command ran, code=", code);
    } catch (err) {
      await sendWhatsApp(chatTarget, `\u26A0\uFE0F ${err.message}`);
      log("ERROR running shell command:", err.message);
    }
    return;
  }

  try {
    const media = saveIncomingMedia(payload);
    let attachment = "";
    let transcript = "";
    if (media?.type === "audio") {
      transcript = await transcribeAudio(media.path);
      if (!transcript) {
        await sendWhatsApp(chatTarget, "⚠️ Não consegui transcrever esse áudio.");
        return;
      }
    } else if (media) {
      attachment = `\n\n[${media.type || "arquivo"} anexado a esta mensagem: ${media.path} — abra com a ferramenta Read]`;
    }
    const body = [raw, transcript].filter(Boolean).join("\n\n") || (media ? "(sem legenda — veja o anexo)" : "");
    const scopedMessage = `[contexto: diretório de trabalho atual é ${cwd} — fique restrito a esse diretório e seus subdiretórios, a menos que eu peça algo fora dele explicitamente]\n\n${body}${attachment}`;

    const { sessionId, text } = await runClaude({
      message: scopedMessage,
      sessionId: entry.sessionId,
      sessionCwd: entry.sessionCwd,
      cwd,
    });

    const sessionCwd = entry.sessionId && entry.sessionCwd ? entry.sessionCwd : cwd;
    state[ALLOWED_NUMBER] = { ...entry, sessionId, sessionCwd, updatedAt: new Date().toISOString() };
    saveState(state);

    await sendWhatsApp(chatTarget, markdownToWhatsApp(text));
    log("replied, session=", sessionId);
  } catch (err) {
    log("ERROR running claude:", err.message);
    await sendWhatsApp(
      chatTarget,
      markdownToWhatsApp(`\u26A0\uFE0F Erro processando sua mensagem: ${err.message}`),
    );
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      log("ERROR: invalid webhook JSON");
      return;
    }

    enqueue(() => handleIncomingMessage(payload)).catch((err) => {
      log("ERROR in handleIncomingMessage:", err.message);
    });
  });
});

server.listen(ORCH_PORT, "127.0.0.1", () => {
  log(`WhatsApp<->Claude Code orchestrator listening on 127.0.0.1:${ORCH_PORT}`);
  log(`Allowed number: ${ALLOWED_NUMBER}`);
  log(`Claude cwd: ${CLAUDE_CWD} (permission mode: ${CLAUDE_PERMISSION_MODE})`);
});
