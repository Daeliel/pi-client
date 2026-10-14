import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CdpBrowser } from "./cdp";
import { DEFAULT_CONFIG } from "./config";

/** A tab whose reload logs whatever errors the "current code" produces. */
class FakeTab extends CdpBrowser {
  pageErrors: string[] = [];
  override get connected(): boolean {
    return true;
  }
  override async reload(): Promise<void> {
    for (const message of this.pageErrors) this.pushEntry({ type: "error", message });
  }
}

describe("CdpBrowser fresh checks", () => {
  it("does not report errors the code no longer produces", async () => {
    const tab = new FakeTab();
    const config = { ...DEFAULT_CONFIG, autoReloadOnEdit: true, reloadWaitMs: 0 };

    tab.pageErrors = ["TypeError: x is undefined"];
    assert.equal((await tab.checkAfterEdit(config)).length, 1);

    tab.pageErrors = []; // the model fixed the bug
    assert.deepEqual(await tab.checkAfterEdit(config), []);
  });

  it("reports an error still produced after the fix attempt", async () => {
    const tab = new FakeTab();
    tab.pageErrors = ["ReferenceError: foo"];
    await tab.reloadFresh(0);
    await tab.reloadFresh(0);
    const entries = tab.getBuffered(false);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.repeatCount, 1, "old occurrences must not pile up across reloads");
  });
});
