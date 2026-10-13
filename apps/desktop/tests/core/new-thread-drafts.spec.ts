import { expect, test, type Page } from "@playwright/test";
import {
  chooseThreadGrouping,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  openNewThread,
  pasteTinyPng,
  resolveDeferredThreadTitleEventually,
  selectNewThreadEnvironment,
  selectSession,
  setDeferredThreadTitleMode,
  startThreadViaIpc,
} from "../helpers/electron-app";

const draftRows = (window: Page) => window.locator(".sidebar .draft-row");

async function clickSidebarNewThread(window: Page): Promise<void> {
  await window.locator(".sidebar").getByRole("button", { name: "New thread", exact: true }).click();
  await expect(window.getByTestId("new-thread-composer")).toBeVisible();
}

test("a new thread is a draft row that keeps its text, image and choices until it is sent", async () => {
  test.setTimeout(90_000);
  const harness = await launchDesktop(await makeUserDataDir(), {
    initialWorkspaces: [await makeWorkspace("new-thread-drafts")],
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await setDeferredThreadTitleMode(harness);
    await startThreadViaIpc(window, { prompt: "Existing conversation" });
    await resolveDeferredThreadTitleEventually(harness, "Existing conversation");

    // Opening New thread adds a draft row at once.
    await openNewThread(window);
    await expect(draftRows(window)).toHaveCount(1);
    await expect(draftRows(window).first()).toHaveClass(/draft-row--active/);
    await expect(draftRows(window).first()).toContainText("New thread");
    await expect(draftRows(window).first()).toContainText("Draft");

    // Fill the draft in, leave it for another thread, and come back through its row.
    const prompt = window.getByTestId("new-thread-composer");
    await prompt.fill("Draft text that was never sent");
    await pasteTinyPng(window, "draft-image.png", "new-thread-composer");
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    await selectNewThreadEnvironment(window, "worktree");
    await selectSession(window, "Existing conversation");
    await expect(window.getByTestId("new-thread-composer")).toHaveCount(0);
    await expect(draftRows(window)).toHaveCount(1);
    await expect(draftRows(window).first()).not.toHaveClass(/draft-row--active/);

    await draftRows(window)
      .first()
      .getByRole("button", { name: /New thread/ })
      .click();
    await expect(prompt).toHaveValue("Draft text that was never sent");
    await expect(window.locator(".composer-attachment")).toHaveCount(1);
    await expect(window.locator(".new-thread__environment-toggle")).toHaveText("Worktree");

    // A draft with content is kept; New thread opens a second, empty draft, and reuses it
    // while it stays empty.
    await clickSidebarNewThread(window);
    await expect(prompt).toHaveValue("");
    await expect(window.locator(".composer-attachment")).toHaveCount(0);
    await expect(draftRows(window)).toHaveCount(2);
    await selectSession(window, "Existing conversation");
    await clickSidebarNewThread(window);
    await expect(draftRows(window)).toHaveCount(2);

    // Discarding the open draft removes its row and returns to the threads view.
    const openDraftRow = window.locator(".sidebar .draft-row--active");
    await openDraftRow.hover();
    await openDraftRow.getByRole("button", { name: "Discard draft" }).click();
    await expect(draftRows(window)).toHaveCount(1);
    await expect(window.getByTestId("new-thread-composer")).toHaveCount(0);

    // In folder grouping the draft sits above its folder's threads.
    await chooseThreadGrouping(window, "workspace");
    const folder = window.locator(".workspace-group").first();
    await expect(folder.locator(".draft-row")).toHaveCount(1);
    expect(
      await folder.evaluate((group) => {
        const draft = group.querySelector(".draft-row");
        const thread = group.querySelector(".session-row");
        return Boolean(
          draft &&
          thread &&
          draft.compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    ).toBe(true);

    // Sending turns the draft into the real thread, which auto-titles as before.
    const sessionCount = async () =>
      (await getDesktopState(window)).workspaces.reduce(
        (count, workspace) => count + workspace.sessions.length,
        0,
      );
    const before = await sessionCount();
    await draftRows(window)
      .first()
      .getByRole("button", { name: /New thread/ })
      .click();
    await selectNewThreadEnvironment(window, "local");
    await window.getByRole("button", { name: "Start thread", exact: true }).click();
    await expect(window.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
    await expect(draftRows(window)).toHaveCount(0);
    await expect.poll(sessionCount).toBe(before + 1);
    await resolveDeferredThreadTitleEventually(harness, "Sent draft");
    await expect(window.locator(".chat-header__title")).toHaveText("Sent draft");
  } finally {
    await harness.close();
  }
});
