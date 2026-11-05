import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bareModelId, enrichServed, liveProviders, pickTemplate, resolveKey, toModelConfig } from "./index.ts";

const MODELS_JSON = {
  providers: {
    lab: {
      baseUrl: "http://lab.local:18000/v1/",
      api: "openai-completions",
      apiKey: "${LAB_KEY}",
      liveModels: true,
      compat: { maxTokensField: "max_tokens", supportsDeveloperRole: false },
      models: [
        { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: true, input: ["text", "image"], contextWindow: 524288, maxTokens: 131072, thinkingLevelMap: { high: "high" }, samplingParams: { temperature: 1 } },
        { id: "deepseek-v4.1-flash-abliterated", name: "DeepSeek Abliterated", reasoning: true, input: ["text"], contextWindow: 524288, maxTokens: 65536 },
        { id: "nex-n2.5-mini", name: "Nex mini", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 8192 },
      ],
    },
    openai: { baseUrl: "https://api.openai.com/v1", models: [] },
  },
};

describe("live models", () => {
  it("only providers that ask for it are live", () => {
    const ps = liveProviders(MODELS_JSON);
    assert.deepEqual(ps.map((p) => p.name), ["lab"]);
    assert.equal(ps[0]!.baseUrl, "http://lab.local:18000/v1", "trailing slash dropped");
    assert.deepEqual(liveProviders(null), []);
  });

  it("a served model takes its settings from the listed model it is a variant of", () => {
    const t = liveProviders(MODELS_JSON)[0]!.templates;
    assert.equal(pickTemplate("deepseek-v4.1-flash-1017-abliterated", t)?.id, "deepseek-v4.1-flash-abliterated");
    assert.equal(pickTemplate("deepseek-v4.1-flash", t)?.id, "deepseek-v4.1-flash", "exact wins");
    assert.equal(pickTemplate("nex-n2.5-mini-q4", t)?.id, "nex-n2.5-mini");
    assert.equal(pickTemplate("qwen4-coder-32b", t), undefined, "nothing alike: no template");
  });

  it("the server's context window and image support win; thinking and sampling come from the template", () => {
    const p = liveProviders(MODELS_JSON)[0]!;
    const m = toModelConfig({ id: "deepseek-v4.1-flash-0920", context_window: 262144, capabilities: ["text", "see"] }, p) as unknown as Record<string, unknown>;
    assert.equal(m.contextWindow, 262144);
    assert.deepEqual(m.input, ["text", "image"]);
    assert.equal(m.reasoning, true);
    assert.deepEqual(m.thinkingLevelMap, { high: "high" });
    assert.deepEqual(m.samplingParams, { temperature: 1 });
    assert.equal(m.maxTokens, 131072);
    assert.equal(m.name, "deepseek-v4.1-flash-0920", "a new id is shown as served");
    assert.deepEqual(m.compat, { maxTokensField: "max_tokens", supportsDeveloperRole: false }, "provider compat travels with the model");
    assert.equal(m.baseUrl, "http://lab.local:18000/v1");

    const unknown = toModelConfig({ id: "qwen4-coder-32b", max_model_len: 32768, capabilities: ["text"] }, p) as unknown as Record<string, unknown>;
    assert.equal(unknown.reasoning, false);
    assert.deepEqual(unknown.input, ["text"]);
    assert.equal(unknown.maxTokens, 8192, "a quarter of the context when nothing says otherwise");

    const exact = toModelConfig({ id: "nex-n2.5-mini" }, p) as unknown as Record<string, unknown>;
    assert.equal(exact.name, "Nex mini");
    assert.equal(exact.contextWindow, 65536, "no limits from the server: the template's");
  });

  it("a default model named with its provider is the same model", () => {
    assert.equal(bareModelId("local-gpu", "local-gpu/qwen3.6-27b"), "qwen3.6-27b");
    assert.equal(bareModelId("local-gpu", "qwen3.6-27b"), "qwen3.6-27b");
    assert.equal(bareModelId("lab", "org/model-7b"), "org/model-7b", "a slash that is part of the id stays");
  });

  it("keys use the models.json syntax", () => {
    const env = { LAB_KEY: "k1", OTHER: "k2" };
    assert.equal(resolveKey("${LAB_KEY}", env), "k1");
    assert.equal(resolveKey("$OTHER", env), "k2");
    assert.equal(resolveKey("literal-key", env), "literal-key");
    assert.equal(resolveKey("${MISSING}", env), undefined);
    assert.equal(resolveKey("a$$b", env), "a$b");
    assert.equal(resolveKey(undefined, env), undefined);
  });
});

