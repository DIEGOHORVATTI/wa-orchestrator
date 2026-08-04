#!/usr/bin/env node
// WhatsApp -> OpenCode orchestrator
//
// Receives incoming-message webhooks from the whatsapp-mcp bridge and routes
// them into `opencode run --session <id>`, replying back over WhatsApp with
// the answer plus the session id so the user can resume from any machine
// with: opencode --resume "<session id>"
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
const START_TIME = Date.now();

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
      reject(
        new Error(
          "a resposta demorou demais (>5min) — a sessão pode ter travado. Manda /novo e tenta de novo.",
        ),
      );
    }, 5 * 60 * 1000);

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

      // The model can legitimately finish a turn having only called tools
      // (e.g. "check the logs") without emitting a closing text summary.
      // Surface *something* useful instead of a bare "no text" placeholder.
      let text = textParts.join("\n").trim();
      if (!text) {
        text = toolNames.length
          ? `\u{1F527} Rodei ${toolNames.length} chamada(s) de ferramenta (${[...new Set(toolNames)].join(", ")}) mas o modelo não deixou um resumo em texto. Pergunta de novo pedindo um resumo, ou manda /novo se achar que travou.`
          : "(sem resposta em texto — tente reformular a pergunta)";
      }

      resolve({ sessionId: newSessionId, text });
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
  if (!payload.content || !payload.content.trim()) return;

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
  const raw = payload.content.trim();
  const normalized = raw.toLowerCase();
  log("incoming from", senderNumber, "->", JSON.stringify(payload.content).slice(0, 200));

  // Manual session reset. WhatsApp never tells us when you clear/delete a
  // chat locally on your phone (that's a device-local action, not synced to
  // linked devices), so the only reliable way to start fresh is this command.
  if (["/novo", "/new", "/reset", "/limpar"].includes(normalized)) {
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
    const { sessionId, text } = await runOpencode({
      message: payload.content,
      sessionId: entry.sessionId,
      cwd,
    });

    state[ALLOWED_NUMBER] = { ...entry, sessionId, updatedAt: new Date().toISOString() };
    saveState(state);

    const footer = sessionId
      ? `\n\n\u{1F9F5} \`\`\`opencode --resume "${sessionId}"\`\`\``
      : "";
    await sendWhatsApp(chatTarget, markdownToWhatsApp(`${text}${footer}`));
    log("replied, session=", sessionId);
  } catch (err) {
    log("ERROR running opencode:", err.message);
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
