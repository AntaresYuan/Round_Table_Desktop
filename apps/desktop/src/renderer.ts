import type {
  DesktopBridge,
  MissionApprovalPreview,
  ProtocolLocalAgentProvider,
  ProtocolLocalExecutionState,
  RuntimeArtifact,
  RuntimeCatalog,
  RuntimeExecutionEvent,
  RuntimeExecutionSnapshot,
  RuntimeLogEntry,
  ReviewBundle,
  WorkspaceEntries,
  WorkspaceSummary,
} from '@roundtable/protocol';

const MAX_RENDERED_LOG_ENTRIES = 200;
const MAX_RENDERED_LOG_CHARACTERS = 128_000;
const MAX_RENDERED_SUMMARY_CHARACTERS = 4_000;

type MissionPhase =
  | 'editing'
  | 'preparing'
  | 'approval'
  | 'approving'
  | 'execution'
  | 'reviewing'
  | 'applying'
  | 'terminal';

export type MountedDesktopRenderer = {
  ready: Promise<void>;
  selectWorkspace(): Promise<void>;
  openWorkspacePath(workspace: WorkspaceSummary, relativePath: string): Promise<void>;
  prepareMission(): Promise<void>;
  approveMission(): Promise<void>;
  stopExecution(): Promise<void>;
  reviewChanges(): Promise<void>;
  applyReviewedChanges(): Promise<void>;
  rejectReviewedChanges(): Promise<void>;
  dispose(): void;
};

