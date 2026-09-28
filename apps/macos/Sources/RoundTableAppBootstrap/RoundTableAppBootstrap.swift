#if SWIFT_PACKAGE
import RoundTableContracts
import RoundTableScene
#endif
import AppKit
import SwiftUI
import UserNotifications

@main
struct RoundTableAppBootstrap: App {
    @StateObject private var model = RoundTableDesktopModel()
    @StateObject private var replay = MissionReplayModel()
    @StateObject private var workflows = WorkflowLibraryModel()

    init() {
        BootstrapXPCSmoke.runIfRequested()
        RT.registerFonts()
    }

    var body: some Scene {
        WindowGroup {
            RoundTableDesktopView()
                .environmentObject(model)
                .environmentObject(replay)
                .environmentObject(workflows)
                .frame(minWidth: 900, minHeight: 620)
        }
        .windowStyle(.titleBar)
        // Wide enough for the sidebar, the conversation and one open panel.
        .defaultSize(width: 1360, height: 820)
        .commands {
            RoundTableCommands(model: model, replay: replay)
        }
    }
}

private enum DesktopSection: String, CaseIterable, Identifiable {
    case roundtable = "Roundtable"
    case workflow = "Workflow"
    case workspace = "Workspace"

    var id: String { rawValue }

    var subtitle: String {
        switch self {
        case .roundtable: "Your product squad is ready when you are."
        case .workflow: "Inspect the fixture workflow and its stages."
        case .workspace: "Choose a project and inspect runtime availability."
        }
    }
}

private enum DesktopInspectorTab: String, CaseIterable, Identifiable {
    case files = "Files"
    case notes = "Notes"
    case skills = "Skills"
    case memory = "Memory"

    var id: String { rawValue }
}

/// A page that opens beside the table instead of replacing it, the way Codex
/// opens a document in its right pane.
private enum DesktopPanel: Equatable {
    case newMission
    /// The room itself: opened from the composer's workbench chip.
    case roundtable
    case inspector
    case file(MissionFile)

    var width: CGFloat {
        switch self {
        case .newMission: 470
        case .roundtable: 520
        case .inspector: 392
        case .file: 560
        }
    }
}

/// Window-level state that is not mission data: navigation, the selected
/// workspace, the New Mission draft and notification opt-in. Mission data
/// comes from `MissionReplayModel` (the TurnSource).
@MainActor
private final class RoundTableDesktopModel: ObservableObject {
    @Published var section: DesktopSection = .roundtable
    @Published var workspaceName = "Round_Table Demo Workspace"
    @Published var workspaceLocation = "Built-in fixture · no files are read"
    @Published var isFixtureWorkspace = true
    @Published var prompt = ""
    @Published var notice = "Host Runtime unavailable · fixture mode only"
    @Published var workspaceGrantVerified = false
    @Published var isWorkspaceGrantPending = false
    @Published var notificationStatus = "Not requested"
    private var notificationsAllowed = false
    private let runtime = HostRuntimeClient()
    private var workspaceSelectionID = UUID()

    init() {
        // The executable's smoke modes own the sole XPC connection and exit;
        // an ordinary UI status probe would replace that connection mid-test.
        if ProcessInfo.processInfo.environment["ROUNDTABLE_BOOTSTRAP_XPC_SMOKE"] == nil {
            Task { await refreshRuntimeStatus() }
        }
    }

    var runtimeVersion: Int { MacOSServiceUIDV1Generated.version }

    func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.title = "Choose a workspace"
        panel.message = "Round Table will grant its authenticated Host Runtime read-only access to this folder."
        panel.prompt = "Choose Workspace"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        workspaceName = url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent
        workspaceLocation = url.path
        isFixtureWorkspace = false
        workspaceGrantVerified = false
        isWorkspaceGrantPending = true
        notice = "Verifying read-only workspace grant…"
        section = .workspace

