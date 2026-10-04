import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DEFAULT_ANTHROPIC_MODEL,
  anthropicRequestBody,
  claudeCliArgs,
  codexCliArgs,
  parseJsonAnswer,
  runLlmText,
  selectLlmBackend,
} from "../lib/llm.mjs";

const has = (...names) => (name) => names.includes(name);

test("an API key wins over installed CLIs", () => {
  assert.equal(selectLlmBackend({ env: { ANTHROPIC_API_KEY: "k" }, hasCommand: has("claude", "codex") }), "anthropic");
});

test("without a key the claude CLI is preferred, then codex", () => {
  assert.equal(selectLlmBackend({ env: {}, hasCommand: has("claude", "codex") }), "claude");
  assert.equal(selectLlmBackend({ env: {}, hasCommand: has("codex") }), "codex");
});

test("no backend at all is reported as null, not guessed", () => {
  assert.equal(selectLlmBackend({ env: {}, hasCommand: has() }), null);
});

test("a forced backend that is unavailable fails loudly", () => {
  assert.throws(() => selectLlmBackend({ env: { ARNONA_LLM: "codex" }, hasCommand: has("claude") }), /codex/);
  assert.throws(() => selectLlmBackend({ env: { ARNONA_LLM: "anthropic" }, hasCommand: has("claude") }), /ANTHROPIC_API_KEY/);
  assert.throws(() => selectLlmBackend({ env: { ARNONA_LLM: "gpt" }, hasCommand: has() }), /must be one of/);
  assert.equal(selectLlmBackend({ env: { ARNONA_LLM: "codex" }, hasCommand: has("claude", "codex") }), "codex");
});

test("runLlmText without any backend explains how to configure one", async () => {
  await assert.rejects(
    runLlmText({ system: "s", prompt: "p", env: {}, hasCommand: () => false }),
    /No LLM backend available.*ANTHROPIC_API_KEY/,
  );
});

test("the extraction request uses structured outputs and the default model", () => {
  const schema = { type: "object" };
  const body = anthropicRequestBody({
    system: "s", prompt: "p", maxTokens: 100, schema, web: false, model: DEFAULT_ANTHROPIC_MODEL,
  });
  assert.equal(body.model, "claude-opus-5-5");
  assert.deepEqual(body.output_config.format, { type: "json_schema", schema });
  assert.equal(body.tools, undefined);
});

test("the research request gets web tools and free text", () => {
  const body = anthropicRequestBody({ system: "s", prompt: "p", maxTokens: 100, schema: null, web: true, model: "m" });
  assert.deepEqual(body.tools.map((tool) => tool.name), ["web_search", "web_fetch"]);
  assert.equal(body.output_config.format, undefined);
});

test("the API backend returns concatenated text and honors ARNONA_MODEL", async () => {
  let sent = null;
  const result = await runLlmText({
    system: "s", prompt: "p", backend: "anthropic",
    env: { ANTHROPIC_API_KEY: "key", ARNONA_MODEL: "claude-test" },
    fetchImpl: async (url, init) => {
      sent = { url, init, body: JSON.parse(init.body) };
      return {
        ok: true, status: 200,
        json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: '{"rows":[]}' }], usage: { input_tokens: 1, output_tokens: 2 } }),
      };
    },
  });
  assert.equal(result.text, '{"rows":[]}');
  assert.equal(sent.body.model, "claude-test");
  assert.equal(sent.init.headers["x-api-key"], "key");
  assert.equal(sent.init.headers["anthropic-version"], "2023-06-01");
});

test("an API refusal or truncation is an error, never partial data", async () => {
  for (const stop of ["refusal", "max_tokens"]) {
    await assert.rejects(runLlmText({
      system: "s", prompt: "p", backend: "anthropic", env: { ANTHROPIC_API_KEY: "k" },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: stop, content: [{ type: "text", text: "{" }] }) }),
    }));
  }
});

test("API errors surface their status", async () => {
  await assert.rejects(runLlmText({
    system: "s", prompt: "p", backend: "anthropic", env: { ANTHROPIC_API_KEY: "k" },
    fetchImpl: async () => ({ ok: false, status: 529, json: async () => ({ error: { message: "overloaded" } }) }),
  }), /529.*overloaded/);
});

test("claude CLI extraction runs with no tools; research may only search and fetch", () => {
  const extract = claudeCliArgs({ system: "s", web: false, env: {} });
  assert.deepEqual(extract.slice(extract.indexOf("--tools"), extract.indexOf("--tools") + 2), ["--tools", ""]);
  const research = claudeCliArgs({ system: "s", web: true, env: { ARNONA_CLAUDE_MODEL: "opus" } });
  assert.ok(research.includes("WebSearch,WebFetch"));
  assert.deepEqual(research.slice(-2), ["--model", "opus"]);
});

test("codex runs read-only, reads the prompt from stdin and searches only for research", () => {
  const extract = codexCliArgs({ web: false, outputFile: "/tmp/x", env: {} });
  assert.equal(extract[0], "exec");
  assert.ok(extract.includes("read-only"));
  assert.equal(extract.at(-1), "-");
  assert.equal(codexCliArgs({ web: true, outputFile: "/tmp/x", env: {} })[0], "--search");
});

test("the claude CLI never inherits an API key", async () => {
  let seenEnv = null;
  const spawnImpl = (command, args, options) => {
    seenEnv = options.env;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => setImmediate(() => { child.stdout.emit("data", "ok"); child.emit("close", 0); }) };
    child.kill = () => {};
    return child;
  };
  const result = await runLlmText({
    system: "s", prompt: "p", backend: "claude", env: { ANTHROPIC_API_KEY: "k", PATH: "/bin" }, spawnImpl,
  });
  assert.equal(result.text, "ok");
  assert.equal(seenEnv.ANTHROPIC_API_KEY, undefined);
});

test("JSON answers are read through fences and prose", () => {
  assert.deepEqual(parseJsonAnswer('```json\n{"rows":[]}\n```'), { rows: [] });
  assert.deepEqual(parseJsonAnswer('Here you go: {"doc_year":2026,"rows":[]} done'), { doc_year: 2026, rows: [] });
  assert.throws(() => parseJsonAnswer("no json here"));
});

test("scanned pages: each backend receives the page images and nothing more", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "arnona-img-"));
  const image = join(dir, "page-001.png");
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const claude = claudeCliArgs({ system: "s", web: false, images: [image], env: {} });
  assert.deepEqual(claude.slice(claude.indexOf("--tools"), claude.indexOf("--tools") + 2), ["--tools", "Read"]);
  assert.ok(claude.includes("--add-dir") && claude.includes(dir));
  assert.ok(!claude.includes("WebSearch,WebFetch"));

  const codex = codexCliArgs({ web: false, outputFile: "/tmp/x", images: [image], env: {} });
  assert.deepEqual(codex.slice(-3), ["-i", image, "-"]);

  const body = anthropicRequestBody({
    system: "s", prompt: "p", maxTokens: 100, schema: null, web: false, model: "m", images: [image],
  });
  const [img, text] = body.messages[0].content;
  assert.equal(img.type, "image");
  assert.equal(img.source.media_type, "image/png");
  assert.equal(img.source.data, Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  assert.deepEqual(text, { type: "text", text: "p" });
});

test("text-only extraction still gets no tools at all", () => {
  const args = claudeCliArgs({ system: "s", web: false, env: {} });
  assert.equal(args[args.indexOf("--tools") + 1], "");
});