describe("window and image support from each kind of server", () => {
  const provider = (baseUrl: string) => liveProviders({ providers: { s: { baseUrl, liveModels: true } } })[0]!;
  /** A fake server: path → JSON (anything else answers 404). */
  const server = (routes: Record<string, unknown>) => {
    const asked: string[] = [];
    const fetchFn = async (url: string) => {
      const path = new URL(url).pathname;
      asked.push(path);
      return path in routes ? new Response(JSON.stringify(routes[path]), { status: 200 }) : new Response("not found", { status: 404 });
    };
    return { fetchFn, asked };
  };
  const signal = new AbortController().signal;

  it("llama.cpp: the window one request gets, from /props, and image support (real llama-server answers)", async () => {
    // Captured from llama-server b1076 serving a 1M window with 4 slots.
    const listed = { id: "deepseek-v4.1-flash-1017-1bit", owned_by: "llamacpp", architecture: { input_modalities: ["text"] }, meta: { n_ctx: 1048576, n_ctx_train: 1048576 } };
    const { fetchFn } = server({ "/props": { default_generation_settings: { n_ctx: 262144 }, modalities: { vision: false } } });
    const [m] = await enrichServed(provider("http://gpu:8080/v1"), [listed], signal, fetchFn);
    const cfg = toModelConfig(m!, provider("http://gpu:8080/v1")) as unknown as Record<string, unknown>;
    assert.equal(cfg.contextWindow, 262144, "per slot, not the whole cache");
    assert.deepEqual(cfg.input, ["text"]);
  });

  it("llama.cpp without /props still has meta.n_ctx; a vision model is seen from input_modalities", () => {
    const cfg = toModelConfig({ id: "qwen-vl", meta: { n_ctx: 32768 }, architecture: { input_modalities: ["text", "image"] } }, provider("http://gpu:8080/v1")) as unknown as Record<string, unknown>;
    assert.equal(cfg.contextWindow, 32768);
    assert.deepEqual(cfg.input, ["text", "image"]);
  });

  it("LM Studio: the loaded context length and vlm type", async () => {
    const { fetchFn } = server({ "/api/v0/models": { data: [{ id: "qwen2.5-vl-7b", type: "vlm", state: "loaded", max_context_length: 128000, loaded_context_length: 16384 }] } });
    const [m] = await enrichServed(provider("http://localhost:1234/v1"), [{ id: "qwen2.5-vl-7b" }], signal, fetchFn);
    assert.equal(m!.context_window, 16384, "what is loaded, not the model's maximum");
    assert.deepEqual(m!.capabilities, ["text", "vision"]);
  });

  it("Ollama: the loaded model's context length and its capabilities; never the training length", async () => {
    const { fetchFn } = server({
      "/api/ps": { models: [{ name: "gemma3:12b", model: "gemma3:12b", context_length: 8192 }] },
      "/api/show": { capabilities: ["completion", "vision"], model_info: { "gemma3.context_length": 131072 } },
    });
    const [loaded, idle] = await enrichServed(provider("http://localhost:11434/v1"), [{ id: "gemma3:12b" }, { id: "llama3:8b" }], signal, fetchFn);
    assert.equal(loaded!.context_window, 8192);
    assert.deepEqual(loaded!.capabilities, ["text", "vision"]);
    assert.equal(idle!.context_window, undefined, "not loaded: left to the template");
  });

  it("a server that lists everything is not asked again", async () => {
    const { fetchFn, asked } = server({});
    await enrichServed(provider("http://lab:18000/v1"), [{ id: "m", context_window: 32768, capabilities: ["text"] }], signal, fetchFn);
    assert.deepEqual(asked, []);
  });
});
