import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCaptionRequest, formatRelayedMessage, rankRelayCandidates, inputImagesToRelay, pickRelayModel, serverUp, sessionSeesImages } from "./vision-relay";

describe("formatRelayedMessage", () => {
  it("keeps the intro and adds a labeled description instead of image parts", () => {
    const text = formatRelayedMessage(
      "Acceptance failed.",
      ["C:\\\\app\\\\.pi\\\\shot.jpg"],
      "Login form, Submit button clipped.",
      "local-gpu/qwen-vl",
    );
    assert.match(text, /Acceptance failed/);
    assert.match(text, /Login form/);
    assert.match(text, /local-gpu\/qwen-vl/);
    assert.match(text, /described, not attached/);
    assert.match(text, /text-only/);
  });
});

function fakeCtx(opts: { session: { provider: string; id: string; image: boolean }; vision: string[] }) {
  const available = opts.vision.map((spec) => {
    const slash = spec.indexOf("/");
    return {
      provider: spec.slice(0, slash),
      id: spec.slice(slash + 1),
      input: ["text", "image"] as ("text" | "image")[],
    };
  });
  return {
    model: {
      provider: opts.session.provider,
      id: opts.session.id,
      input: opts.session.image ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
    },
    modelRegistry: {
      getAvailable: () => available,
      find: (provider: string, id: string) => available.find((m) => m.provider === provider && m.id === id) ?? null,
      hasConfiguredAuth: () => true,
    },
  } as never;
}

describe("sessionSeesImages", () => {
  it("is true when the session model lists image", () => {
    const ctx = fakeCtx({ session: { provider: "local", id: "vl", image: true }, vision: ["local/vl"] });
    assert.equal(sessionSeesImages(ctx), true);
  });

  it("is false for text-only session models", () => {
    const ctx = fakeCtx({ session: { provider: "local", id: "coder", image: false }, vision: ["local/vl"] });
    assert.equal(sessionSeesImages(ctx), false);
  });
});

describe("pickRelayModel", () => {
  it("uses the configured spec when set", async () => {
    const ctx = fakeCtx({
      session: { provider: "local", id: "coder", image: false },
      vision: ["local/vl", "cloud/opus"],
    });
    const picked = await pickRelayModel(ctx, "cloud/opus");
    assert.equal(picked.model?.id, "opus");
  });

  it("skips the session model when auto-picking", async () => {
    const ctx = fakeCtx({
      session: { provider: "local", id: "vl", image: true },
      vision: ["local/vl", "local/other-vl"],
    });
    const picked = await pickRelayModel(ctx, "");
    assert.equal(picked.model?.id, "other-vl");
  });

  it("fails when no vision model has auth", async () => {
    const ctx = fakeCtx({
      session: { provider: "local", id: "coder", image: false },
      vision: [],
    });
    const picked = await pickRelayModel(ctx, "");
    assert.equal(picked.model, null);
    assert.match(picked.reason ?? "", /no vision-capable/);
  });
});

describe("pickRelayModel with servers down", () => {
  const ctx = () =>
    fakeCtx({ session: { provider: "lab", id: "1bit", image: false }, vision: ["gpu-a/qwen-vl", "gpu-b/bonsai-vl"] });
  const downIs = (...ids: string[]) => async (m: { id: string }) => !ids.includes(m.id);

  it("skips a vision model whose server is not answering and takes the next", async () => {
    const picked = await pickRelayModel(ctx(), "", downIs("qwen-vl"));
    assert.equal(picked.model?.id, "bonsai-vl");
    assert.deepEqual(picked.down, ["gpu-a/qwen-vl"]);
  });

  it("says which servers are down when none answers", async () => {
    const picked = await pickRelayModel(ctx(), "", downIs("qwen-vl", "bonsai-vl"));
    assert.equal(picked.model, null);
    assert.match(picked.reason ?? "", /no vision model is answering \(gpu-a\/qwen-vl, gpu-b\/bonsai-vl not reachable\)/);
  });

  it("never swaps a configured relay for another one when it is down", async () => {
    const picked = await pickRelayModel(ctx(), "gpu-a/qwen-vl", downIs("qwen-vl"));
    assert.equal(picked.model, null);
    assert.match(picked.reason ?? "", /set, but its server is not answering/);
  });
});

describe("serverUp", () => {
  it("does not probe a model with no real address", async () => {
    assert.equal(await serverUp("http://localhost:0"), true);
    assert.equal(await serverUp(undefined), true);
  });

  it("is false when nothing listens", async () => {
    assert.equal(await serverUp("http://127.0.0.1:9/v1"), false);
  });
});

describe("inputImagesToRelay", () => {
  it("keeps valid image parts", () => {
    const out = inputImagesToRelay([
      { type: "image", mimeType: "image/png", data: "aaa" },
      { type: "text", text: "nope" },
      { type: "image", mimeType: "image/jpeg", data: "" },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.mimeType, "image/png");
  });

  it("returns empty for missing images", () => {
    assert.deepEqual(inputImagesToRelay(undefined), []);
    assert.deepEqual(inputImagesToRelay([]), []);
  });
});

describe("buildCaptionRequest", () => {
  it("tells the captioner what the agent is checking and asks for a fixed format", () => {
    const text = buildCaptionRequest("Scenario history-tab: open History, the list shows 3 entries", 1);
    assert.match(text, /History, the list shows 3 entries/);
    assert.match(text, /^MATCHES:/m);
    assert.match(text, /^BLANK:/m);
  });

  it("clips long harness context but keeps its end", () => {
    const text = buildCaptionRequest(`${"log line\n".repeat(2000)}EXPECTED: settings screen`, 2);
    assert.ok(text.length < 3000);
    assert.match(text, /EXPECTED: settings screen/);
    assert.match(text, /Image 1, Image 2/);
  });
});

describe("rankRelayCandidates", () => {
  it("prefers the session provider and never picks the session model", () => {
    const ranked = rankRelayCandidates(
      ["cloud/vision-xl", "local-gpu/qwen-vl", "local-gpu/qwen-text"],
      "local-gpu",
      "local-gpu/qwen-text",
    );
    assert.deepEqual(ranked, ["local-gpu/qwen-vl", "cloud/vision-xl"]);
  });
});

