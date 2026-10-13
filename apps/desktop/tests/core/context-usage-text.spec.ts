import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  seedAgentDir,
  waitForWorkspaceByPath,
  writeProjectExtension,
} from "../helpers/electron-app";

// A local scripted provider whose one reply reports 48k tokens of a 1M window and $0.38.
const providerExtension = String.raw`
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function usageTextFixture(pi) {
  pi.registerProvider("usage-text-test", {
    baseUrl: "http://127.0.0.1:9/never-contact",
    apiKey: "LOCAL_TEST_CANARY",
    api: "usage-text-test",
    models: [{
      id: "scripted", name: "Scripted usage", reasoning: false,
      input: ["text"], contextWindow: 1000000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model) {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "Usage reported" }],
        api: model.api, provider: model.provider, model: model.id,
        usage: {
          input: 40000, output: 8000, cacheRead: 0, cacheWrite: 0, totalTokens: 48000,
          cost: { input: 0.3, output: 0.08, cacheRead: 0, cacheWrite: 0, total: 0.38 },
        },
        stopReason: "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "text_delta", contentIndex: 0, delta: "Usage reported", partial: message });
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    },
  });
}
`;

test("the composer footer shows context usage and thread cost as text", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("context-usage-text");
  await seedAgentDir(agentDir, { withOpenAiAuth: false, withDefaultModel: false });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "usage-text-test",
      defaultModel: "scripted",
      enabledModels: ["usage-text-test/scripted"],
      packages: [],
      cacheWarming: "off",
      compaction: { enabled: false },
    }),
  );
  await writeProjectExtension(workspacePath, "usage-text.ts", providerExtension);
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await waitForWorkspaceByPath(window, workspacePath);
    await window
      .locator(".sidebar")
      .getByRole("button", { name: "New thread", exact: true })
      .click();
    await window.getByLabel("New thread prompt", { exact: true }).fill("report usage");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(
      window.locator(".timeline-item--assistant .message__content", { hasText: "Usage reported" }),
    ).toBeVisible();

    const usage = window.locator(".composer__config .context-meter__trigger");
    await expect(usage).toHaveText("5% · 48k / 1M · $0.38");
    await usage.hover();
    const card = window.getByRole("tooltip").filter({ hasText: "Context window" });
    await expect(card).toContainText("5% used · 48k / 1M tokens");
    await expect(card).toContainText("$0.38");
  } finally {
    await harness.close();
  }
});
