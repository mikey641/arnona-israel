// Pluggable LLM runner. The scraper needs exactly two things from a model:
//   1. text-in / JSON-out tariff extraction (no tools), and
//   2. optionally, a live web search for the municipal order (the last-resort
//      discovery rung in arnona-research.mjs).
//
// Backends, in automatic order of preference:
//   anthropic  ANTHROPIC_API_KEY is set → Anthropic Messages API over fetch.
//              Model: ARNONA_MODEL (default claude-opus-5-5).
//   claude     the Claude Code CLI (`claude -p`) is on PATH and logged in.
//   codex      the OpenAI Codex CLI (`codex exec`) is on PATH and logged in.
// Force one with ARNONA_LLM=anthropic|claude|codex. Model overrides for the CLIs:
// ARNONA_CLAUDE_MODEL, ARNONA_CODEX_MODEL.
//
// A municipal tax order is a legal/financial source: use the strongest model you
// have. Deterministic validation runs afterwards regardless of the backend.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const BACKENDS = ["anthropic", "claude", "codex"];

export function commandOnPath(command, { spawnSyncImpl = spawnSync } = {}) {
  const probe = process.platform === "win32"
    ? spawnSyncImpl("where", [command], { encoding: "utf8" })
    : spawnSyncImpl("sh", ["-c", `command -v ${command}`], { encoding: "utf8" });
  return probe.status === 0 && Boolean(String(probe.stdout ?? "").trim());
}

/**
 * Decide which backend to use. Returns the backend name, or null when none is
 * available. A forced ARNONA_LLM is honored only when it is actually usable, so
 * a typo or a missing CLI fails loudly instead of silently switching providers.
 */
export function selectLlmBackend({ env = process.env, hasCommand = commandOnPath } = {}) {
  const forced = String(env.ARNONA_LLM ?? "").trim().toLowerCase();
  const usable = (name) => (name === "anthropic" ? Boolean(env.ANTHROPIC_API_KEY) : hasCommand(name));
  if (forced) {
    if (!BACKENDS.includes(forced)) {
      throw new Error(`ARNONA_LLM must be one of ${BACKENDS.join(", ")} (got "${forced}")`);
    }
    if (!usable(forced)) {
      throw new Error(forced === "anthropic"
        ? "ARNONA_LLM=anthropic requires ANTHROPIC_API_KEY"
        : `ARNONA_LLM=${forced} but the \`${forced}\` CLI is not on PATH`);
    }
    return forced;
  }
  return BACKENDS.find(usable) ?? null;
}

export const NO_LLM_MESSAGE = "No LLM backend available. Set ANTHROPIC_API_KEY (Anthropic API), "
  + "or install and log in to the `claude` CLI (Claude Code) or the `codex` CLI. "
  + "See scraper/README.md → Requirements.";

/** Strip a ```json fence and parse the first JSON object in a model answer. */
export function parseJsonAnswer(text) {
  const body = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(body); } catch { /* fall through to the widest object span */ }
  const match = body.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("model answer contained no JSON object");
  return JSON.parse(match[0]);
}

// ── anthropic (fetch) ────────────────────────────────────────────────────────

/** User content: the prompt, preceded by any page images (scanned orders). */
export function anthropicUserContent(prompt, images = []) {
  if (!images.length) return prompt;
  return [
    ...images.map((file) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: /\.png$/i.test(file) ? "image/png" : "image/jpeg",
        data: readFileSync(file).toString("base64"),
      },
    })),
    { type: "text", text: prompt },
  ];
}

export function anthropicRequestBody({ system, prompt, maxTokens, schema, web, model, images = [] }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: anthropicUserContent(prompt, images) }],
    output_config: { effort: "high" },
  };
  // Structured outputs constrain the answer to the extraction schema. The web
  // research step keeps free text (it parses a JSON object out of the answer).
  if (schema && !web) body.output_config.format = { type: "json_schema", schema };
  if (web) {
    body.tools = [
      { type: "web_search_20260209", name: "web_search", max_uses: 8 },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 },
    ];
  }
  return body;
}

