import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRelayedMessage, inputImagesToRelay, pickRelayModel, sessionSeesImages } from "./vision-relay";

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
  it("uses the configured spec when set", () => {
    const ctx = fakeCtx({
      session: { provider: "local", id: "coder", image: false },
      vision: ["local/vl", "cloud/opus"],
    });
    const picked = pickRelayModel(ctx, "cloud/opus");
    assert.equal(picked.model?.id, "opus");
  });

  it("skips the session model when auto-picking", () => {
    const ctx = fakeCtx({
      session: { provider: "local", id: "vl", image: true },
      vision: ["local/vl", "local/other-vl"],
    });
    const picked = pickRelayModel(ctx, "");
    assert.equal(picked.model?.id, "other-vl");
  });

  it("fails when no vision model has auth", () => {
    const ctx = fakeCtx({
      session: { provider: "local", id: "coder", image: false },
      vision: [],
    });
    const picked = pickRelayModel(ctx, "");
    assert.equal(picked.model, null);
    assert.match(picked.reason ?? "", /no vision-capable/);
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
