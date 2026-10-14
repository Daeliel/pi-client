import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractStopInfo,
  findGhostToolCall,
  hasStuckPhrase,
  isOutputTruncated,
  isThinkingLoop,
  repeatedLineCount,
  stuckPhraseRepeatCount,
  toolFingerprint,
} from "./detect";

describe("toolFingerprint", () => {
  it("is stable across key order", () => {
    const a = toolFingerprint("bash", { command: "ls", cwd: "/tmp" });
    const b = toolFingerprint("bash", { cwd: "/tmp", command: "ls" });
    assert.equal(a, b);
  });

  it("differs when args differ", () => {
    const a = toolFingerprint("grep", { pattern: "foo" });
    const b = toolFingerprint("grep", { pattern: "bar" });
    assert.notEqual(a, b);
  });
});

describe("isOutputTruncated", () => {
  it("detects stopReason length", () => {
    assert.equal(isOutputTruncated({ stopReason: "length" }), true);
  });

  it("detects error message about max output tokens", () => {
    assert.equal(
      isOutputTruncated({
        stopReason: "error",
        errorMessage:
          "Model stopped because it reached the maximum output token limit. The response may be incomplete.",
      }),
      true,
    );
  });

  it("ignores normal stop", () => {
    assert.equal(isOutputTruncated({ stopReason: "stop" }), false);
  });
});

describe("stuck phrases", () => {
  it("detects stuck-in-a-loop", () => {
    assert.equal(hasStuckPhrase("I'm stuck in a loop. Let me try again."), true);
  });

  it("counts repeats", () => {
    const text =
      "I'm stuck in a loop. ... I'm stuck in a loop. ... I'm stuck in a loop.";
    assert.equal(stuckPhraseRepeatCount(text), 3);
  });
});

describe("thinking loops", () => {
  const cycle = [
    "Let me try to use a different port for the server:",
    "Actually, let me just try to kill all node processes and restart the server:",
    "No wait, I already tried that and it didn't work. Let me try a different approach.",
  ].join("\n");

  it("counts repeated plan lines", () => {
    const text = `${cycle}\n\n${cycle}\n\n${cycle}`;
    assert.ok(repeatedLineCount(text) >= 3);
  });

  it("detects the port/kill-node reasoning cycle", () => {
    const text = `${cycle}\n\n${cycle}\n\n${cycle}`;
    assert.equal(isThinkingLoop(text, 3), true);
  });

  it("ignores normal short reasoning", () => {
    assert.equal(
      isThinkingLoop(
        "I should read the server file next.\nThen restart once.\n",
        3,
      ),
      false,
    );
  });
});

describe("extractStopInfo", () => {
  it("reads assistant stop fields", () => {
    const info = extractStopInfo({
      role: "assistant",
      stopReason: "length",
      errorMessage: "truncated",
    });
    assert.equal(info.stopReason, "length");
    assert.equal(info.errorMessage, "truncated");
  });
});

describe("findGhostToolCall", () => {
  const hermesThinking = {
    role: "assistant",
    stopReason: "stop",
    content: [
      {
        type: "thinking",
        thinking: `Let me check the server:\n\n<tool_call>\n<function=bash>\n<parameter=command>\ngrep -A10 "api/weight" server.mjs\n</parameter>\n</function>\n</tool_call>`,
      },
    ],
  };

  it("detects Hermes XML in thinking with no native toolCall", () => {
    const ghost = findGhostToolCall(hermesThinking);
    assert.ok(ghost);
    assert.equal(ghost.toolName, "bash");
  });

  it("ignores when a real toolCall block exists", () => {
    const msg = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        {
          type: "thinking",
          thinking: `<tool_call>\n<function=bash>\n</function>\n</tool_call>`,
        },
        {
          type: "toolCall",
          id: "1",
          name: "bash",
          arguments: { command: "ls" },
        },
      ],
    };
    assert.equal(findGhostToolCall(msg), null);
  });

  it("detects JSON-style tool_call name in text", () => {
    const msg = {
      role: "assistant",
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: `<tool_call>\n{"name": "read", "arguments": {"path": "a.ts"}}\n</tool_call>`,
        },
      ],
    };
    const ghost = findGhostToolCall(msg);
    assert.ok(ghost);
    assert.equal(ghost.toolName, "read");
  });

  it("ignores assistant text without tool_call tags", () => {
    assert.equal(
      findGhostToolCall({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "No tools here." }],
      }),
      null,
    );
  });

  it("detects <function_call> and [TOOL_CALLS] wrappers", () => {
    for (const text of [
      `<function_call>{"name": "bash", "arguments": {"command": "ls"}}</function_call>`,
      `[TOOL_CALLS] [{"name": "edit", "arguments": {"path": "a.ts"}}]`,
    ]) {
      const ghost = findGhostToolCall({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
      assert.ok(ghost, text);
    }
  });

  it("detects a bare JSON call only when it names a real tool", () => {
    const msg = {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: 'I will call {"name": "read", "arguments": {"path": "a.ts"}} now.' }],
    };
    assert.equal(findGhostToolCall(msg)?.toolName, undefined);
    assert.equal(findGhostToolCall(msg, ["read", "bash"])?.toolName, "read");
    assert.equal(findGhostToolCall(msg, ["bash"]), null, "unknown names are ordinary JSON");
  });
});

