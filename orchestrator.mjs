#!/usr/bin/env node
// WhatsApp -> OpenCode orchestrator
//
// Receives incoming-message webhooks from the whatsapp-mcp bridge and routes
// them into `opencode run --session <id>`, replying back over WhatsApp with
// the answer plus the session id so the user can resume from any machine
// with: opencode -s "<session id>"
//
// Only messages from ALLOWED_NUMBER are processed. Everything else is
// ignored (no replies are ever sent to any other contact).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

// Minimal .env loader (no dependency): KEY=VALUE lines, '#' comments, blank
// lines ignored. Never overrides a variable already set in the real
// environment (systemd Environment=, shell export, etc take precedence).
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

// The only WhatsApp number this bot will ever process messages from or
// reply to. REQUIRED — there is no sane default, and the process refuses to
// start without it so a misconfiguration can never accidentally reply to
// (or leak responses to) an unintended contact.
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
const OPENCODE_CWD = process.env.WA_OPENCODE_CWD || path.join(HOME, "Dev", "agnus");
const OPENCODE_BIN = process.env.WA_OPENCODE_BIN || "opencode";
// Attach to a warm `opencode serve` instead of spawning a fresh process per
// message: a cold `opencode run` re-initializes every configured MCP server
// (n8n, cloudflare docs, whatsapp, etc.) which can take 1-2+ minutes. The
// warm server keeps that state loaded, cutting typical replies to ~10s.
const OPENCODE_SERVER_URL = process.env.WA_OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
// Shell used to run raw commands (see SHELL_COMMANDS below). Must be an
// interactive-capable login shell so aliases like `gco` (oh-my-zsh's
// `git checkout`) resolve — plain `sh -c` / non-interactive shells don't
// load rc files and won't know about them.
const USER_SHELL = process.env.WA_SHELL || "zsh";
// An exploratory question over a big repo ("como está esse projeto?") can easily
// run 5-10min of tool calls before the model writes a word. 5min killed those
// mid-flight and, because replies are queued serially, blocked every message
// behind it too.
const OPENCODE_TIMEOUT_MS = Number(process.env.WA_OPENCODE_TIMEOUT_MS) || 15 * 60 * 1000;
// Voice note transcription (optional — without a key, audio is just ignored).
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const TRANSCRIPTION_MODEL = process.env.WA_TRANSCRIPTION_MODEL || "google/gemini-2.5-flash";
const START_TIME = Date.now();

// The web UI routes a session under the base64url-encoded server URL it lives on.
function sessionWebUrl(sessionId) {
  const server = Buffer.from(OPENCODE_SERVER_URL).toString("base64url");
  return `${OPENCODE_SERVER_URL}/server/${server}/session/${sessionId}`;
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // best effort
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

// WhatsApp does not render GitHub-flavored markdown. It has its own minimal
// formatting: *bold* (single asterisk), _italic_, ~strikethrough~, and
// ```code```. Convert the common markdown opencode produces into that, and
// strip constructs WhatsApp has no equivalent for (tables, headers, links).
function markdownToWhatsApp(text) {
  let out = text;

  // Fenced code blocks: protect their contents from the rest of the pass by
  // extracting them first, then splicing them back in untouched at the end.
  const codeBlocks = [];
  out = out.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // Bold: **text** or __text__ -> *text*
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");

  // Italic markdown (single _text_) already matches WhatsApp; leave as-is.

  // Headers: "# Title" / "## Title" -> "*Title*"
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Markdown links [label](url) -> "label (url)"
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");

  // Tables: WhatsApp has no table rendering. Drop the "|---|---|" separator
  // rows and turn remaining "| a | b |" rows into "a: b" / "a - b" lines.
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

  // Bullet markers "- " / "* " at line start -> "• " (avoids stray literal
  // "*" being misread as bold-open by WhatsApp's own renderer).
  out = out.replace(/^(\s*)[-*]\s+/gm, "$1\u2022 ");

  // Restore protected code blocks.
  out = out.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_, i) => codeBlocks[Number(i)]);

  return out.trim();
}