export function mountDesktopRenderer(
  rendererDocument: Document,
  bridge: DesktopBridge,
): MountedDesktopRenderer {
  const systemDetails = requiredElement<HTMLElement>(
    rendererDocument,
    '[data-system-details]',
  );
  const selectButton = requiredElement<HTMLButtonElement>(
    rendererDocument,
    '[data-select-workspace]',
  );
  const upButton = requiredElement<HTMLButtonElement>(rendererDocument, '[data-up]');
  const workspacePanel = requiredElement<HTMLElement>(rendererDocument, '[data-workspace-panel]');
  const workspaceHeading = requiredElement<HTMLElement>(
    rendererDocument,
    '[data-workspace-heading]',
  );
  const pathLabel = requiredElement<HTMLElement>(rendererDocument, '[data-path-label]');
  const entriesList = requiredElement<HTMLUListElement>(
    rendererDocument,
    '[data-workspace-entries]',
  );
  const workspaceStatus = requiredElement<HTMLElement>(rendererDocument, '[data-status]');

  const missionPanel = requiredElement<HTMLElement>(rendererDocument, '[data-mission-panel]');
  const missionForm = requiredElement<HTMLFormElement>(rendererDocument, '[data-mission-form]');
  const providerSelect = requiredElement<HTMLSelectElement>(rendererDocument, '[data-provider]');
  const providerStatus = requiredElement<HTMLElement>(rendererDocument, '[data-provider-status]');
  const promptInput = requiredElement<HTMLTextAreaElement>(rendererDocument, '[data-prompt]');
  const prepareButton = requiredElement<HTMLButtonElement>(rendererDocument, '[data-prepare]');
  const missionStatus = requiredElement<HTMLElement>(rendererDocument, '[data-mission-status]');

  const approvalPanel = requiredElement<HTMLElement>(rendererDocument, '[data-approval-panel]');
  const approvalHeading = requiredElement<HTMLElement>(rendererDocument, '[data-approval-heading]');
  const approvalWorkspace = requiredElement<HTMLElement>(rendererDocument, '[data-approval-workspace]');
  const approvalProvider = requiredElement<HTMLElement>(rendererDocument, '[data-approval-provider]');
  const approvalPrompt = requiredElement<HTMLElement>(rendererDocument, '[data-approval-prompt]');
  const approvalPolicy = requiredElement<HTMLDListElement>(rendererDocument, '[data-approval-policy]');
  const approvalWarnings = requiredElement<HTMLUListElement>(rendererDocument, '[data-approval-warnings]');
  const approvalExpiry = requiredElement<HTMLElement>(rendererDocument, '[data-approval-expiry]');
  const editMissionButton = requiredElement<HTMLButtonElement>(rendererDocument, '[data-edit-mission]');
  const approveButton = requiredElement<HTMLButtonElement>(rendererDocument, '[data-approve]');

  const executionPanel = requiredElement<HTMLElement>(rendererDocument, '[data-execution-panel]');
  const executionHeading = requiredElement<HTMLElement>(rendererDocument, '[data-execution-heading]');
  const executionStateLabel = requiredElement<HTMLElement>(rendererDocument, '[data-execution-state]');
  const executionSummary = requiredElement<HTMLElement>(rendererDocument, '[data-execution-summary]');
  const stopButton = requiredElement<HTMLButtonElement>(rendererDocument, '[data-stop]');
  const newMissionButton = requiredElement<HTMLButtonElement>(rendererDocument, '[data-new-mission]');
  const logList = requiredElement<HTMLUListElement>(rendererDocument, '[data-execution-log]');
  const artifactList = requiredElement<HTMLUListElement>(rendererDocument, '[data-artifacts]');
  const reviewPanel = requiredElement<HTMLElement>(rendererDocument, '[data-review-panel]');
  const reviewHeading = requiredElement<HTMLElement>(rendererDocument, '[data-review-heading]');
  const reviewState = requiredElement<HTMLElement>(rendererDocument, '[data-review-state]');
  const reviewSummary = requiredElement<HTMLElement>(rendererDocument, '[data-review-summary]');
  const reviewChangesList = requiredElement<HTMLUListElement>(rendererDocument, '[data-review-changes]');
  const applyReviewButton = requiredElement<HTMLButtonElement>(rendererDocument, '[data-apply-review]');
  const rejectReviewButton = requiredElement<HTMLButtonElement>(rendererDocument, '[data-reject-review]');

  let activeWorkspace: WorkspaceSummary | null = null;
  let activeRelativePath = '';
  let workspaceOperationSequence = 0;
  let workspaceBusy = false;

  let runtimeCatalog: RuntimeCatalog | null = null;
  let missionOperationSequence = 0;
  let executionOperationSequence = 0;
  let missionPhase: MissionPhase = 'editing';
  let activePreview: MissionApprovalPreview | null = null;
  let activeExecutionId: RuntimeExecutionEvent['executionId'] | null = null;
  let executionState: ProtocolLocalExecutionState | null = null;
  let executionError: string | null = null;
  let treeTermination: RuntimeExecutionSnapshot['treeTermination'] = 'not-required';
  let activeReview: ReviewBundle | null = null;
  let lastExecutionSequence = 0;
  let stopRequestPending = false;
  let reviewOperationSequence = 0;
  let resyncPending = false;
  let disposed = false;
  const pendingEvents = new Map<number, RuntimeExecutionEvent>();
  const logs = new Map<number, RuntimeLogEntry>();
  const artifacts = new Map<string, RuntimeArtifact>();

  let unsubscribeExecutionEvents = (): void => undefined;
  try {
    // Register before initialization or any approval request so an immediately
    // starting process cannot outrun the Renderer subscription.
    unsubscribeExecutionEvents = bridge.onExecutionEvent(handleExecutionEvent);
  } catch {
    missionStatus.textContent = 'Live execution events are unavailable.';
  }

  const controller: MountedDesktopRenderer = {
    ready: initialize(),
    selectWorkspace,
    openWorkspacePath,
    prepareMission,
    approveMission,
    stopExecution,
    reviewChanges,
    applyReviewedChanges,
    rejectReviewedChanges,
    dispose,
  };

  selectButton.addEventListener('click', () => {
    if (!selectButton.disabled) void controller.selectWorkspace();
  });
  upButton.addEventListener('click', () => {
    if (upButton.disabled || !activeWorkspace) return;
    void controller.openWorkspacePath(activeWorkspace, parentPath(activeRelativePath));
  });
  missionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!prepareButton.disabled) void controller.prepareMission();
  });
  providerSelect.addEventListener('change', () => {
    renderProviderStatus();
    updateControls();
  });
  promptInput.addEventListener('input', updateControls);
  editMissionButton.addEventListener('click', returnToMissionEditor);
  approveButton.addEventListener('click', () => {
    if (!approveButton.disabled) void controller.approveMission();
  });
  stopButton.addEventListener('click', () => {
    if (!stopButton.disabled) void controller.stopExecution();
  });
  applyReviewButton.addEventListener('click', () => {
    if (!applyReviewButton.disabled) void controller.applyReviewedChanges();
  });
  rejectReviewButton.addEventListener('click', () => {
    if (!rejectReviewButton.disabled) void controller.rejectReviewedChanges();
  });
  newMissionButton.addEventListener('click', beginNewMission);
  updateControls();

  return controller;

  async function initialize(): Promise<void> {
    const systemInitialization = bridge.getSystemInfo().then(
      (info) => {
        if (!disposed) {
          systemDetails.textContent = `${info.platform} · ${info.architecture} · Electron ${info.electronVersion}`;
        }
      },
      () => {
        if (!disposed) systemDetails.textContent = 'Desktop runtime unavailable';
      },
    );
    const catalogInitialization = bridge.getRuntimeCatalog().then(
      (catalog) => {
        if (disposed) return;
        runtimeCatalog = catalog;
        renderRuntimeCatalog();
        setMissionStatus('Open a workspace, choose an available agent, and describe the mission.');
        updateControls();
      },
      () => {
        if (disposed) return;
        runtimeCatalog = null;
        providerSelect.replaceChildren(optionElement(
          rendererDocument,
          '',
          'Agent runtimes unavailable',
          true,
        ));
        setMissionStatus('Unable to inspect local agent runtimes.');
        updateControls();
      },
    );
    await Promise.all([systemInitialization, catalogInitialization]);
  }

  async function selectWorkspace(): Promise<void> {
    if (workspaceSelectionLocked()) {
      setWorkspaceStatus('Stop the active execution before changing workspace.');
      return;
    }
    const operation = beginWorkspaceOperation('Waiting for workspace selection…');
    try {
      const selection = await bridge.selectWorkspace();
      if (!isCurrentWorkspaceOperation(operation) || disposed) return;
      if (!selection.selected) {
        setWorkspaceStatus('Workspace selection canceled.');
        return;
      }

      activeWorkspace = selection.workspace;
      workspaceHeading.textContent = selection.workspace.name;
      resetMissionForWorkspace();
      await loadWorkspacePath(selection.workspace, '', operation);
    } catch {
      if (isCurrentWorkspaceOperation(operation) && !disposed) {
        setWorkspaceStatus('Unable to authorize that workspace.');
      }
    } finally {
      finishWorkspaceOperation(operation);
    }
  }

  async function openWorkspacePath(
    workspace: WorkspaceSummary,
    relativePath: string,
  ): Promise<void> {
    const operation = beginWorkspaceOperation(`Loading ${displayPath(relativePath)}…`);
    try {
      await loadWorkspacePath(workspace, relativePath, operation);
    } catch {
      if (isCurrentWorkspaceOperation(operation) && !disposed) {
        setWorkspaceStatus(`Unable to read ${displayPath(relativePath)}.`);
      }
    } finally {
      finishWorkspaceOperation(operation);
    }
  }

  async function loadWorkspacePath(
    workspace: WorkspaceSummary,
    relativePath: string,
    operation: number,
  ): Promise<void> {
    const listing = await bridge.listWorkspaceEntries({
      workspaceId: workspace.id,
      relativePath,
    });
    if (!isCurrentWorkspaceOperation(operation) || disposed) return;

    activeWorkspace = listing.workspace;
    activeRelativePath = listing.relativePath;
    renderEntries(listing);
    announceListing(listing);
    pathLabel.focus({ preventScroll: true });
  }

  async function prepareMission(): Promise<void> {
    const provider = selectedAvailableProvider();
    const prompt = promptInput.value.trim();
    if (!activeWorkspace || !provider || prompt.length === 0 || prompt.length > 12_000) {
      setMissionStatus('Choose an authorized workspace, an available agent, and a prompt.');
      updateControls();
      return;
    }

    const operation = ++missionOperationSequence;
    const workspaceId = activeWorkspace.id;
    missionPhase = 'preparing';
    setMissionStatus('Preparing the exact execution policy for review…');
    updateControls();
    try {
      const preview = await bridge.prepareMission({ workspaceId, provider, prompt });
      if (
        disposed
        || operation !== missionOperationSequence
        || activeWorkspace?.id !== workspaceId
      ) return;

      clearExecutionProjection();
      activePreview = preview;
      missionPhase = 'approval';
      renderApprovalPreview(preview);
      setMissionStatus('Review the workspace access and runtime policy before starting.');
      updateControls();
      approvalHeading.focus({ preventScroll: true });
    } catch {
      if (operation !== missionOperationSequence || disposed) return;
      missionPhase = 'editing';
      setMissionStatus('Unable to prepare this mission. Check the runtime and try again.');
      updateControls();
    }
  }

  async function approveMission(): Promise<void> {
    if (!activePreview || missionPhase !== 'approval') return;
    const operation = ++missionOperationSequence;
    const preview = activePreview;
    missionPhase = 'approving';
    setMissionStatus('Approval submitted. Waiting for a confirmed execution snapshot…');
    updateControls();
    executionHeading.focus({ preventScroll: true });

    try {
      const accepted = await bridge.approveMission({ approvalId: preview.approvalId });
      if (disposed || operation !== missionOperationSequence) return;
      if (accepted.missionId !== preview.missionId) {
        throw new Error('mission_execution_mismatch');
      }
      if (activeExecutionId && activeExecutionId !== accepted.executionId) {
        throw new Error('mission_execution_mismatch');
      }

      activeExecutionId = accepted.executionId;
      // Accepted is a trusted acknowledgement but has no event sequence. It may
      // improve an empty projection, never overwrite an earlier Runtime event.
      if (lastExecutionSequence === 0 && executionState === null) {
        executionState = accepted.state;
        missionPhase = isTerminalState(accepted.state) ? 'terminal' : 'execution';
        renderExecutionProjection();
      }
      updateControls();
      await resyncExecution(accepted.executionId);
    } catch {
      if (operation !== missionOperationSequence || disposed) return;
      if (!activeExecutionId) {
        missionPhase = 'approval';
        setMissionStatus('The mission was not started. Review the policy and try again.');
      } else {
        setMissionStatus('Execution state could not be synchronized. Live events remain authoritative.');
      }
      updateControls();
    }
  }

  async function stopExecution(): Promise<void> {
    if (!activeExecutionId || !isStoppableState(executionState) || stopRequestPending) return;
    const operation = ++executionOperationSequence;
    const executionId = activeExecutionId;
    stopRequestPending = true;
    setMissionStatus('Stop requested. Waiting for process-tree confirmation…');
    updateControls();
    try {
      const snapshot = await bridge.stopExecution({ executionId });
      if (
        disposed
        || operation !== executionOperationSequence
        || activeExecutionId !== executionId
      ) return;
      applyExecutionSnapshot(snapshot);
    } catch {
      if (
        operation === executionOperationSequence
        && activeExecutionId === executionId
        && !disposed
      ) {
        setMissionStatus('Unable to request Stop. The confirmed execution state has not changed.');
      }
    } finally {
      if (operation === executionOperationSequence && activeExecutionId === executionId) {
        stopRequestPending = false;
        updateControls();
      }
    }
  }

  async function reviewChanges(): Promise<void> {
    if (!activeExecutionId || !activeWorkspace
      || !bridge.beginReview || !bridge.inspectReview
      || treeTermination !== 'confirmed' || !isTerminalState(executionState)) {
      setMissionStatus('Workspace review is unavailable until execution termination is confirmed.');
      return;
    }
    const operation = ++reviewOperationSequence;
    missionPhase = 'reviewing';
    setMissionStatus('Inspecting staged workspace changes…');
    updateControls();
    try {
      await bridge.beginReview({ executionId: activeExecutionId, workspaceId: activeWorkspace.id });
      const bundle = await bridge.inspectReview({
        executionId: activeExecutionId,
        workspaceId: activeWorkspace.id,
      });
      if (disposed || operation !== reviewOperationSequence) return;
      if (bundle.executionId !== activeExecutionId || bundle.workspaceId !== activeWorkspace.id) {
        throw new Error('review_execution_mismatch');
      }
      activeReview = bundle;
      renderReview(bundle);
      setMissionStatus('Review the staged changes before applying them to the workspace.');
      updateControls();
      reviewHeading.focus({ preventScroll: true });
    } catch {
      if (disposed || operation !== reviewOperationSequence) return;
      activeReview = null;
      missionPhase = 'terminal';
      setMissionStatus('Workspace review is unavailable; no changes were applied.');
      updateControls();
    }
  }

  async function applyReviewedChanges(): Promise<void> {
    if (!activeReview || !bridge.prepareReview || !bridge.authorizeApply) return;
    const operation = ++reviewOperationSequence;
    missionPhase = 'applying';
    setMissionStatus('Applying only the reviewed workspace changes…');
    updateControls();
    try {
      const challenge = await bridge.prepareReview({ bundle: activeReview });
      if (disposed || operation !== reviewOperationSequence) return;
      await bridge.authorizeApply({ applyId: challenge.applyId });
      if (disposed || operation !== reviewOperationSequence) return;
      activeReview = null;
      missionPhase = 'terminal';
      setMissionStatus('Reviewed changes applied to the workspace.');
      updateControls();
    } catch {
      if (disposed || operation !== reviewOperationSequence) return;
      missionPhase = 'reviewing';
      setMissionStatus('Apply was not completed. The review remains available for reconciliation.');
      updateControls();
    }
  }

  async function rejectReviewedChanges(): Promise<void> {
    if (!activeReview || !bridge.prepareReview || !bridge.rejectApply) return;
    const operation = ++reviewOperationSequence;
    missionPhase = 'applying';
    setMissionStatus('Rejecting staged changes and cleaning the transaction…');
    updateControls();
    try {
      const challenge = await bridge.prepareReview({ bundle: activeReview });
      if (disposed || operation !== reviewOperationSequence) return;
      await bridge.rejectApply({ applyId: challenge.applyId });
      if (disposed || operation !== reviewOperationSequence) return;
      activeReview = null;
      missionPhase = 'terminal';
      setMissionStatus('Staged changes rejected; the workspace was not modified.');
      updateControls();
    } catch {
      if (disposed || operation !== reviewOperationSequence) return;
      missionPhase = 'reviewing';
      setMissionStatus('Staged changes could not be rejected; cleanup requires reconciliation.');
      updateControls();
    }
  }

  function handleExecutionEvent(event: RuntimeExecutionEvent): void {
    if (disposed || !eventBelongsToCurrentMission(event)) return;
    if (activeExecutionId && activeExecutionId !== event.executionId) return;
    if (!activeExecutionId) activeExecutionId = event.executionId;
    if (event.sequence <= lastExecutionSequence || pendingEvents.has(event.sequence)) return;

    pendingEvents.set(event.sequence, event);
    drainPendingEvents();
  }

  function eventBelongsToCurrentMission(event: RuntimeExecutionEvent): boolean {
    if (activePreview?.missionId === event.missionId) return true;
    return activeExecutionId === event.executionId;
  }

  function drainPendingEvents(): void {
    let next = pendingEvents.get(lastExecutionSequence + 1);
    while (next) {
      pendingEvents.delete(next.sequence);
      applyExecutionEvent(next);
      next = pendingEvents.get(lastExecutionSequence + 1);
    }

    if (pendingEvents.size > 0 && activeExecutionId && !resyncPending) {
      void resyncExecution(activeExecutionId);
    }
  }

  function applyExecutionEvent(event: RuntimeExecutionEvent): void {
    if (event.sequence !== lastExecutionSequence + 1) return;
    const previousPhase = missionPhase;
    lastExecutionSequence = event.sequence;

    if (event.type === 'state') {
      executionState = event.state;
      executionError = event.error;
      treeTermination = event.treeTermination;
      missionPhase = isTerminalState(event.state) ? 'terminal' : 'execution';
      if (event.state === 'stopping') {
        setMissionStatus('Stopping. Waiting for the complete process tree to terminate…');
    } else if (isTerminalState(event.state)) {
      stopRequestPending = false;
      setMissionStatus(terminalAnnouncement(event.state, event.treeTermination));
      if (event.treeTermination === 'confirmed' && bridge.beginReview && bridge.inspectReview
        && !activeReview) {
        void reviewChanges();
      }
      } else {
        setMissionStatus(executionAnnouncement(event.state));
      }
    } else if (event.type === 'output') {
      appendLog({
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        stream: event.stream,
        text: event.truncated ? `${event.text}\n[output truncated by Runtime]` : event.text,
      });
    } else {
      artifacts.set(event.artifact.relativePath, event.artifact);
    }

    renderExecutionProjection();
    updateControls();
    focusExecutionTransition(previousPhase);
  }

  async function resyncExecution(executionId: RuntimeExecutionEvent['executionId']): Promise<void> {
    if (resyncPending || disposed) return;
    resyncPending = true;
    let canDrainContiguousEvents = false;
    try {
      const snapshot = await bridge.getExecution({ executionId });
      if (disposed || activeExecutionId !== executionId) return;
      applyExecutionSnapshot(snapshot);
      for (const sequence of pendingEvents.keys()) {
        if (sequence <= lastExecutionSequence) pendingEvents.delete(sequence);
      }
      canDrainContiguousEvents = pendingEvents.has(lastExecutionSequence + 1);
      if (pendingEvents.size > 0 && !canDrainContiguousEvents) {
        setMissionStatus('Live updates still have a sequence gap; waiting for the next synchronization.');
      }
    } catch {
      if (!disposed && activeExecutionId === executionId) {
        setMissionStatus('Live updates skipped an event and could not yet be synchronized.');
      }
    } finally {
      resyncPending = false;
      // Do not spin on an immediately rejected/stale snapshot. A later event or
      // explicit query will retry; only a now-contiguous buffered event is safe
      // to drain synchronously.
      if (
        canDrainContiguousEvents
        && !disposed
        && activeExecutionId === executionId
      ) drainPendingEvents();
    }
  }

  function applyExecutionSnapshot(snapshot: RuntimeExecutionSnapshot): void {
    if (
      !activeWorkspace
      || snapshot.workspace.id !== activeWorkspace.id
      || (activePreview && snapshot.missionId !== activePreview.missionId)
      || snapshot.sequence < lastExecutionSequence
    ) return;
    if (activeExecutionId && snapshot.executionId !== activeExecutionId) return;

    const previousPhase = missionPhase;
    activeExecutionId = snapshot.executionId;
    lastExecutionSequence = snapshot.sequence;
    executionState = snapshot.state;
    executionError = snapshot.error;
    treeTermination = snapshot.treeTermination;
    missionPhase = isTerminalState(snapshot.state) ? 'terminal' : 'execution';
    if (isTerminalState(snapshot.state)) stopRequestPending = false;
    if (snapshot.treeTermination === 'confirmed' && bridge.beginReview && bridge.inspectReview
      && !activeReview) {
      void reviewChanges();
    }

    logs.clear();
    for (const entry of snapshot.logs) appendLog(entry);
    artifacts.clear();
    for (const artifact of snapshot.artifacts) artifacts.set(artifact.relativePath, artifact);

    executionSummary.textContent = boundedText(snapshot.summary, MAX_RENDERED_SUMMARY_CHARACTERS);
    setMissionStatus(
      isTerminalState(snapshot.state)
        ? terminalAnnouncement(snapshot.state, snapshot.treeTermination)
        : executionAnnouncement(snapshot.state),
    );
    renderExecutionProjection();
    updateControls();
    focusExecutionTransition(previousPhase);
  }

  function renderRuntimeCatalog(): void {
    const previousProvider = providerSelect.value;
    providerSelect.replaceChildren();
    if (!runtimeCatalog) return;

    for (const entry of runtimeCatalog.providers) {
      const suffix = entry.available ? '' : ' — unavailable';
      const option = optionElement(
        rendererDocument,
        entry.provider,
        `${entry.label}${suffix}`,
        !entry.available,
      );
      providerSelect.append(option);
    }
    const preferred = runtimeCatalog.providers.find((entry) => (
      entry.provider === previousProvider && entry.available
    ));
    providerSelect.value = preferred?.provider
      ?? runtimeCatalog.providers.find((entry) => entry.available)?.provider
      ?? '';
    renderProviderStatus();
  }

  function renderProviderStatus(): void {
    const provider = selectedCatalogEntry();
    if (!provider) {
      providerStatus.textContent = 'No supported local agent is ready.';
      return;
    }
    const version = provider.version ? ` · ${provider.version}` : '';
    providerStatus.textContent = provider.available
      ? `${provider.label}${version} · ${provider.policy.adapterVersion}`
      : `${provider.label} unavailable · ${provider.installHint}`;
  }

  function renderApprovalPreview(preview: MissionApprovalPreview): void {
    approvalWorkspace.textContent = preview.workspace.name;
    approvalProvider.textContent = providerLabel(preview.provider);
    approvalPrompt.textContent = preview.prompt;
    approvalExpiry.textContent = `Approval expires ${formatTime(preview.expiresAt)}.`;
    approvalPolicy.replaceChildren();
    const policyRows: Array<[string, string]> = [
      ['Workspace', preview.policy.workspaceWrite ? 'Read and write' : 'Read only'],
      ['Sandbox', humanize(preview.policy.sandbox)],
      ['Outside workspace', humanize(preview.policy.externalFileAccess)],
      ['Network', humanize(preview.policy.network)],
      ['Secrets', humanize(preview.policy.secrets)],
      ['Timeout', formatDuration(preview.policy.timeoutMs)],
    ];
    for (const [term, description] of policyRows) {
      const termElement = rendererDocument.createElement('dt');
      termElement.textContent = term;
      const descriptionElement = rendererDocument.createElement('dd');
      descriptionElement.textContent = description;
      approvalPolicy.append(termElement, descriptionElement);
    }

    approvalWarnings.replaceChildren();
    for (const warning of preview.warnings) {
      const item = rendererDocument.createElement('li');
      item.textContent = warning;
      approvalWarnings.append(item);
    }
    approvalWarnings.hidden = preview.warnings.length === 0;
  }

  function renderExecutionProjection(): void {
    executionStateLabel.textContent = executionState
      ? stateLabel(executionState, treeTermination)
      : 'Synchronizing';
    executionStateLabel.dataset.state = executionState ?? 'synchronizing';
    if (executionError) {
      executionSummary.textContent = boundedText(executionError, MAX_RENDERED_SUMMARY_CHARACTERS);
    }
    renderLogs();
    renderArtifacts();
  }

  function renderReview(bundle: ReviewBundle): void {
    reviewState.textContent = 'Ready for approval';
    reviewState.dataset.state = 'reviewing';
    reviewSummary.textContent = `${bundle.changes.length} reviewed change(s) · baseline ${shortHash(bundle.baselineHash)} · result ${shortHash(bundle.resultHash)}`;
    reviewChangesList.replaceChildren();
    if (bundle.changes.length === 0) {
      const empty = rendererDocument.createElement('li');
      empty.className = 'review-empty';
      empty.textContent = 'No staged changes were produced.';
      reviewChangesList.append(empty);
      return;
    }
    for (const change of bundle.changes) {
      const item = rendererDocument.createElement('li');
      item.className = 'review-change';
      const path = rendererDocument.createElement('strong');
      path.textContent = change.relativePath;
      const detail = rendererDocument.createElement('span');
      detail.textContent = ` · ${change.change}`;
      item.append(path, detail);
      reviewChangesList.append(item);
    }
  }

  function renderLogs(): void {
    logList.replaceChildren();
    const entries = boundedLogEntries([...logs.values()].sort((left, right) => (
      left.sequence - right.sequence
    )));
    for (const entry of entries) {
      const item = rendererDocument.createElement('li');
      item.className = `log-entry log-${entry.stream}`;
      const stream = rendererDocument.createElement('span');
      stream.className = 'log-stream';
      stream.textContent = entry.stream;
      const text = rendererDocument.createElement('span');
      text.className = 'log-text';
      text.textContent = entry.text;
      item.append(stream, text);
      logList.append(item);
    }
    if (entries.length === 0) {
      const empty = rendererDocument.createElement('li');
      empty.className = 'log-empty';
      empty.textContent = 'Waiting for Runtime output.';
      logList.append(empty);
    }
  }

  function renderArtifacts(): void {
    artifactList.replaceChildren();
    const visibleArtifacts = [...artifacts.values()].sort((left, right) => (
      left.relativePath.localeCompare(right.relativePath)
    ));
    for (const artifact of visibleArtifacts) {
      const item = rendererDocument.createElement('li');
      const button = rendererDocument.createElement('button');
      button.type = 'button';
      button.className = 'artifact-button';
      button.textContent = artifact.relativePath;
      button.setAttribute('aria-label', `Show ${artifact.relativePath} in workspace`);
      button.addEventListener('click', () => {
        if (!activeWorkspace || button.disabled) return;
        void controller.openWorkspacePath(
          activeWorkspace,
          parentPath(artifact.relativePath),
        );
      });
      const metadata = rendererDocument.createElement('span');
      metadata.className = 'artifact-meta';
      metadata.textContent = `${artifact.change} · ${formatBytes(artifact.size)} · scanned`;
      item.append(button, metadata);
      artifactList.append(item);
    }
    if (visibleArtifacts.length === 0) {
      const empty = rendererDocument.createElement('li');
      empty.className = 'artifact-empty';
      empty.textContent = 'No changed files observed yet.';
      artifactList.append(empty);
    }
  }

  function renderEntries(listing: WorkspaceEntries): void {
    workspaceHeading.textContent = listing.workspace.name;
    pathLabel.textContent = displayPath(listing.relativePath);
    entriesList.replaceChildren();

    if (listing.entries.length === 0) {
      const emptyItem = rendererDocument.createElement('li');
      emptyItem.className = 'entry-empty';
      emptyItem.textContent = 'This directory is empty.';
      entriesList.append(emptyItem);
      updateControls();
      return;
    }

    for (const entry of listing.entries) {
      const item = rendererDocument.createElement('li');
      if (entry.kind === 'directory') {
        const button = rendererDocument.createElement('button');
        button.type = 'button';
        button.className = 'entry-button';
        button.textContent = `▸ ${entry.name}`;
        button.setAttribute('aria-label', `Open ${entry.name} directory`);
        button.addEventListener('click', () => {
          if (!button.disabled) {
            void controller.openWorkspacePath(listing.workspace, entry.relativePath);
          }
        });
        item.append(button);
      } else {
        item.className = 'entry-file';
        item.textContent = `${entry.kind === 'symlink' ? '↗' : '·'} ${entry.name}`;
      }
      entriesList.append(item);
    }
    updateControls();
  }

  function announceListing(listing: WorkspaceEntries): void {
    const path = displayPath(listing.relativePath);
    if (listing.entries.length === 0) {
      setWorkspaceStatus(`Opened ${path} — this directory is empty.`);
      return;
    }
    if (listing.truncated) {
      setWorkspaceStatus(`Opened ${path} — showing the first ${listing.entries.length} entries.`);
      return;
    }
    const suffix = listing.entries.length === 1 ? 'entry' : 'entries';
    setWorkspaceStatus(`Opened ${path} — ${listing.entries.length} ${suffix}.`);
  }

  function updateControls(): void {
    const provider = selectedAvailableProvider();
    const promptReady = promptInput.value.trim().length > 0
      && promptInput.value.trim().length <= 12_000;
    const active = workspaceSelectionLocked();

    workspacePanel.setAttribute('aria-busy', String(workspaceBusy));
    missionPanel.setAttribute(
      'aria-busy',
      String(missionPhase === 'preparing' || missionPhase === 'approving'),
    );
    selectButton.disabled = workspaceBusy || active || missionPhase === 'preparing';
    upButton.disabled = workspaceBusy || !activeWorkspace || activeRelativePath === '';
    entriesList.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.disabled = workspaceBusy;
    });
    artifactList.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
      button.disabled = workspaceBusy;
    });

    missionForm.hidden = !['editing', 'preparing'].includes(missionPhase);
    approvalPanel.hidden = missionPhase !== 'approval';
    executionPanel.hidden = !['approving', 'execution', 'terminal'].includes(missionPhase);
    reviewPanel.hidden = !['reviewing', 'applying'].includes(missionPhase);
    providerSelect.disabled = missionPhase !== 'editing' || !activeWorkspace;
    promptInput.disabled = missionPhase !== 'editing' || !activeWorkspace;
    prepareButton.disabled = missionPhase !== 'editing'
      || !activeWorkspace
      || !provider
      || !promptReady;
    approveButton.disabled = missionPhase !== 'approval';
    editMissionButton.disabled = missionPhase !== 'approval';
    stopButton.hidden = !isStoppableState(executionState) && executionState !== 'stopping';
    stopButton.disabled = stopRequestPending || executionState === 'stopping';
    stopButton.textContent = stopRequestPending || executionState === 'stopping'
      ? 'Stopping…'
      : 'Stop';
    newMissionButton.hidden = missionPhase !== 'terminal';
    applyReviewButton.disabled = missionPhase !== 'reviewing' || !activeReview;
    rejectReviewButton.disabled = missionPhase !== 'reviewing' || !activeReview;
    applyReviewButton.hidden = !activeReview;
    rejectReviewButton.hidden = !activeReview;
  }

  function beginWorkspaceOperation(message: string): number {
    const operation = ++workspaceOperationSequence;
    workspaceBusy = true;
    setWorkspaceStatus(message);
    updateControls();
    return operation;
  }

  function finishWorkspaceOperation(operation: number): void {
    if (!isCurrentWorkspaceOperation(operation)) return;
    workspaceBusy = false;
    updateControls();
  }

  function isCurrentWorkspaceOperation(operation: number): boolean {
    return operation === workspaceOperationSequence;
  }

  function resetMissionForWorkspace(): void {
    missionOperationSequence += 1;
    executionOperationSequence += 1;
    missionPhase = 'editing';
    activePreview = null;
    clearExecutionProjection();
    promptInput.value = '';
    executionSummary.textContent = '';
    setMissionStatus('Describe a mission for this authorized workspace.');
    updateControls();
  }

  function clearExecutionProjection(): void {
    activeExecutionId = null;
    executionState = null;
    executionError = null;
    treeTermination = 'not-required';
    lastExecutionSequence = 0;
    stopRequestPending = false;
    resyncPending = false;
    pendingEvents.clear();
    logs.clear();
    artifacts.clear();
    activeReview = null;
    reviewChangesList.replaceChildren();
    renderExecutionProjection();
  }

  function returnToMissionEditor(): void {
    if (missionPhase !== 'approval') return;
    missionOperationSequence += 1;
    activePreview = null;
    activeReview = null;
    missionPhase = 'editing';
    setMissionStatus('Mission was not approved. Edit it and prepare a new preview.');
    updateControls();
    promptInput.focus({ preventScroll: true });
  }

  function beginNewMission(): void {
    if (missionPhase !== 'terminal') return;
    missionOperationSequence += 1;
    executionOperationSequence += 1;
    activePreview = null;
    missionPhase = 'editing';
    clearExecutionProjection();
    promptInput.value = '';
    executionSummary.textContent = '';
    setMissionStatus('Describe the next mission for this workspace.');
    updateControls();
    promptInput.focus({ preventScroll: true });
  }

  function appendLog(entry: RuntimeLogEntry): void {
    if (!logs.has(entry.sequence)) logs.set(entry.sequence, entry);
    const bounded = boundedLogEntries([...logs.values()].sort((left, right) => (
      left.sequence - right.sequence
    )));
    const keep = new Set(bounded.map((item) => item.sequence));
    for (const sequence of logs.keys()) {
      if (!keep.has(sequence)) logs.delete(sequence);
    }
  }

  function selectedCatalogEntry() {
    return runtimeCatalog?.providers.find((entry) => entry.provider === providerSelect.value) ?? null;
  }

  function selectedAvailableProvider(): ProtocolLocalAgentProvider | null {
    const entry = selectedCatalogEntry();
    return entry?.available ? entry.provider : null;
  }

  function workspaceSelectionLocked(): boolean {
    return missionPhase === 'approving'
      || (activeExecutionId !== null && !isTerminalState(executionState));
  }

  function focusExecutionTransition(previousPhase: MissionPhase): void {
    if (previousPhase === missionPhase) return;
    if (missionPhase === 'execution' || missionPhase === 'terminal') {
      executionHeading.focus({ preventScroll: true });
    }
  }

  function setWorkspaceStatus(message: string): void {
    workspaceStatus.textContent = message;
  }

  function setMissionStatus(message: string): void {
    missionStatus.textContent = message;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    workspaceOperationSequence += 1;
    missionOperationSequence += 1;
    executionOperationSequence += 1;
    pendingEvents.clear();
    unsubscribeExecutionEvents();
  }
}

