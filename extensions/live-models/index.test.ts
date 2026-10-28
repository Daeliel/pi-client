import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bareModelId, liveProviders, pickTemplate, resolveKey, toModelConfig } from "./index.ts";

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