async function runAnthropic({ system, prompt, maxTokens, schema, web, images, env, fetchImpl, timeoutMs }) {
  const model = env.ARNONA_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const messages = [{ role: "user", content: anthropicUserContent(prompt, images) }];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    // A server-tool turn can pause (stop_reason "pause_turn"); resume it a few times.
    for (let turn = 0; turn < 5; turn++) {
      const body = { ...anthropicRequestBody({ system, prompt, maxTokens, schema, web, model, images }), messages };
      const res = await fetchImpl(ANTHROPIC_URL, {
        method: "POST",
        signal: ctl.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        const message = payload?.error?.message ?? `HTTP ${res.status}`;
        throw new Error(`Anthropic API ${res.status}: ${message}`);
      }
      if (payload?.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: payload.content });
        continue;
      }
      if (payload?.stop_reason === "refusal") {
        throw new Error(`Anthropic API refused (${payload?.stop_details?.category ?? "unknown"})`);
      }
      if (payload?.stop_reason === "max_tokens") {
        throw new Error("Anthropic API answer truncated at max_tokens");
      }
      const text = (payload?.content ?? []).filter((block) => block.type === "text")
        .map((block) => block.text).join("").trim();
      if (!text) throw new Error("Anthropic API returned empty text");
      return { text, usage: payload.usage ?? null, backend: "anthropic", model };
    }
    throw new Error("Anthropic API kept pausing; giving up");
  } finally {
    clearTimeout(timer);
  }
}

// ── CLIs ─────────────────────────────────────────────────────────────────────

function runProcess(command, args, { input, env, timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${command} exited ${code}: ${(err || out).trim().slice(-300)}`));
    });
    child.stdin.end(input);
  });
}

export function claudeCliArgs({ system, web, images = [], env = process.env }) {
  const args = ["-p", "--output-format", "text", "--system-prompt", system];
  // Extraction needs no tools at all; research may only search and fetch; reading a
  // scanned order may only open its own page images.
  if (web) args.push("--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch");
  else if (images.length) {
    args.push("--tools", "Read", "--allowedTools", "Read");
    for (const dir of new Set(images.map((file) => dirname(file)))) args.push("--add-dir", dir);
  } else args.push("--tools", "");
  if (env.ARNONA_CLAUDE_MODEL) args.push("--model", env.ARNONA_CLAUDE_MODEL);
  return args;
}

async function runClaudeCli({ system, prompt, web, images = [], env, timeoutMs, spawnImpl }) {
  // With ANTHROPIC_API_KEY in the environment the CLI switches to API auth and
  // disables its web tools; the CLI path is meant to use its own login.
  const cliEnv = { ...env };
  delete cliEnv.ANTHROPIC_API_KEY;
  delete cliEnv.ANTHROPIC_AUTH_TOKEN;
  const input = images.length
    ? `Read these page images of the order first, in this order:\n${images.join("\n")}\n\n${prompt}`
    : prompt;
  const text = await runProcess("claude", claudeCliArgs({ system, web, images, env }), {
    input, env: cliEnv, timeoutMs, spawnImpl,
  });
  if (!text.trim()) throw new Error("claude CLI returned empty text");
  return { text: text.trim(), usage: null, backend: "claude", model: env.ARNONA_CLAUDE_MODEL ?? null };
}

export function codexCliArgs({ web, outputFile, images = [], env = process.env }) {
  const args = [];
  if (web) args.push("--search");
  args.push("exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only", "-o", outputFile);
  if (env.ARNONA_CODEX_MODEL) args.push("-m", env.ARNONA_CODEX_MODEL);
  for (const image of images) args.push("-i", image);
  args.push("-");
  return args;
}

async function runCodexCli({ system, prompt, web, images = [], env, timeoutMs, spawnImpl }) {
  const work = mkdtempSync(join(tmpdir(), "arnona-codex-"));
  const outputFile = join(work, "answer.txt");
  try {
    await runProcess("codex", codexCliArgs({ web, outputFile, images, env }), {
      input: `${system}\n\n---\n\n${prompt}`, env, timeoutMs, spawnImpl,
    });
    const text = readFileSync(outputFile, "utf8").trim();
    if (!text) throw new Error("codex CLI returned empty text");
    return { text, usage: null, backend: "codex", model: env.ARNONA_CODEX_MODEL ?? null };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Run one text task and return `{ text, usage, backend, model }`.
 * @param {object} task
 * @param {string} task.system
 * @param {string} task.prompt
 * @param {number} [task.maxTokens]
 * @param {object} [task.schema]  JSON schema for the answer (enforced on the API backend)
 * @param {boolean} [task.web]    allow live web search/fetch tools
 * @param {string[]} [task.images] page image files to read (scanned documents)
 */
export async function runLlmText({
  system,
  prompt,
  maxTokens = 24_000,
  schema = null,
  web = false,
  images = [],
  env = process.env,
  timeoutMs = 10 * 60_000,
  backend = null,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  hasCommand = commandOnPath,
} = {}) {
  const chosen = backend ?? selectLlmBackend({ env, hasCommand });
  if (!chosen) throw new Error(NO_LLM_MESSAGE);
  const task = { system, prompt, maxTokens, schema, web, images, env, timeoutMs, fetchImpl, spawnImpl };
  if (chosen === "anthropic") return runAnthropic(task);
  if (chosen === "claude") return runClaudeCli(task);
  if (chosen === "codex") return runCodexCli(task);
  throw new Error(`unknown LLM backend: ${chosen}`);
}
