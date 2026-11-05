import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listVisionModels, loadVisionRelayConfig, pickRelayModel, sessionSeesImages } from "./vision-relay";

/**
 * Can anything here see images? The session model itself, a vision relay that answers (it
 * describes images in text), or nothing. When nothing can, the model is "blind": no harness
 * step may ask it for screenshots as proof, show it screenshots, or offer it screenshot tools —
 * it would be asked to approve what it cannot look at.
 *
 * `isBlind` answers at once, for code that cannot wait (tool lists, prompt text): from the
 * last check that asked the servers, or — before there is one — from what is configured (no
 * vision model at all is blind; one that may be down counts as seeing until checked).
 * `checkEyes` asks the servers and remembers the answer.
 */

export interface EyesVerdict {
  blind: boolean;
  /** Why nothing can see, for notices. Empty when something can. */
  reason: string;
}

const CHECK_TTL_MS = 30_000;
const verdicts = new Map<string, EyesVerdict & { at: number }>();
const listeners = new Set<(ctx: ExtensionContext) => void>();

const keyOf = (ctx: ExtensionContext) => `${ctx.cwd}|${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : ""}`;

/** Answers that need no network: null when only asking the servers can tell. */
function knownWithoutNetwork(ctx: ExtensionContext): EyesVerdict | null {
  if (!ctx.model) return null;
  if (sessionSeesImages(ctx)) return { blind: false, reason: "" };
  const config = loadVisionRelayConfig(ctx.cwd);
  if (!config.enabled) return { blind: true, reason: "the vision relay is off" };
  const session = `${ctx.model.provider}/${ctx.model.id}`;
  if (!config.relayModel.trim() && !listVisionModels(ctx).some((m) => m !== session)) {
    return { blind: true, reason: "no model that can see images is set up" };
  }
  return null;
}

export function isBlind(ctx: ExtensionContext): boolean {
  const known = knownWithoutNetwork(ctx);
  if (known) return known.blind;
  const seen = verdicts.get(keyOf(ctx));
  if (!seen || Date.now() - seen.at > CHECK_TTL_MS) void checkEyes(ctx).catch(() => {});
  return seen?.blind ?? false;
}

export async function checkEyes(ctx: ExtensionContext): Promise<EyesVerdict> {
  const known = knownWithoutNetwork(ctx);
  let verdict: EyesVerdict;
  if (known) verdict = known;
  else {
    const picked = await pickRelayModel(ctx, loadVisionRelayConfig(ctx.cwd).relayModel);
    verdict = picked.model ? { blind: false, reason: "" } : { blind: true, reason: picked.reason ?? "no vision model answers" };
  }
  const key = keyOf(ctx);
  const before = verdicts.get(key);
  verdicts.set(key, { ...verdict, at: Date.now() });
  if ((before?.blind ?? false) !== verdict.blind) { // isBlind guessed "sees" until now
    for (const fn of listeners) {
      try {
        fn(ctx);
      } catch {
        /* a stale context must not break the others */
      }
    }
  }
  return verdict;
}

/** Called when a check changes the answer (a vision server went down or came back). */
export function onEyesChange(fn: (ctx: ExtensionContext) => void): void {
  listeners.add(fn);
}

/** The line every blind-mode prompt shares: what counts as proof instead. */
export const BLIND_PROOF =
  "You cannot see images and nothing here can describe them for you, so screenshots are not proof for you: " +
  "do not take, open or approve screenshots. Prove a result with what you can read — visible text, DOM state and values " +
  "read in the test (page.evaluate, toHaveText, boundingBox), console and network errors, logs.";