        let selectionID = UUID()
        workspaceSelectionID = selectionID
        runtime.invalidate()
        do {
            let bookmark = try url.bookmarkData(
                options: [.withSecurityScope, .securityScopeAllowOnlyReadAccess],
                includingResourceValuesForKeys: nil, relativeTo: nil)
            let displayName = Self.safeDisplayName(workspaceName)
            Task {
                do {
                    let workspace = try await runtime.registerWorkspace(
                        bookmarkData: bookmark, displayName: displayName)
                    guard workspaceSelectionID == selectionID else { return }
                    workspaceName = workspace.name
                    workspaceGrantVerified = true
                    isWorkspaceGrantPending = false
                    notice = "Host Runtime connected · read-only grant verified · \(workspace.entryCount) root entries"
                } catch {
                    guard workspaceSelectionID == selectionID else { return }
                    runtime.invalidate()
                    workspaceGrantVerified = false
                    isWorkspaceGrantPending = false
                    notice = "Workspace grant rejected · \(Self.stableRuntimeError(error))"
                }
            }
        } catch {
            runtime.invalidate()
            workspaceGrantVerified = false
            isWorkspaceGrantPending = false
            notice = "Workspace grant could not be created"
        }
    }

    func restoreFixtureWorkspace() {
        workspaceSelectionID = UUID()
        runtime.invalidate()
        workspaceName = "Round_Table Demo Workspace"
        workspaceLocation = "Built-in fixture · no files are read"
        isFixtureWorkspace = true
        workspaceGrantVerified = false
        isWorkspaceGrantPending = false
        notice = "Host Runtime unavailable · fixture mode only"
        section = .workspace
    }

    private func refreshRuntimeStatus() async {
        do {
            let status = try await runtime.status()
            guard isFixtureWorkspace else { return }
            notice = status.state == "ready"
                ? "Host Runtime connected · choose a workspace to grant read-only access"
                : "Host Runtime unavailable · \(status.state)"
        } catch {
            guard isFixtureWorkspace else { return }
            notice = "Host Runtime unavailable · fixture mode only"
        }
    }

    private static func safeDisplayName(_ value: String) -> String {
        let flattened = value
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespaces)
        let source = flattened.isEmpty ? "Selected Workspace" : flattened
        var bounded = ""
        for character in source {
            let candidate = bounded + String(character)
            guard candidate.utf8.count <= 255 else { break }
            bounded = candidate
        }
        return bounded
    }

    private static func stableRuntimeError(_ error: Error) -> String {
        (error as? HostRuntimeClientError)?.description ?? "runtime request failed"
    }

    /// Bumped when something outside the view asks for New Mission (the ⇧⌘N
    /// command); the window opens the right-hand panel in response.
    @Published private(set) var newMissionRequests = 0

    func startNewMission(goal: String) {
        prompt = goal
        newMissionRequests += 1
    }

    func enableNotifications() {
        Task {
            do {
                notificationsAllowed = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound])
                notificationStatus = notificationsAllowed ? "Enabled" : "Permission denied"
            } catch {
                notificationsAllowed = false
                notificationStatus = "Unavailable"
            }
        }
    }

    /// Posts a completion notification when the user opted in.
    func notify(title: String, body: String) {
        guard notificationsAllowed else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
    }
}

private struct RoundTableDesktopView: View {
    @EnvironmentObject private var model: RoundTableDesktopModel
    @EnvironmentObject private var replay: MissionReplayModel
    @EnvironmentObject private var workflows: WorkflowLibraryModel
    @State private var inspectorTab: DesktopInspectorTab = .files
    @State private var panel: DesktopPanel?
    /// New Mission shows the starter without discarding the running mission,
    /// which stays in the sidebar until it is reopened.
    @State private var showingStarter = false
    @State private var zoomingWhiteboard = false
    /// The agent the conversation composer is addressing; nil is the table.
    @State private var composerTarget: String?
    /// What an opened file returns to when it is closed.
    @State private var panelBeforeFile: DesktopPanel?
    @State private var dismissedRecommendation: String?
    @AppStorage("appearance") private var appearance = AppearancePreference.system.rawValue
    @State private var selectedWorkflowTemplate = "Feature Builder"
    #if DEBUG
    // Screenshot runs cannot move the pointer; this pins the hover card open.
    @State private var titleHovered = ProcessInfo.processInfo.environment["ROUNDTABLE_DEBUG_HOVER_TITLE"] == "1"
    #else
    @State private var titleHovered = false
    #endif