function isTerminalState(state: ProtocolLocalExecutionState | null): boolean {
  return state !== null && ['succeeded', 'failed', 'stopped', 'timed_out'].includes(state);
}

function isStoppableState(state: ProtocolLocalExecutionState | null): boolean {
  return state !== null && ['queued', 'starting', 'running'].includes(state);
}

function executionAnnouncement(state: ProtocolLocalExecutionState): string {
  return {
    queued: 'Execution queued by the Runtime.',
    starting: 'Agent process is starting.',
    running: 'Agent process is running.',
    stopping: 'Stopping. Waiting for process-tree confirmation…',
    succeeded: 'Execution completed.',
    failed: 'Execution failed.',
    stopped: 'Execution stopped.',
    timed_out: 'Execution timed out.',
  }[state];
}

function terminalAnnouncement(
  state: ProtocolLocalExecutionState,
  termination: RuntimeExecutionSnapshot['treeTermination'],
): string {
  if (state === 'stopped') {
    return termination === 'confirmed'
      ? 'Execution stopped and its process tree was terminated.'
      : 'Execution stopped, but complete process-tree termination could not be confirmed.';
  }
  return executionAnnouncement(state);
}

function stateLabel(
  state: ProtocolLocalExecutionState,
  termination: RuntimeExecutionSnapshot['treeTermination'],
): string {
  if (state === 'stopped' && termination === 'failed') return 'Stopped · cleanup unconfirmed';
  return humanize(state);
}

