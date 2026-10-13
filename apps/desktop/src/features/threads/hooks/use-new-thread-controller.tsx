import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type KeyboardEvent,
  type SetStateAction,
} from "react";
import type { ExtensionFlagValues } from "@pi-gui/session-driver";
import {
  type AppView,
  type ComposerAttachment,
  type DesktopAppState,
  type NewThreadEnvironment,
  type StartThreadInput,
  type WorkspaceRecord,
} from "../../../../contracts/desktop-state";
import { acceptComposerAttachments } from "../../../../contracts/composer-attachments";
import { updateSnapshot } from "../../../app/desktop-app-state";
import {
  extractFilesFromDataTransfer,
  extractImageFilesFromClipboardData,
  handleClipboardImageShortcut,
  readComposerAttachmentsFromFiles,
} from "../../conversation/composer-attachments";
import { buildModelOptions, parseTreeComposerCommand } from "../../conversation/composer-commands";
import type { PiDesktopApi } from "../../../../contracts/ipc";
import { deriveModelOnboardingState } from "../../settings/model-onboarding";
import { getEffectiveModelRuntime } from "../../settings/model-settings";
import type { SettingsSection } from "../../settings/settings-view";
import { useMentionMenu } from "../../conversation/hooks/use-mention-menu";
import { useSlashMenu } from "../../conversation/hooks/use-slash-menu";
import { resolveRepoWorkspaceId } from "../../../../contracts/workspace-roots";

interface UseNewThreadControllerParams {
  readonly api: PiDesktopApi | undefined;
  readonly snapshot: DesktopAppState | null;
  readonly setSnapshot: Dispatch<SetStateAction<DesktopAppState | null>>;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly rootWorkspaceOptions: readonly WorkspaceRecord[];
  readonly visibleWorkspaces: readonly WorkspaceRecord[];
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly openSettings: (workspaceId?: string, section?: SettingsSection) => void;
  readonly flushComposerDraft: () => void;
}