// First-word allowlist: messages whose first token matches one of these are
// treated as literal shell commands (run directly, no LLM involved) instead
// of an OpenCode prompt. Covers navigation, inspection, and common git/
// oh-my-zsh git-plugin aliases. Extend via WA_SHELL_COMMANDS (comma
// separated) if you use others.
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

const MAX_REPLY_CHARS = 3500; // stay well under WhatsApp's own message cap

function truncate(text) {
  if (text.length <= MAX_REPLY_CHARS) return text;
  return `${text.slice(0, MAX_REPLY_CHARS)}\n… (cortado, ${text.length} chars no total)`;
}

// Resolve a `cd` argument against the tracked current directory. Mirrors
// plain shell semantics for the cases that matter here: no arg / "~" -> HOME,
// "~/x" -> HOME/x, relative paths resolved against currentCwd, absolute
// paths used as-is. "cd -" (previous dir) is intentionally not supported.
function resolveCdTarget(currentCwd, arg) {
  if (!arg || arg === "~") return HOME;
  let target = arg;
  if (target.startsWith("~/")) target = path.join(HOME, target.slice(2));
  if (!path.isAbsolute(target)) target = path.resolve(currentCwd, target);
  return path.normalize(target);
}

// `eza` (this box's `ls`/`ll`/`la`/`lt`/`tree` alias target, see .zshrc) has
// a quirk where invoking it with zero positional args prints nothing at all
// — `eza` alone is silent, but `eza .` lists the directory fine. Give it an
// explicit "." when the user typed a bare listing command with only flags
// (no path argument), so passthrough `ls` actually returns something.
const EZA_ALIASED_COMMANDS = new Set(["ls", "ll", "la", "lt", "tree"]);
function withExplicitPathIfNeeded(command) {
  const tokens = command.trim().split(/\s+/);
  const [first, ...rest] = tokens;
  if (!EZA_ALIASED_COMMANDS.has(first.toLowerCase())) return command;
  const hasPathArg = rest.some((t) => !t.startsWith("-"));
  return hasPathArg ? command : `${command} .`;
}

