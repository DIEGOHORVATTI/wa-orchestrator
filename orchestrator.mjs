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

function runOpencode({ message, sessionId }) {
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
      OPENCODE_CWD,
    ];
    if (sessionId) {
      args.push("--session", sessionId);
    }

    log("spawning:", OPENCODE_BIN, JSON.stringify(args), "cwd=", OPENCODE_CWD);

    const child = spawn(OPENCODE_BIN, args, {
      cwd: OPENCODE_CWD,
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
      reject(new Error("opencode run timed out after 15 minutes"));
    }, 15 * 60 * 1000);

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`opencode exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }

      let newSessionId = sessionId || null;
      const textParts = [];

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
      }

      resolve({
        sessionId: newSessionId,
        text: textParts.join("\n").trim() || "(sem resposta em texto)",
      });
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
  log("incoming from", senderNumber, "->", JSON.stringify(payload.content).slice(0, 200));

  // Manual session reset. WhatsApp never tells us when you clear/delete a
  // chat locally on your phone (that's a device-local action, not synced to
  // linked devices), so the only reliable way to start fresh is this command.
  const normalized = payload.content.trim().toLowerCase();
  if (["/novo", "/new", "/reset", "/limpar"].includes(normalized)) {
    delete state[ALLOWED_NUMBER];
    saveState(state);
    await sendWhatsApp(
      payload.chatJID || senderNumber,
      "\u{1F195} Sessão anterior descartada. A próxima mensagem começa uma conversa nova.",
    );
    log("session reset by command");
    return;
  }

  try {
    const { sessionId, text } = await runOpencode({
      message: payload.content,
      sessionId: entry.sessionId,
    });

    state[ALLOWED_NUMBER] = { sessionId, updatedAt: new Date().toISOString() };
    saveState(state);

    const footer = sessionId
      ? `\n\n\u{1F9F5} \`\`\`opencode --resume "${sessionId}"\`\`\``
      : "";
    await sendWhatsApp(payload.chatJID || senderNumber, markdownToWhatsApp(`${text}${footer}`));
    log("replied, session=", sessionId);
  } catch (err) {
    log("ERROR running opencode:", err.message);
    await sendWhatsApp(
      payload.chatJID || senderNumber,
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
