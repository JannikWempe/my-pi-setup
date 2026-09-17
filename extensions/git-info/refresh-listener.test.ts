import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import gitInfo from "./index.ts";
import modelInfo from "../model-info/index.ts";
import { REFRESH_CHANNEL } from "../shared/dashboard-state.ts";

for (const extension of [gitInfo, modelInfo]) {
  test(`${extension.name} releases refresh listeners across reloads and repeated shutdown`, async () => {
    const listeners = new Set<() => void>();
    for (let reload = 0; reload < 3; reload++) {
      let shutdown: (() => unknown) | undefined;
      const pi = {
        events: {
          on(channel: string, listener: () => void) {
            assert.equal(channel, REFRESH_CHANNEL);
            listeners.add(listener);
            return () => {
              listeners.delete(listener);
            };
          },
          emit() {},
        },
        on(event: string, handler: () => unknown) {
          if (event === "session_shutdown") shutdown = handler;
        },
        registerCommand() {},
      } as unknown as ExtensionAPI;
      extension(pi);
      assert.equal(listeners.size, 1);
      // Factories can be loaded without ever starting a session.
      for (const listener of listeners) listener();
      assert.ok(shutdown);
      await shutdown();
      await shutdown();
      assert.equal(listeners.size, 0);
    }
  });
}