function boundedLogEntries(entries: RuntimeLogEntry[]): RuntimeLogEntry[] {
  const kept: RuntimeLogEntry[] = [];
  let characters = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (
      kept.length >= MAX_RENDERED_LOG_ENTRIES
      || characters + entry.text.length > MAX_RENDERED_LOG_CHARACTERS
    ) break;
    kept.push(entry);
    characters += entry.text.length;
  }
  return kept.reverse();
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function shortHash(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function displayPath(relativePath: string): string {
  return relativePath === '' ? '/' : `/${relativePath}`;
}

function parentPath(relativePath: string): string {
  if (relativePath === '') return '';
  return relativePath.split('/').slice(0, -1).join('/');
}

function providerLabel(provider: ProtocolLocalAgentProvider): string {
  return {
    codex: 'Codex',
    'claude-code': 'Claude Code',
    opencode: 'OpenCode',
  }[provider];
}

function humanize(value: string): string {
  return value
    .split(/[-_]/u)
    .map((part) => part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  return minutes >= 1 ? `${minutes} min` : `${Math.round(milliseconds / 1_000)} sec`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'soon'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatBytes(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

function optionElement(
  rendererDocument: Document,
  value: string,
  label: string,
  disabled: boolean,
): HTMLOptionElement {
  const option = rendererDocument.createElement('option');
  option.value = value;
  option.textContent = label;
  option.disabled = disabled;
  return option;
}

function requiredElement<T extends Element>(
  rendererDocument: Document,
  selector: string,
): T {
  const element = rendererDocument.querySelector<T>(selector);
  if (!element) throw new Error(`missing_renderer_element:${selector}`);
  return element;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.roundtableDesktop) {
  const mountedRenderer = mountDesktopRenderer(document, window.roundtableDesktop);
  window.addEventListener('pagehide', () => mountedRenderer.dispose(), { once: true });
}