export function useNewThreadController(params: UseNewThreadControllerParams) {
  const {
    api,
    snapshot,
    setSnapshot,
    rootWorkspace,
    rootWorkspaceOptions,
    visibleWorkspaces,
    selectedWorkspace,
    openSettings,
    flushComposerDraft,
  } = params;

  const [pendingWorkspaceId, setPendingWorkspaceId] = useState("");
  // Unsent New thread surfaces, newest first. They live in this window's memory only.
  const [drafts, setDrafts] = useState<readonly NewThreadDraft[]>([]);
  const draftsRef = useRef<readonly NewThreadDraft[]>([]);
  const [activeDraftId, setActiveDraftIdState] = useState("");
  const activeDraftIdRef = useRef("");
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const previousActiveViewRef = useRef<AppView | null>(null);
  // Set while an in-app open is switching to New thread, so its chosen folder
  // is not replaced by the selected one when the view change arrives.
  const openedInAppRef = useRef(false);
  // Drafts whose start is in flight, so a second Enter or click cannot start them twice.
  const startingDraftIdsRef = useRef(new Set<string>());

  // Updates go through refs so several in one event (or an async completion) see the latest list.
  const updateDrafts = useCallback(
    (update: (current: readonly NewThreadDraft[]) => readonly NewThreadDraft[]) => {
      const next = update(draftsRef.current);
      if (next === draftsRef.current) return;
      draftsRef.current = next;
      setDrafts(next);
    },
    [],
  );
  const updateDraft = useCallback(
    (draftId: string, update: (draft: NewThreadDraft) => NewThreadDraft) => {
      updateDrafts((current) =>
        current.some((draft) => draft.id === draftId)
          ? current.map((draft) => (draft.id === draftId ? update(draft) : draft))
          : current,
      );
    },
    [updateDrafts],
  );
  const setActiveDraftId = useCallback((draftId: string) => {
    activeDraftIdRef.current = draftId;
    setActiveDraftIdState(draftId);
  }, []);
  // The folder the surface shows when no draft is open (for example after its folder was removed).
  const fallbackRootWorkspaceIdRef = useRef("");
  const updateActiveDraft = useCallback(
    (update: (draft: NewThreadDraft) => NewThreadDraft) => {
      if (
        !draftsRef.current.some((entry) => entry.id === activeDraftIdRef.current) &&
        fallbackRootWorkspaceIdRef.current
      ) {
        // An edit always lands in a draft, so the surface is never inert.
        const created = createDraft(fallbackRootWorkspaceIdRef.current);
        updateDrafts((current) => [created, ...current]);
        setActiveDraftId(created.id);
      }
      updateDraft(activeDraftIdRef.current, update);
    },
    [setActiveDraftId, updateDraft, updateDrafts],
  );

  /** Opens the folder's empty draft, or adds a new one, and makes it the active draft. */
  const openFolderDraft = useCallback(
    (rootWorkspaceId: string) => {
      const empty = draftsRef.current.find(
        (draft) => draft.rootWorkspaceId === rootWorkspaceId && isEmptyDraft(draft),
      );
      if (empty) {
        setActiveDraftId(empty.id);
        return;
      }
      const draft = createDraft(rootWorkspaceId);
      updateDrafts((current) => [draft, ...current]);
      setActiveDraftId(draft.id);
    },
    [setActiveDraftId, updateDrafts],
  );

  const draft = drafts.find((entry) => entry.id === activeDraftId);
  const rootWorkspaceId = draft?.rootWorkspaceId ?? "";
  const environment = draft?.environment ?? "local";
  const prompt = draft?.prompt ?? "";
  const attachments = draft?.attachments ?? NO_ATTACHMENTS;
  const provider = draft?.provider;
  const modelId = draft?.modelId;
  const thinkingLevel = draft?.thinkingLevel;
  const composerError = draft?.error;

  const workspace =
    rootWorkspaceOptions.find((entry) => entry.id === rootWorkspaceId) ?? rootWorkspaceOptions[0];
  fallbackRootWorkspaceIdRef.current = workspace?.id ?? "";
  const runtime = snapshot ? getEffectiveModelRuntime(snapshot, workspace) : undefined;
  const defaultEnabled = buildModelOptions(runtime).some(
    (m) =>
      m.providerId === runtime?.settings.defaultProvider &&
      m.modelId === runtime?.settings.defaultModelId,
  );
  const resolvedProvider =
    provider ?? (defaultEnabled ? runtime?.settings.defaultProvider : undefined);
  const resolvedModelId =
    modelId ?? (defaultEnabled ? runtime?.settings.defaultModelId : undefined);
  const resolvedThinkingLevel = thinkingLevel ?? runtime?.settings.defaultThinkingLevel;
  const workspaceFlagDefaults = workspace
    ? snapshot?.extensionFlagsByWorkspace[workspace.id]
    : undefined;
  const extensionFlagEdits = draft?.extensionFlagEdits;
  const extensionFlags = useMemo(
    () => ({ ...workspaceFlagDefaults, ...extensionFlagEdits }),
    [workspaceFlagDefaults, extensionFlagEdits],
  );
  const setExtensionFlag = useCallback(
    (name: string, value: boolean | string) => {
      updateActiveDraft((current) => ({
        ...current,
        extensionFlagEdits: { ...current.extensionFlagEdits, [name]: value },
      }));
    },
    [updateActiveDraft],
  );
  const modelOnboarding = deriveModelOnboardingState(runtime, {
    provider: resolvedProvider,
    modelId: resolvedModelId,
  });

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }, []);

  const setComposerError = useCallback(
    (error: string | undefined) => updateActiveDraft((current) => ({ ...current, error })),
    [updateActiveDraft],
  );

  const setPrompt = useCallback(
    (value: SetStateAction<string>) => {
      updateActiveDraft((current) => ({
        ...current,
        prompt: typeof value === "function" ? value(current.prompt) : value,
      }));
    },
    [updateActiveDraft],
  );

  const updatePrompt = useCallback(
    (value: SetStateAction<string>) => {
      updateActiveDraft((current) => ({
        ...current,
        error: undefined,
        prompt: typeof value === "function" ? value(current.prompt) : value,
      }));
    },
    [updateActiveDraft],
  );

  const appendAttachmentsToDraft = useCallback(
    (draftId: string, added: readonly ComposerAttachment[]) => {
      updateDraft(draftId, (current) => {
        const accepted = acceptComposerAttachments(current.attachments, added);
        if (!accepted.ok) {
          return { ...current, error: accepted.error.message };
        }
        return {
          ...current,
          error: undefined,
          attachments: [...current.attachments, ...accepted.attachments],
        };
      });
    },
    [updateDraft],
  );

  const addAttachments = useCallback(
    (files: File[]) => {
      // Files are read asynchronously; they belong to the draft they were added to.
      const draftId = activeDraftIdRef.current;
      void readComposerAttachmentsFromFiles(files, attachments)
        .then((added) => {
          if (added.length > 0) appendAttachmentsToDraft(draftId, added);
        })
        .catch((error: unknown) => {
          updateDraft(draftId, (current) => ({
            ...current,
            error: error instanceof Error ? error.message : String(error),
          }));
        });
    },
    [appendAttachmentsToDraft, attachments, updateDraft],
  );

  const removeAttachment = useCallback(
    (attachmentId: string) => {
      updateActiveDraft((current) => ({
        ...current,
        attachments: current.attachments.filter((attachment) => attachment.id !== attachmentId),
      }));
    },
    [updateActiveDraft],
  );

  const appendAttachment = useCallback(
    (attachment: ComposerAttachment) => {
      appendAttachmentsToDraft(activeDraftIdRef.current, [attachment]);
    },
    [appendAttachmentsToDraft],
  );

  const resolveRootWorkspaceId = useCallback(
    (workspaceId?: string) =>
      (workspaceId &&
        (rootWorkspaceOptions.find((w) => w.id === workspaceId)?.id ||
          (snapshot ? resolveRepoWorkspaceId(snapshot.workspaces, workspaceId) : undefined))) ||
      rootWorkspace?.id ||
      visibleWorkspaces[0]?.id ||
      "",
    [rootWorkspace?.id, rootWorkspaceOptions, snapshot, visibleWorkspaces],
  );

  const showNewThreadView = useCallback(() => {
    openedInAppRef.current = true;
    if (api) {
      void updateSnapshot(setSnapshot, () => api.setActiveView("new-thread")).catch(
        (error: unknown) => {
          console.error("[renderer] setActiveView failed", error);
        },
      );
    }
  }, [api, setSnapshot]);

  const openSurface = useCallback(
    (workspaceId?: string) => {
      // Save the outgoing conversation before the new-thread flow can change its selection.
      flushComposerDraft();
      setPendingWorkspaceId("");
      const nextRootWorkspaceId = resolveRootWorkspaceId(workspaceId);
      if (nextRootWorkspaceId) {
        openFolderDraft(nextRootWorkspaceId);
      }
      showNewThreadView();
    },
    [flushComposerDraft, openFolderDraft, resolveRootWorkspaceId, showNewThreadView],
  );

  const openDraft = useCallback(
    (draftId: string) => {
      if (!draftsRef.current.some((entry) => entry.id === draftId)) return;
      flushComposerDraft();
      setPendingWorkspaceId("");
      setActiveDraftId(draftId);
      showNewThreadView();
    },
    [flushComposerDraft, setActiveDraftId, showNewThreadView],
  );

  const discardDraft = useCallback(
    (draftId: string) => {
      updateDrafts((current) => current.filter((entry) => entry.id !== draftId));
      if (activeDraftIdRef.current !== draftId) return;
      setActiveDraftId("");
      if (api && snapshot?.activeView === "new-thread") {
        void updateSnapshot(setSnapshot, () => api.setActiveView("threads")).catch(
          (error: unknown) => {
            console.error("[renderer] setActiveView failed", error);
          },
        );
      }
    },
    [api, setActiveDraftId, setSnapshot, snapshot?.activeView, updateDrafts],
  );

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      setPendingWorkspaceId("");
      updateActiveDraft((current) => ({
        ...current,
        rootWorkspaceId: workspaceId,
        attachments: [],
        provider: undefined,
        modelId: undefined,
        thinkingLevel: undefined,
        extensionFlagEdits: {},
        error: undefined,
      }));
    },
    [updateActiveDraft],
  );

  const setEnvironment = useCallback(
    (nextEnvironment: NewThreadEnvironment) =>
      updateActiveDraft((current) => ({ ...current, environment: nextEnvironment })),
    [updateActiveDraft],
  );
  const setModel = useCallback(
    (nextProvider: string, nextModelId: string) =>
      updateActiveDraft((current) => ({
        ...current,
        provider: nextProvider,
        modelId: nextModelId,
      })),
    [updateActiveDraft],
  );
  const setThinkingLevel = useCallback(
    (level: string) => updateActiveDraft((current) => ({ ...current, thinkingLevel: level })),
    [updateActiveDraft],
  );

  const slashMenu = useSlashMenu({
    composerDraft: prompt,
    setComposerDraft: updatePrompt,
    selectedRuntime: runtime,
    selectedModelRuntime: runtime,
    sessionCommands: [],
    commandCompatibility: [],
    selectedSessionKey: `new-thread:${activeDraftId}`,
    selectedSession: undefined,
    selectedWorkspace: workspace,
    isRunning: false,
    api,
    setSnapshot,
    focusComposer,
    openSettings,
    updateSnapshot,
    allowTreeCommand: false,
    immediateCommandMode: "prefill",
    onSelectModelOption: setModel,
    onSelectThinkingOption: setThinkingLevel,
    onSelectLoginProvider: (providerId) => {
      if (!api || !workspace) {
        return;
      }
      void updateSnapshot(setSnapshot, () => api.loginProvider(workspace.id, providerId)).catch(
        (error: unknown) => {
          console.error("[renderer] loginProvider failed", error);
        },
      );
    },
    onSelectLogoutProvider: (providerId) => {
      if (!api || !workspace) {
        return;
      }
      void updateSnapshot(setSnapshot, () => api.logoutProvider(workspace.id, providerId)).catch(
        (error: unknown) => {
          console.error("[renderer] logoutProvider failed", error);
        },
      );
    },
  });

  const enableMentionExtension = useCallback(
    (filePath: string) => {
      if (!api || !workspace) {
        return Promise.resolve();
      }
      return updateSnapshot(setSnapshot, () =>
        api.setExtensionEnabled(workspace.id, filePath, true),
      ).then(() => undefined);
    },
    [api, setSnapshot, workspace],
  );

  const mentionMenu = useMentionMenu({
    composerDraft: prompt,
    setComposerDraft: setPrompt,
    composerRef,
    workspaceId: workspace?.id,
    runtime,
    api,
    onEnableExtension: enableMentionExtension,
  });

  const startThread = useCallback(() => {
    // The draft stays until the thread exists, so a second Enter or click before then
    // would otherwise start the same thread again (a worktree start takes seconds).
    const draftId = activeDraftIdRef.current;
    if (!api || !draftId || startingDraftIdsRef.current.has(draftId)) {
      return;
    }
    if (!rootWorkspaceId || (!prompt.trim() && attachments.length === 0)) {
      return;
    }
    if (modelOnboarding.requiresModelSelection) {
      return;
    }
    const treeCommand = parseTreeComposerCommand(prompt);
    if (treeCommand?.type === "error") {
      setComposerError(treeCommand.message);
      return;
    }
    if (treeCommand?.type === "tree") {
      setComposerError("/tree is only available inside an existing session.");
      return;
    }
    const input: StartThreadInput = {
      rootWorkspaceId,
      environment,
      prompt,
      attachments,
      provider: resolvedProvider,
      modelId: resolvedModelId,
      thinkingLevel: resolvedThinkingLevel,
      ...(Object.keys(extensionFlags).length > 0 ? { extensionFlags } : {}),
    };
    startingDraftIdsRef.current.add(draftId);
    void updateSnapshot(setSnapshot, () => api.startThread(input))
      .then(() => {
        // The real thread replaces its draft row.
        updateDrafts((current) => current.filter((entry) => entry.id !== draftId));
        if (activeDraftIdRef.current === draftId) setActiveDraftId("");
      })
      .catch((error: unknown) => {
        updateDraft(draftId, (current) => ({
          ...current,
          error: error instanceof Error ? error.message : String(error),
        }));
      })
      .finally(() => {
        startingDraftIdsRef.current.delete(draftId);
      });
  }, [
    api,
    attachments,
    environment,
    extensionFlags,
    modelOnboarding.requiresModelSelection,
    prompt,
    resolvedModelId,
    resolvedProvider,
    resolvedThinkingLevel,
    rootWorkspaceId,
    setActiveDraftId,
    setComposerError,
    setSnapshot,
    updateDraft,
    updateDrafts,
  ]);

  const handleComposerPaste = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      const files = extractImageFilesFromClipboardData(event.clipboardData);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      addAttachments(files);
    },
    [addAttachments],
  );

  const handleComposerDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const files = extractFilesFromDataTransfer(event.dataTransfer);
      if (files.length === 0) {
        return;
      }
      addAttachments(files);
    },
    [addAttachments],
  );

  const handleComposerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (
        handleClipboardImageShortcut(
          event,
          api?.readClipboardImage,
          appendAttachment,
          setComposerError,
        )
      ) {
        return;
      }

      if (mentionMenu.handleMentionKeyDown(event)) {
        return;
      }

      if (slashMenu.handleSlashKeyDown(event)) {
        return;
      }

      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }

      event.preventDefault();
      if (!prompt.trim() && attachments.length === 0) {
        return;
      }
      if (modelOnboarding.requiresModelSelection) {
        return;
      }

      startThread();
    },
    [
      api,
      appendAttachment,
      attachments.length,
      mentionMenu,
      modelOnboarding.requiresModelSelection,
      prompt,
      slashMenu,
      startThread,
    ],
  );

  // Drafts of a folder that is no longer listed are dropped.
  useEffect(() => {
    if (!snapshot) return;
    const listed = new Set(rootWorkspaceOptions.map((option) => option.id));
    updateDrafts((current) =>
      current.every((entry) => listed.has(entry.rootWorkspaceId))
        ? current
        : current.filter((entry) => listed.has(entry.rootWorkspaceId)),
    );
  }, [rootWorkspaceOptions, snapshot, updateDrafts]);

  useEffect(() => {
    if (!snapshot || !pendingWorkspaceId) {
      return;
    }
    const nextRootWorkspaceId = resolveRepoWorkspaceId(snapshot.workspaces, pendingWorkspaceId);
    if (!nextRootWorkspaceId || !rootWorkspaceOptions.some((w) => w.id === nextRootWorkspaceId)) {
      return;
    }
    openFolderDraft(nextRootWorkspaceId);
    setPendingWorkspaceId("");
  }, [openFolderDraft, pendingWorkspaceId, rootWorkspaceOptions, snapshot]);

  useEffect(() => {
    if (!snapshot) {
      return;
    }
    if (
      snapshot.activeView === "new-thread" &&
      previousActiveViewRef.current !== "new-thread" &&
      !openedInAppRef.current
    ) {
      // Main opened New thread itself (a folder was just added, or the app restarted on it).
      const nextRootWorkspaceId =
        resolveRepoWorkspaceId(snapshot.workspaces, selectedWorkspace?.id) ??
        resolveRootWorkspaceId();
      if (nextRootWorkspaceId) {
        openFolderDraft(nextRootWorkspaceId);
      }
    }
    if (snapshot.activeView === "new-thread") openedInAppRef.current = false;
    previousActiveViewRef.current = snapshot.activeView;
  }, [openFolderDraft, resolveRootWorkspaceId, selectedWorkspace?.id, snapshot]);

  return useMemo(
    () => ({
      composerRef,
      workspace,
      runtime,
      rootWorkspaceId,
      environment,
      prompt,
      attachments,
      composerError,
      resolvedProvider,
      resolvedModelId,
      resolvedThinkingLevel,
      extensionFlags,
      setExtensionFlag,
      modelOnboarding,
      slashMenu,
      mentionMenu,
      drafts,
      activeDraftId,
      openDraft,
      discardDraft,
      setPrompt,
      setEnvironment,
      setModel,
      setThinkingLevel,
      setPendingWorkspaceId,
      selectWorkspace,
      addAttachments,
      removeAttachment,
      appendAttachment,
      handleComposerPaste,
      handleComposerDrop,
      handleComposerKeyDown,
      startThread,
      openSurface,
      setComposerError,
    }),
    [
      workspace,
      runtime,
      rootWorkspaceId,
      environment,
      prompt,
      attachments,
      composerError,
      resolvedProvider,
      resolvedModelId,
      resolvedThinkingLevel,
      extensionFlags,
      setExtensionFlag,
      modelOnboarding,
      slashMenu,
      mentionMenu,
      drafts,
      activeDraftId,
      openDraft,
      discardDraft,
      setPrompt,
      setEnvironment,
      setModel,
      setThinkingLevel,
      selectWorkspace,
      addAttachments,
      removeAttachment,
      appendAttachment,
      handleComposerPaste,
      handleComposerDrop,
      handleComposerKeyDown,
      startThread,
      openSurface,
      setComposerError,
    ],
  );
}

/** One unsent New thread surface. Model, thinking and flags hold only explicit choices. */
export interface NewThreadDraft {
  readonly id: string;
  readonly rootWorkspaceId: string;
  readonly environment: NewThreadEnvironment;
  readonly prompt: string;
  readonly attachments: readonly ComposerAttachment[];
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
  readonly extensionFlagEdits: ExtensionFlagValues;
  readonly error?: string;
}

const NO_ATTACHMENTS: readonly ComposerAttachment[] = [];

function createDraft(rootWorkspaceId: string): NewThreadDraft {
  return {
    id: crypto.randomUUID(),
    rootWorkspaceId,
    environment: "local",
    prompt: "",
    attachments: [],
    extensionFlagEdits: {},
  };
}

function isEmptyDraft(draft: NewThreadDraft): boolean {
  return !draft.prompt.trim() && draft.attachments.length === 0;
}