    var body: some View {
        HStack(spacing: 0) {
            WorkbenchSidebar(
                selection: Binding(
                    get: {
                        switch model.section {
                        case .workflow: .workflow
                        case .workspace: .workspace
                        default: .roundtable
                        }
                    },
                    set: { model.section = $0 == .workflow ? .workflow : $0 == .workspace ? .workspace : .roundtable }
                ),
                members: replay.agents.ordered,
                mission: replay.summary,
                missionActive: model.section == .roundtable && !showingStarter,
                workspaceName: model.workspaceName,
                runtimeNotice: replay.isSynthetic ? "synthetic live activity · \(model.notice)"
                    : model.notice,
                onNewMission: startNewMission,
                onOpenMission: {
                    showingStarter = false
                    model.section = .roundtable
                },
                onOpenWorkspace: { model.section = .workspace }
            )
            Group {
                switch model.section {
                case .roundtable: roundtablePage
                case .workflow:
                    WorkflowEditorView(model: workflows, agents: replay.agents,
                                       runningId: replay.isRunning ? replay.workflow?.id : nil)
                case .workspace:
                    ScrollView {
                        VStack(alignment: .leading, spacing: 24) {
                            pageHeader
                            workspacePage
                        }
                        .frame(maxWidth: 900, alignment: .leading)
                        .padding(.horizontal, 34)
                        .padding(.vertical, 30)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    }
                    .background(RT.bg)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if let panel {
                panelColumn(panel)
                    .frame(width: panel.width)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(.easeOut(duration: 0.2), value: panel)
        .overlay {
            if zoomingWhiteboard {
                WhiteboardZoomView(scene: replay.scene, agents: replay.agents) { zoomingWhiteboard = false }
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.18), value: zoomingWhiteboard)
        .onAppear { (AppearancePreference(rawValue: appearance) ?? .system).apply() }
        .onChange(of: appearance) { (AppearancePreference(rawValue: $0) ?? .system).apply() }
        #if DEBUG
        .onAppear { applyDebugView() }
        .onChange(of: replay.files.count) { _ in applyDebugView() }
        #endif
        .background(RT.bg)
        // Starting a mission opens the chat, as on the Web.
        .onChange(of: replay.latestTurn?.id) { id in
            guard id != nil else { return }
            showingStarter = false
            model.section = .roundtable
        }
        .onChange(of: model.newMissionRequests) { _ in startNewMission() }
        .onChange(of: replay.awaiting) { gate in
            if gate == .deliveryDecision {
                model.notify(title: "Mission ready for delivery", body: "The replayed run finished. Review it in Chat.")
            }
        }
        .tint(RT.accent)
    }

    #if DEBUG
    /// Screenshot runs: ROUNDTABLE_DEBUG_SECTION, ROUNDTABLE_DEBUG_INSPECTOR and
    /// ROUNDTABLE_DEBUG_OPEN_FILE select a view once the replay has produced files.
    private func applyDebugView() {
        let env = ProcessInfo.processInfo.environment
        switch env["ROUNDTABLE_DEBUG_SECTION"] {
        case "workflow": model.section = .workflow
        case "workspace": model.section = .workspace
        default: break
        }
        if let tab = env["ROUNDTABLE_DEBUG_INSPECTOR"].flatMap({ DesktopInspectorTab(rawValue: $0.capitalized) }) {
            inspectorTab = tab
            panel = .inspector
        }
        if env["ROUNDTABLE_DEBUG_ZOOM_WHITEBOARD"] == "1", !replay.turns.isEmpty { zoomingWhiteboard = true }
        if let agentId = env["ROUNDTABLE_DEBUG_TARGET"], replay.agents[agentId] != nil { composerTarget = agentId }
        // Captures cannot click New Mission; this reaches the same state.
        if env["ROUNDTABLE_DEBUG_STARTER"] == "1", !replay.turns.isEmpty { showingStarter = true }
        switch env["ROUNDTABLE_DEBUG_PANEL"] {
        case "mission": panel = .newMission
        case "roundtable": panel = .roundtable
        default: break
        }
        if let name = env["ROUNDTABLE_DEBUG_OPEN_FILE"], let file = replay.files.first(where: { $0.name == name }) {
            showFile(file)
        }
    }
    #endif

    private var pageHeader: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(model.section.rawValue)
                .font(RT.ui(30, weight: .bold))
                .accessibilityAddTraits(.isHeader)
            Text(model.section.subtitle)
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var roundtablePage: some View {
        if replay.turns.isEmpty || showingStarter {
            missionStarter
        } else {
            missionConversation
        }
    }

    /// Before the first mission the workbench asks what to build, as Codex does,
    /// instead of the Web's welcome card floating over the table.
    private var missionStarter: some View {
        MissionStarterView(
            workbenchName: "Product Squad",
            templateName: replay.fixtureWorkflowName,
            goal: replay.fixtureGoal,
            cards: [
                .init(id: "feature-builder", symbol: "hammer", title: replay.fixtureWorkflowName,
                      detail: "Turn a request into a planned, implemented, reviewed and reportable feature.",
                      available: replay.canStart),
                .init(id: "bug-fixer", symbol: "ladybug", title: "Bug Fixer",
                      detail: "Diagnose a bug, patch it, verify the fix and summarize residual risk.",
                      available: false),
                .init(id: "codebase-onboarding", symbol: "map", title: "Codebase Onboarding",
                      detail: "Understand an unfamiliar repo, map architecture and propose starter tasks.",
                      available: false),
            ],
            onPick: { _ in openMissionDetails() },
            onStart: {
                showingStarter = false
                replay.start()
            },
            onOpenTeam: { panel = .roundtable },
            onOpenTemplate: { model.section = .workflow }
        )
    }

    /// The running mission reads as a conversation; the room is a panel you open.
    /// Header, banner, thread and composer share one column so they line up.
    private var missionConversation: some View {
        VStack(spacing: 0) {
            conversationHeader
                .zIndex(1)
            if let summary = replay.summary, let recommendation = WorkflowRecommendation.recommend(task: summary.title),
               dismissedRecommendation != summary.id {
                RecommendationBanner(recommendation: recommendation) { dismissedRecommendation = summary.id }
                    .padding(.top, 8)
            }
            // The composer floats over the thread: the conversation runs on
            // underneath it and fades out instead of being cut off.
            ZStack(alignment: .bottom) {
                // The same fade at the top, where the thread passes under the
                // header and the banner.
                VStack(spacing: 0) {
                    LinearGradient(colors: [RT.bg, RT.bg.opacity(0)], startPoint: .top, endPoint: .bottom)
                        .frame(height: 20)
                    Spacer(minLength: 0)
                }
                .allowsHitTesting(false)
                .zIndex(1)
                MissionChatView(thread: replay.thread, approving: replay.approving,
                                onApprove: replay.approvePlan, onDecide: replay.decideDelivery,
                                anchorToBottom: replay.chatAnchorsToBottom,
                                bottomInset: 132)
                LinearGradient(colors: [RT.bg.opacity(0), RT.bg], startPoint: .top, endPoint: .bottom)
                    .frame(height: 56)
                    .allowsHitTesting(false)
                    .padding(.bottom, 132)
                let target = composerTarget.flatMap { replay.agents[$0] }
                MissionComposer(workbenchName: "Product Squad", templateName: replay.fixtureWorkflowName,
                                text: target.map { "Message \($0.displayName) directly…" }
                                    ?? "Message the table…  use @ to bring in an agent",
                                isPlaceholder: true,
                                hint: target.map { "Replay · talking to \($0.displayName) needs the Host Runtime" }
                                    ?? "Replay · new messages need the Host Runtime",
                                // A direct message cannot start a mission; it waits for the runtime.
                                sendEnabled: target == nil,
                                target: target,
                                agents: replay.agents.ordered,
                                onTarget: { composerTarget = $0?.agentId },
                                onTeam: { panel = .roundtable },
                                onTemplate: { model.section = .workflow },
                                onSend: startNewMission)
                    // Background after the padding, so nothing shows through
                    // the gap under the composer.
                    .padding(.bottom, 16)
                    .background(RT.bg)
                    .zIndex(2)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: 900)
        // Chat cards stop being readable below this; a panel that does not fit
        // beside the conversation widens the window rather than crushing it.
        .frame(minWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
        .background(RT.bg)
    }

    /// The mission's short name on the left, the run's workflow on the right.
    private var conversationHeader: some View {
        HStack(spacing: 14) {
            if let goal = replay.latestTurn?.message {
                // The workflow keeps its width; the goal gives way and truncates.
                // `.help` never fired here, so hovering shows the full goal itself.
                Text(goal)
                    .font(RT.ui(13, weight: .semibold)).foregroundStyle(RT.textMuted)
                    .lineLimit(1).truncationMode(.tail)
                    .frame(minWidth: 0, maxHeight: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .onHover { titleHovered = $0 }
                    .overlay(alignment: .topLeading) {
                        if titleHovered {
                            Text(goal)
                                .font(RT.ui(12)).foregroundStyle(RT.text)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: 420, alignment: .leading)
                                .padding(.horizontal, 10).padding(.vertical, 8)
                                .background(RT.surface2, in: RoundedRectangle(cornerRadius: 8))
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.border))
                                .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
                                .offset(y: 30)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityLabel(goal)
                    .accessibilityIdentifier("conversation.title")
            }
            Spacer(minLength: 0)
            if let workflow = replay.workflow {
                ViewThatFits(in: .horizontal) {
                    WorkflowStripView(workflow: workflow, run: replay.workflowRun) { model.section = .workflow }
                    WorkflowStripView(workflow: workflow, run: replay.workflowRun, compact: true) { model.section = .workflow }
                }
                .layoutPriority(1)
            }
        }
        .frame(height: 34)
        .padding(.top, 12)
    }

    /// The room, opened beside the conversation from the workbench chip.
    private var roundtablePanel: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "square.3.layers.3d").font(RT.ui(12)).foregroundStyle(RT.accent)
                Text("Roundtable").font(RT.ui(13, weight: .semibold)).foregroundStyle(RT.text)
                Text("· Product Squad").font(RT.ui(11.5)).foregroundStyle(RT.textFaint)
                Spacer(minLength: 0)
                Button { panel = nil } label: {
                    Image(systemName: "xmark").font(RT.ui(11, weight: .medium)).foregroundStyle(RT.textMuted)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help("Close panel")
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(RT.surface)
            Rectangle().fill(RT.border).frame(height: 1)
            RoundtableStageView(scene: replay.scene, agents: replay.agents,
                                onOpenCodeLogs: {
                                    inspectorTab = .files
                                    panel = .inspector
                                },
                                onZoomWhiteboard: { zoomingWhiteboard = true })
            // The Web keeps this line in its dock; here it belongs to the room.
            DockStatusLine(scene: replay.scene, agents: replay.agents, pending: replay.latestTurn?.status == "pending")
                .padding(.horizontal, 16).padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RT.surface)
                .overlay(alignment: .top) { Rectangle().fill(RT.border).frame(height: 1) }
        }
        .overlay(alignment: .leading) { Rectangle().fill(RT.border).frame(width: 1) }
        .accessibilityIdentifier("roundtable.panel")
    }

    private func inspectorTitle(_ tab: DesktopInspectorTab) -> String {
        tab == .files ? "Files · \(replay.files.count)" : tab.rawValue
    }

    private var inspectorPanel: some View {
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                ForEach(DesktopInspectorTab.allCases) { tab in
                    Button { inspectorTab = tab } label: {
                        Text(inspectorTitle(tab))
                            .font(RT.ui(12.5, weight: inspectorTab == tab ? .semibold : .medium))
                            .foregroundStyle(inspectorTab == tab ? RT.text : RT.textFaint)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .overlay(alignment: .bottom) {
                                Rectangle().fill(inspectorTab == tab ? RT.accent : .clear).frame(height: 2)
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("inspector.\(tab.rawValue.lowercased())")
                }
                Button { panel = nil } label: {
                    Image(systemName: "xmark").font(RT.ui(11, weight: .medium)).foregroundStyle(RT.textMuted)
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help("Close panel")
                .accessibilityIdentifier("inspector.close")
            }
            .padding(.horizontal, 8)
            .background(RT.surface)
            Rectangle().fill(RT.border).frame(height: 1)

            Group {
                switch inspectorTab {
                case .files: FilesPanel(files: replay.files) { showFile($0) }
                case .notes: NotesPanel(files: replay.files)
                case .skills: inspectorEmpty("Skills", symbol: "wrench.and.screwdriver", message: "Provider skills remain unavailable until Host Runtime is connected.")
                case .memory: inspectorEmpty("Memory", symbol: "brain.head.profile", message: "No workspace memory is loaded in fixture mode.")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(RT.surface2)
        .overlay(alignment: .leading) { Rectangle().fill(RT.border).frame(width: 1) }
        .accessibilityIdentifier("inspector.panel")
    }

    private func inspectorEmpty(_ title: String, symbol: String, message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(RT.ui(24))
                .foregroundStyle(RT.accent)
            Text(title).font(RT.ui(13, weight: .semibold))
            Text(message)
                .font(RT.ui(10)).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
    }

    private var workspacePage: some View {
        VStack(alignment: .leading, spacing: 18) {
            Card {
                HStack(alignment: .top, spacing: 16) {
                    Image(systemName: "folder.fill")
                        .font(RT.ui(26))
                        .foregroundStyle(.blue)
                        .frame(width: 46, height: 46)
                        .background(.blue.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                    VStack(alignment: .leading, spacing: 6) {
                        Text(model.workspaceName).font(.headline)
                        Text(model.workspaceLocation)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        Label(
                            model.isFixtureWorkspace ? "Fixture workspace" :
                                (model.workspaceGrantVerified ? "Read-only grant verified" :
                                    (model.isWorkspaceGrantPending ? "Verifying read-only grant" : "Grant unavailable")),
                            systemImage: model.isFixtureWorkspace ? "sparkles" :
                                (model.workspaceGrantVerified ? "checkmark.shield.fill" : "folder.badge.questionmark")
                        )
                            .font(.caption.weight(.medium))
                            .foregroundStyle(model.isFixtureWorkspace ? .purple :
                                (model.workspaceGrantVerified ? .green : .secondary))
                    }
                    Spacer()
                }
            }

            HStack(spacing: 12) {
                Button(action: model.chooseWorkspace) {
                    Label("Choose Workspace…", systemImage: "folder.badge.plus")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isWorkspaceGrantPending)
                .accessibilityHint("Select a folder and transfer a single-use, read-only security-scoped bookmark to the authenticated Host Runtime.")

                Button("Restore Demo Workspace", action: model.restoreFixtureWorkspace)
                    .buttonStyle(.bordered)
            }

            Card {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Runtime status", systemImage: "lock.shield")
                        .font(.headline)
                    LabeledContent("Control protocol", value: MacOSServiceUIDV1Generated.contract)
                    LabeledContent("Protocol version", value: String(model.runtimeVersion))
                    LabeledContent("Workspace access", value: model.workspaceGrantVerified ? "Verified · read-only" : "Closed")
                    LabeledContent("Completion notifications", value: model.notificationStatus)
                    Button("Enable Completion Notifications…", action: model.enableNotifications)
                        .buttonStyle(.bordered)
                        .accessibilityHint("Ask macOS to allow a notification when a fixture mission is approved or rejected.")
                    Text(model.workspaceGrantVerified
                         ? "The embedded Host Runtime resolved the user-selected security-scoped bookmark and listed the workspace root. This grant is read-only and connection-scoped; it does not authorize a provider run or changes to the workspace."
                         : "Workspace access remains closed until the embedded Host Runtime authenticates this App, resolves a user-selected read-only bookmark, and verifies a root listing. Provider execution remains unavailable in this S3 slice.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            primaryAction("Open recorded mission", symbol: "arrow.right", action: startNewMission)
        }
    }

    /// New Mission as a right-hand page: the table stays where it is.
    private var newMissionColumn: some View {
        ScrollView {
            newMissionPanel
        }
        .background(RT.surface2)
        .overlay(alignment: .leading) { Rectangle().fill(RT.border).frame(width: 1) }
        .accessibilityIdentifier("mission.panel")
        .onAppear {
            selectedWorkflowTemplate = replay.fixtureWorkflowName
            model.prompt = replay.fixtureGoal
        }
    }

    private var newMissionPanel: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Image(systemName: "plus")
                    .font(RT.ui(18, weight: .medium))
                    .foregroundStyle(RT.accent)
                    .frame(width: 42, height: 42)
                    .background(RT.surface2, in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 4) {
                    Text("New Mission").font(RT.ui(20, weight: .bold))
                    Text("This S2 build replays the recorded Feature Builder mission shown below")
                        .font(RT.ui(12)).foregroundStyle(RT.textFaint)
                }
                Spacer()
                Button { panel = nil } label: {
                    Image(systemName: "xmark").font(RT.ui(14, weight: .medium)).frame(width: 34, height: 34)
                }
                .buttonStyle(.plain)
                .background(RT.surface, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.borderStrong))
                .accessibilityLabel("Close New Mission")
            }
            .padding(22)

            Divider()

            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("Recorded replay").font(RT.ui(11, weight: .semibold)).foregroundStyle(RT.accent)
                    Spacer()
                    Text("Host Runtime required for custom missions").font(RT.ui(10)).foregroundStyle(RT.textFaint)
                }
                .padding(10)
                .background(RT.surface3, in: RoundedRectangle(cornerRadius: 8))

                Text("Mission goal").font(RT.ui(12, weight: .semibold)).foregroundStyle(RT.textMuted)
                Text(model.prompt)
                    .font(RT.ui(13))
                    .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
                    .padding(12)
                    .background(RT.surface2, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(RT.borderStrong))
                    .accessibilityLabel("Recorded mission goal")
                    .accessibilityIdentifier("mission.prompt.recorded")

                Button { } label: {
                    Label("Polish with AI", systemImage: "sparkles")
                        .font(RT.ui(11, weight: .medium))
                        .padding(.horizontal, 11).padding(.vertical, 7)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .background(RT.surface, in: Capsule())
                .overlay(Capsule().stroke(RT.border))
                .disabled(true)
                .help("Unavailable while Host Runtime is offline")

                HStack(spacing: 8) {
                    missionSuggestion("Waitlist flow")
                    missionSuggestion("Auth settings")
                    missionSuggestion("Checkout flow")
                }

                Text("Workflow template").font(RT.ui(12, weight: .semibold)).foregroundStyle(RT.textMuted).padding(.top, 4)
                HStack(alignment: .top, spacing: 10) {
                    missionTemplate("Feature Builder", tag: "Recorded", description: "Replay the bundled planned, implemented, reviewed, and reportable feature.", available: true)
                    missionTemplate("Bug Fixer", tag: "Unavailable", description: "Requires the authenticated Host Runtime and a recorded or live mission source.", available: false)
                    missionTemplate("Codebase Onboarding", tag: "Unavailable", description: "Requires the authenticated Host Runtime and a recorded or live mission source.", available: false)
                }

                missionPipeline

                VStack(alignment: .leading, spacing: 11) {
                    HStack(spacing: 8) {
                        Text("Mission team").font(RT.ui(12, weight: .semibold))
                        Label("routed by capabilities, then by role fallback", systemImage: "eye")
                            .font(RT.ui(10)).foregroundStyle(RT.textFaint)
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            missionMember("planning", name: "Planning")
                            missionMember("mira", name: "Mira")
                            missionMember("atlas", name: "Atlas")
                            missionMember("beam", name: "Beam")
                            missionMember("vera", name: "Vera")
                            missionMember("nova", name: "Nova")
                            missionMember("fixer", name: "Fixer")
                        }
                    }
                }
                .padding(14)
                .background(RT.surface2, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(RT.border))
            }
            .padding(22)

            Divider()

            HStack(spacing: 12) {
                Spacer()
                Button("Cancel") { panel = nil }
                    .buttonStyle(.bordered)
                Button("Start Mission") {
                    showingStarter = false
                    replay.start()
                    model.section = .roundtable
                    panel = nil
                }
                    .buttonStyle(.borderedProminent)
                    .disabled(!replay.canStart)
                    .accessibilityHint("Replays the recorded mission on the table. No provider process starts.")
                    .accessibilityIdentifier("mission.prepare")
            }
            .padding(18)
            .background(RT.surface2)
        }
        .background(RT.surface)
    }

    private func missionSuggestion(_ title: String) -> some View {
        Button(title) { }
            .buttonStyle(.plain)
            .font(RT.ui(11))
            .foregroundStyle(RT.textMuted)
            .padding(.horizontal, 11).padding(.vertical, 6)
            .background(RT.surface, in: Capsule())
            .overlay(Capsule().stroke(RT.borderStrong))
            .disabled(true)
            .help("Custom mission goals require the authenticated Host Runtime")
    }

    private func missionTemplate(_ name: String, tag: String, description: String, available: Bool) -> some View {
        let selected = selectedWorkflowTemplate == name
        return Button { selectedWorkflowTemplate = name } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Text(name).font(RT.ui(12, weight: .bold)).lineLimit(1)
                    Text(tag).font(RT.ui(9, weight: .bold)).foregroundStyle(RT.accent)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(RT.surface3, in: RoundedRectangle(cornerRadius: 4))
                }
                Text(description).font(RT.ui(10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(12).frame(maxWidth: .infinity, minHeight: 105, alignment: .topLeading)
            .background(RT.surface2, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(selected ? RT.accent : RT.border, lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
        .disabled(!available)
        .help(available ? "Bundled recorded replay" : "Requires the authenticated Host Runtime")
    }

    private var missionPipeline: some View {
        let stages: [(String, String)] = selectedWorkflowTemplate == "Bug Fixer"
            ? [("Diagnose", "magnifyingglass"), ("Patch", "wrench"), ("Verify", "eye"), ("Report", "paperplane")]
            : selectedWorkflowTemplate == "Codebase Onboarding"
                ? [("Map", "square.3.layers.3d"), ("Check", "eye"), ("Next tasks", "paperplane")]
                : [("Clarify", "magnifyingglass"), ("Plan", "square.3.layers.3d"), ("Build", "chevron.left.forwardslash.chevron.right"), ("Review", "eye"), ("Repair", "wrench"), ("Delivery", "paperplane")]
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(stages.enumerated()), id: \.offset) { index, stage in
                    if index > 0 { Image(systemName: "chevron.right").font(RT.ui(9)).foregroundStyle(.tertiary) }
                    Label(stage.0, systemImage: stage.1)
                        .font(RT.ui(11, weight: .medium))
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(RT.surface, in: Capsule())
                        .overlay(Capsule().stroke(RT.borderStrong))
                }
            }
            .padding(13)
        }
        .background(RT.surface2, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(RT.border))
    }

    private func missionMember(_ assetName: String, name: String) -> some View {
        HStack(spacing: 7) {
            RoundtableAvatarMark(assetName: assetName, name: name, fallbackColor: RT.accent, size: 23)
            Text(name).font(RT.ui(11))
        }
        .padding(.leading, 4).padding(.trailing, 10).padding(.vertical, 4)
        .background(RT.surface, in: Capsule())
        .overlay(Capsule().stroke(RT.borderStrong))
    }

    private func primaryAction(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .frame(minHeight: 20)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityHint("This opens the local fixture flow. It does not launch a provider.")
    }

    /// New Mission: shows the starter, the way Codex's New chat clears the
    /// window. The current mission keeps running and stays in the sidebar.
    private func startNewMission() {
        showingStarter = true
        model.section = .roundtable
        panel = nil
    }

    /// A starter card opens the pre-filled mission details beside the starter.
    private func openMissionDetails() {
        selectedWorkflowTemplate = replay.fixtureWorkflowName
        model.prompt = replay.fixtureGoal
        panel = .newMission
    }

    /// Files open in the same right-hand column and return to what was there.
    private func showFile(_ file: MissionFile) {
        if case .file = panel {} else { panelBeforeFile = panel }
        panel = .file(file)
    }

    @ViewBuilder
    private func panelColumn(_ panel: DesktopPanel) -> some View {
        switch panel {
        case .newMission: newMissionColumn
        case .roundtable: roundtablePanel
        case .inspector: inspectorPanel
        case .file(let file):
            ArtifactPanel(file: file, agents: replay.agents) {
                self.panel = panelBeforeFile
                panelBeforeFile = nil
            }
        }
    }

}

private struct RoundtableLogoMark: View {
    let size: CGFloat
    let color: Color

    var body: some View {
        ZStack {
            Ellipse().fill(color).frame(width: size, height: size * 0.5)
            Ellipse().trim(from: 0.05, to: 0.45)
                .stroke(color.opacity(0.45), style: StrokeStyle(lineWidth: size * 0.12, lineCap: .round))
                .frame(width: size, height: size * 0.5)
                .offset(y: size * 0.08)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct RoundtableAvatarMark: View {
    let assetName: String
    let name: String
    let fallbackColor: Color
    let size: CGFloat

    var body: some View {
        Group {
            if let url = Bundle.main.url(forResource: assetName, withExtension: "png"), let image = NSImage(contentsOf: url) {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                Text(String(name.prefix(1))).font(RT.ui(size * 0.34, weight: .bold)).foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(fallbackColor)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().stroke(RT.surface.opacity(0.95), lineWidth: 1.5))
        .help(name)
        .accessibilityLabel(name)
    }
}

private struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.background, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(.quaternary, lineWidth: 1))
    }
}

/// The Web's theme toggle; "system" follows macOS.
enum AppearancePreference: String, CaseIterable {
    case system, light, dark

    var title: String { rawValue.capitalized }

    @MainActor func apply() {
        NSApp.appearance = switch self {
        case .system: nil
        case .light: NSAppearance(named: .aqua)
        case .dark: NSAppearance(named: .darkAqua)
        }
    }
}

private struct RoundTableCommands: Commands {
    @ObservedObject var model: RoundTableDesktopModel
    @ObservedObject var replay: MissionReplayModel
    @AppStorage("appearance") private var appearance = AppearancePreference.system.rawValue

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Mission") { model.startNewMission(goal: replay.fixtureGoal) }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            Divider()
            Button("Choose Workspace…", action: model.chooseWorkspace)
                .keyboardShortcut("o", modifiers: .command)
            Button("Restore Demo Workspace", action: model.restoreFixtureWorkspace)
        }
        CommandGroup(after: .toolbar) {
            Picker("Appearance", selection: $appearance) {
                ForEach(AppearancePreference.allCases, id: \.rawValue) { Text($0.title).tag($0.rawValue) }
            }
        }
        CommandMenu("Mission") {
            Button("Start Building", action: replay.approvePlan)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!replay.canApprovePlan)
            Button("Accept Delivery") { replay.decideDelivery("accept") }
                .disabled(!replay.canDecideDelivery)
            Divider()
            Picker("Replay Source", selection: $replay.source) {
                ForEach(MissionReplayModel.Source.allCases, id: \.self) { Text($0.title).tag($0) }
            }
        }
        CommandGroup(after: .windowArrangement) {
            Divider()
            Button("Show Roundtable") { model.section = .roundtable }
                .keyboardShortcut("1", modifiers: .command)
            Button("Show Workflow") { model.section = .workflow }
                .keyboardShortcut("2", modifiers: .command)
            Button("Show Workspace") { model.section = .workspace }
                .keyboardShortcut("3", modifiers: .command)
        }
    }
}