// Strip ANSI/SGR escape codes (colors, bold, etc) from command output —
// WhatsApp renders them as literal garbage characters, it has no terminal.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\u001b\[[0-9;]*[a-zA-Z]/g;
function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function runShellCommand(rawCommand, cwd) {
  const command = withExplicitPathIfNeeded(rawCommand);
  return new Promise((resolve, reject) => {
    const child = spawn(USER_SHELL, ["-ic", command], {
      cwd,
      // NO_COLOR / TERM=dumb: best-effort hint to well-behaved CLIs (git,
      // eza, ripgrep, ...) to skip ANSI color codes entirely. stripAnsi()
      // below is the hard guarantee for anything that ignores the hint.
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

async function checkOpencodeServerHealth() {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${OPENCODE_SERVER_URL}/doc`, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
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

// Serialize all opencode invocations. Running two `opencode run --attach`
// calls concurrently against the same warm server has been observed to
// deadlock both requests indefinitely (never completing, no error). One
// message is processed fully before the next one starts.
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

// Voice notes: no LLM here takes WhatsApp's opus/ogg directly, so transcode to
// mp3 (ffmpeg) and let a multimodal model on OpenRouter do the transcription.
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

    // One retry: a cold connection here has already failed once with a bare
    // "fetch failed", and losing a voice note to a network hiccup is silly.
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
    // fetch() hides the real network/TLS error in .cause
    log("ERROR transcribing audio:", err.message, "| cause:", err.cause?.message || "-");
    return "";
  } finally {
    fs.rmSync(mp3, { force: true });
  }
}

// The bridge inlines an attachment as base64. Models can't be handed base64,
// but opencode's `read` tool handles image files, so drop it on disk and point
// the prompt at the path.
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

// Last resort when the CLI stream ended without the closing text: read the
// answer straight off the session. The final part can land a moment after the
// client exits, so retry briefly before giving up.
async function fetchLastAssistantText(sessionId, attempts = 5) {
  if (!sessionId) return "";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`${OPENCODE_SERVER_URL}/session/${sessionId}/message`);
      if (res.ok) {
        const messages = await res.json();
        const last = [...messages].reverse().find((m) => m.info?.role === "assistant");
        const text = (last?.parts || [])
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (text) {
          log("recovered text from session", sessionId, "after", i + 1, "try(ies)");
          return text;
        }
      }
    } catch (err) {
      log("ERROR fetching session messages:", err.message);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return "";
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
  return body; // { success, message, message_id }
}

// "Delete for everyone" the given message. WhatsApp only allows revoking
// messages the sending account itself sent — this can only ever remove the
// bot's own replies, never anything the human side of the chat sent from
// their phone. That's a WhatsApp protocol limitation, not something this
// bridge can work around.
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

function runOpencode({ message, sessionId, cwd }) {
  return new Promise((resolve, reject) => {
    // --auto is required here: headless mode has no TTY to approve tool
    // permission prompts (bash, file edits, etc). Without it, any tool call
    // hangs forever waiting for an approval that can never arrive.
    // --attach reuses the warm opencode-server.service instead of paying
    // full MCP-server cold-start cost on every single message.
    const args = [
      "run",
      message,
      "--format",
      "json",
      "--auto",
      "--attach",
      OPENCODE_SERVER_URL,
      "--dir",
      cwd,
    ];
    if (sessionId) {
      args.push("--session", sessionId);
    }

    log("spawning:", OPENCODE_BIN, JSON.stringify(args), "cwd=", cwd);

    const child = spawn(OPENCODE_BIN, args, {
      cwd,
      env: process.env,
      // stdin MUST be closed/ignored: opencode run reads stdin (to support
      // piped input) and hangs forever waiting for EOF if left as an open,
      // unwritten pipe (child_process's default). This was the root cause
      // of every message getting stuck indefinitely with no error.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const err = new Error(
        `a resposta demorou demais (>${Math.round(OPENCODE_TIMEOUT_MS / 60000)}min). Descartei essa sessão — a próxima mensagem começa uma nova.`,
      );
      err.timedOut = true;
      reject(err);
    }, OPENCODE_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`opencode exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }

      let newSessionId = sessionId || null;
      const textParts = [];
      const toolNames = [];

      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (evt.sessionID) newSessionId = evt.sessionID;
        if (evt.type === "text" && evt.part && typeof evt.part.text === "string") {
          textParts.push(evt.part.text);
        }
        if (evt.part && evt.part.type === "tool" && evt.part.tool) {
          toolNames.push(evt.part.tool);
        }
      }

      // `opencode run --attach` sometimes ends its stream one step early,
      // right before the closing text part — the answer *is* in the session
      // on the server, it just never reached stdout. Ask the server for it
      // instead of claiming the model went quiet.
      const streamed = textParts.join("\n").trim();
      const finish = async () => {
        let text = streamed || (await fetchLastAssistantText(newSessionId));
        if (!text) {
          // A turn that genuinely only ran tools (e.g. "check the logs")
          // without writing any closing summary.
          text = toolNames.length
            ? `\u{1F527} Rodei ${toolNames.length} chamada(s) de ferramenta (${[...new Set(toolNames)].join(", ")}) mas o modelo não deixou um resumo em texto. Pergunta de novo pedindo um resumo, ou manda /novo se achar que travou.`
            : "(sem resposta em texto — tente reformular a pergunta)";
        }
        return { sessionId: newSessionId, text };
      };
      finish().then(resolve, reject);
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
    return; // never process or reply to anyone else
  }
  if (payload.isFromMe) return;
  if (payload.eventType && payload.eventType !== "message") return;
  // A photo often arrives with no caption at all — that's still a message.
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
  const cwd = entry.cwd || OPENCODE_CWD;
  const chatTarget = payload.chatJID || senderNumber;
  const raw = (payload.content || "").trim();
  const normalized = raw.toLowerCase();
  log("incoming from", senderNumber, "->", JSON.stringify(payload.content).slice(0, 200));

  // Manual session reset. WhatsApp never tells us when you clear/delete a
  // chat locally on your phone (that's a device-local action, not synced to
  // linked devices), so the only reliable way to start fresh is this command.
  if (["/novo", "/new", "/reset", "/limpar", "/clear"].includes(normalized)) {
    // Reset the conversation but keep wherever `cd` last left you.
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
    const healthy = await checkOpencodeServerHealth();
    const lines = [
      "*Status do orquestrador*",
      `Uptime: ${formatUptime(Date.now() - START_TIME)}`,
      `Diretório atual: \`${cwd}\``,
      `Sessão ativa: ${entry.sessionId ? `\`${entry.sessionId}\`` : "nenhuma (próxima mensagem cria uma nova)"}`,
      `Servidor opencode (${OPENCODE_SERVER_URL}): ${healthy ? "\u2705 online" : "\u26A0\uFE0F sem resposta"}`,
    ];
    if (entry.sessionId) {
      lines.push(`Abrir na web: ${sessionWebUrl(entry.sessionId)}`);
    }
    await sendWhatsApp(chatTarget, markdownToWhatsApp(lines.join("\n")));
    log("status requested");
    return;
  }

  // First-token dispatch: literal shell commands vs. an OpenCode prompt.
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
    // `--dir` only sets the *initial* working directory — it is not a
    // sandbox. The model's bash tool can `cd ..` or use absolute paths
    // freely, so a vague prompt like "esses repos" can easily make it wander
    // into sibling/parent directories. A short explicit reminder on every
    // turn keeps it scoped to what you actually `cd`'d into, without
    // pretending this is real filesystem isolation (it isn't).
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
      attachment = `\n\n[${media.type || "arquivo"} anexado a esta mensagem: ${media.path} — abra com a ferramenta read]`;
    }
    const body = [raw, transcript].filter(Boolean).join("\n\n") || (media ? "(sem legenda — veja o anexo)" : "");
    const scopedMessage = `[contexto: diretório de trabalho atual é ${cwd} — fique restrito a esse diretório e seus subdiretórios, a menos que eu peça algo fora dele explicitamente]\n\n${body}${attachment}`;

    const { sessionId, text } = await runOpencode({
      message: scopedMessage,
      sessionId: entry.sessionId,
      cwd,
    });

    state[ALLOWED_NUMBER] = { ...entry, sessionId, updatedAt: new Date().toISOString() };
    saveState(state);

    await sendWhatsApp(chatTarget, markdownToWhatsApp(text));
    log("replied, session=", sessionId);
  } catch (err) {
    log("ERROR running opencode:", err.message);
    // Killing the client on timeout does NOT stop the run on the warm server:
    // the session stays busy there, so every later message reusing that same
    // session id queues behind it and times out too. Drop the session so the
    // next message starts a fresh one instead of snowballing.
    if (err.timedOut && entry.sessionId) {
      state[ALLOWED_NUMBER] = { cwd, updatedAt: new Date().toISOString() };
      saveState(state);
      log("dropped stuck session", entry.sessionId);
    }
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
    // Always ack fast; the bridge fire-and-forgets this POST.
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
  log(`WhatsApp<->OpenCode orchestrator listening on 127.0.0.1:${ORCH_PORT}`);
  log(`Allowed number: ${ALLOWED_NUMBER}`);
  log(`OpenCode cwd: ${OPENCODE_CWD}`);
});
