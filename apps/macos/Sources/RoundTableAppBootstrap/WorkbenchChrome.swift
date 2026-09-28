#if SWIFT_PACKAGE
import RoundTableScene
#endif
import SwiftUI

// Window chrome ported from the Web: the sidebar (`ConversationRail`, which
// also carries the Web `TopBar`'s runtime status), the inspector's Files and
// Notes tabs, the artifact drawer (`Drawer`), the workflow recommendation
// banner and a read-only Workflow view. Content comes from `RoundTableScene`.

// MARK: - Sidebar

/// Sidebar destinations. `newMission` is an action row, not a destination.
enum SidebarDestination: String {
    case newMission, roundtable, workflow, workspace
}


struct WorkbenchSidebar: View {
    @State private var showWorkbenches = false
    /// Which destination the main area shows; the Web keeps this in a top switcher.
    @Binding var selection: SidebarDestination
    let members: [SceneAgent]
    let mission: MissionSummary?
    let missionActive: Bool
    let workspaceName: String
    /// What the desktop can honestly claim about execution right now.
    let runtimeNotice: String
    var onNewMission: () -> Void = {}
    var onOpenMission: () -> Void = {}
    var onOpenWorkspace: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                LogoMark(size: 26)
                Text("Roundtable").font(RT.ui(16, weight: .bold)).foregroundStyle(RT.text)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 10)

            VStack(spacing: 1) {
                navRow(.newMission, symbol: "square.and.pencil", title: "New Mission", accent: true) { onNewMission() }
                navRow(.roundtable, symbol: "square.3.layers.3d", title: "Roundtable") { selection = .roundtable }
                navRow(.workflow, symbol: "sparkle", title: "Workflow") { selection = .workflow }
                navRow(.workspace, symbol: "folder", title: "Workspace") { selection = .workspace }
            }
            .padding(.horizontal, 8).padding(.bottom, 14)

            Text("WORKBENCH").font(RT.ui(10, weight: .semibold)).tracking(0.9).foregroundStyle(RT.textFaint)
                .padding(.horizontal, 16).padding(.bottom, 6)

            // A macOS Menu cannot take the Web card styling, so the switcher is a button with a popover.
            Button { showWorkbenches.toggle() } label: {
                HStack(spacing: 9) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Product Squad").font(RT.ui(13, weight: .semibold)).foregroundStyle(RT.text)
                        Text("workbench · \(members.count) members").font(RT.ui(10.5)).foregroundStyle(RT.textFaint)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.down").font(RT.ui(10, weight: .semibold)).foregroundStyle(RT.textFaint)
                }
                .padding(.horizontal, 11).padding(.vertical, 9)
                .background(RT.surface2, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.border))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showWorkbenches, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("Product Squad").font(RT.ui(13))
                        Spacer()
                        Image(systemName: "checkmark").font(RT.ui(11, weight: .semibold)).foregroundStyle(RT.accent)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .background(RT.surface2)
                    Divider()
                    Label("New workbench", systemImage: "plus").font(RT.ui(13, weight: .medium))
                        .foregroundStyle(RT.accent.opacity(0.5))
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .help("Workbenches arrive with Host Runtime persistence")
                }
                .frame(width: 232)
            }
            .accessibilityIdentifier("sidebar.workbench")
            .padding(.horizontal, 12).padding(.bottom, 10)

            HStack(spacing: 7) {
                Text("MEMBERS").font(RT.ui(10, weight: .semibold)).tracking(0.9).foregroundStyle(RT.textFaint)
                Spacer(minLength: 0)
                Text("fixed in replay").font(RT.ui(10.5)).foregroundStyle(RT.textFaint)
            }
            .padding(.horizontal, 16).padding(.bottom, 6)
            FlowRow(spacing: 8) {
                ForEach(members, id: \.agentId) { agent in
                    AvatarImage(assetName: agent.agentId == "orchestrator" ? "planning" : agent.agentId, name: agent.displayName,
                                color: RT.agentColor(agent.agentId))
                        .frame(width: 30, height: 30).clipShape(Circle())
                        .overlay(Circle().stroke(RT.agentColor(agent.agentId).opacity(0.55), lineWidth: 1.5))
                        .help("\(agent.displayName) · \(agent.pm == true ? "facilitator" : "@\(agent.role)")")
                        .accessibilityLabel(agent.displayName)
                }
                Circle().strokeBorder(RT.borderStrong, style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                    .overlay(Image(systemName: "plus").font(RT.ui(11)).foregroundStyle(RT.textFaint))
                    .frame(width: 30, height: 30).opacity(0.6)
                    .help("Adding members needs the Host Runtime")
            }
            .padding(.horizontal, 14).padding(.bottom, 12)

            Text("MISSIONS ON THIS WORKBENCH").font(RT.ui(10, weight: .semibold)).tracking(0.9).foregroundStyle(RT.textFaint)
                .padding(.horizontal, 16).padding(.top, 2).padding(.bottom, 6)
            ScrollView {
                if let mission {
                    Button(action: onOpenMission) {
                        HStack(alignment: .top, spacing: 8) {
                            Circle().fill(dotColor(mission.status)).frame(width: 7, height: 7).padding(.top, 6)
                                .background(Circle().fill(RT.run.opacity(mission.status == .live ? 0.22 : 0)).frame(width: 13, height: 13).padding(.top, 6))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(mission.title).font(RT.ui(13, weight: missionActive ? .semibold : .medium))
                                    .foregroundStyle(RT.text).lineLimit(1)
                                Text(mission.meta).font(RT.ui(11.5)).foregroundStyle(RT.textFaint).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .background(missionActive ? RT.surface3 : .clear, in: RoundedRectangle(cornerRadius: 6))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.horizontal, 8)
                    .accessibilityIdentifier("sidebar.mission.replay")
                } else {
                    Text("No missions yet").font(RT.ui(12)).foregroundStyle(RT.textFaint)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16).padding(.vertical, 6)
                }
            }

            // Where the Web's top bar shows the account, the desktop states what is real.
            HStack(spacing: 7) {
                Image(systemName: "lock.shield").font(RT.ui(11))
                Text("Replay").fontWeight(.semibold)
                Text("· \(runtimeNotice)").foregroundStyle(RT.textFaint).lineLimit(2)
                Spacer(minLength: 0)
            }
            .font(RT.ui(11))
            .foregroundStyle(RT.textMuted)
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 2)
            .overlay(alignment: .top) { Rectangle().fill(RT.border).frame(height: 1) }
            .help("Missions replay a recorded run. The Host Runtime is not connected, so no agent runs and no file changes.")
            .accessibilityIdentifier("runtime.status")

            // The Web shows the signed-in account here; the desktop shows the local workspace.
            Button(action: onOpenWorkspace) {
                HStack(spacing: 10) {
                    Image(systemName: "folder").font(RT.ui(13)).foregroundStyle(RT.accent)
                        .frame(width: 28, height: 28).background(RT.tint(RT.accent, 14), in: Circle())
                    VStack(alignment: .leading, spacing: 1) {
                        Text(workspaceName).font(RT.ui(12.5, weight: .medium)).foregroundStyle(RT.text).lineLimit(1)
                        Text("Local workspace").font(RT.ui(11)).foregroundStyle(RT.textFaint)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(RT.ui(11)).foregroundStyle(RT.textFaint)
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("sidebar.workspace")
        }
        .frame(width: 256)
        .background(RT.surface)
        .overlay(alignment: .trailing) { Rectangle().fill(RT.border).frame(width: 1) }
    }

    /// A Codex-style navigation row: icon, label, selected background.
    @ViewBuilder
    private func navRow(_ destination: SidebarDestination, symbol: String, title: String,
                        accent: Bool = false, action: @escaping () -> Void) -> some View {
        let selected = !accent && selection == destination
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(RT.ui(13)).frame(width: 18)
                Text(title).font(RT.ui(13, weight: selected || accent ? .semibold : .regular))
                Spacer(minLength: 0)
            }
            .foregroundStyle(accent ? RT.accent : selected ? RT.text : RT.textMuted)
            .padding(.horizontal, 8).padding(.vertical, 7)
            .background(selected ? RT.surface3 : .clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("sidebar.nav.\(destination.rawValue)")
    }

    private func dotColor(_ status: MissionSummary.Status) -> Color {
        switch status {
        case .live: RT.run
        case .done: RT.ok
        case .queued: RT.warn
        }
    }
}

struct LogoMark: View {
    let size: Double

    var body: some View {
        ZStack {
            Ellipse().fill(RT.text).frame(width: size, height: size * 0.5)
            Ellipse().fill(RT.accent.opacity(0.35)).frame(width: size * 0.84, height: size * 0.3).offset(y: -size * 0.04)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Wrapping row of equal-height items (the Web's `flexWrap: wrap`).
struct FlowRow: Layout {
    var spacing: Double = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x = 0.0, y = 0.0, lineHeight = 0.0, maxX = 0.0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width { x = 0; y += lineHeight + spacing; lineHeight = 0 }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: proposal.width ?? maxX, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight = 0.0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX { x = bounds.minX; y += lineHeight + spacing; lineHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

// MARK: - Inspector tabs

struct FilesPanel: View {
    let files: [MissionFile]
    var onOpen: (MissionFile) -> Void = { _ in }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 7) {
                Text("LOCAL MODEL OUTPUTS · \(files.count)").font(RT.ui(10.5, weight: .semibold)).tracking(0.84)
                    .foregroundStyle(RT.textFaint).padding(.bottom, 2)
                if files.isEmpty {
                    Text("Nothing yet — artifacts land here as the team works.").font(RT.ui(12.5).italic())
                        .foregroundStyle(RT.textFaint).padding(.horizontal, 2).padding(.vertical, 4)
                }
                ForEach(files) { file in
                    Button { onOpen(file) } label: { FileRowView(file: file) }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("files.\(file.name)")
                }
            }
            .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 24)
        }
        .background(RT.surface)
    }
}

private struct FileRowView: View {
    let file: MissionFile
    @State private var hovering = false

    var body: some View {
        let owner = RT.agentColor(file.ownerAgentId)
        HStack(spacing: 10) {
            Image(systemName: file.kind == "preview" ? "eye" : file.kind == "markdown" ? "paperclip" : "chevron.left.forwardslash.chevron.right")
                .font(RT.ui(13)).foregroundStyle(owner)
                .frame(width: 30, height: 30).background(RT.tint(owner, 14), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 1) {
                Text(file.name).font(RT.mono(12.5, weight: .semibold)).foregroundStyle(RT.text).lineLimit(1)
                Text(file.subtitle).font(RT.ui(11)).foregroundStyle(RT.textFaint).lineLimit(1)
            }
            Spacer(minLength: 0)
            VersionChip(version: file.version)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(hovering ? RT.surface2 : RT.surface, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.border))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

private struct VersionChip: View {
    let version: Int

    var body: some View {
        Text("v\(version)").font(RT.mono(10.5, weight: .semibold)).monospacedDigit().foregroundStyle(RT.textMuted)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(RT.surface3, in: RoundedRectangle(cornerRadius: 5))
    }
}

/// Port of `LiveNotes` (deliverables only: hand-offs come from the Web's chat store,
/// which a replay does not carry).
struct NotesPanel: View {
    let files: [MissionFile]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if files.isEmpty {
                    Text("Notes fill in as the team works — deliverables, hand-offs, and reviews land here once the orchestrator runs.")
                        .font(RT.ui(12.5).italic()).foregroundStyle(RT.textFaint)
                } else {
                    Text("DELIVERABLES · \(files.count)").font(RT.ui(10.5, weight: .semibold)).tracking(0.84)
                        .foregroundStyle(RT.textFaint)
                    ForEach(files) { file in
                        HStack(spacing: 9) {
                            AvatarImage(assetName: file.ownerAgentId == "orchestrator" ? "planning" : file.ownerAgentId,
                                        name: file.ownerAgentId, color: RT.agentColor(file.ownerAgentId))
                                .frame(width: 20, height: 20).clipShape(Circle())
                            Text(file.name).font(RT.mono(12)).foregroundStyle(RT.text).lineLimit(1)
                            Spacer(minLength: 0)
                            Text("v\(file.version)").font(RT.mono(10.5)).monospacedDigit().foregroundStyle(RT.textMuted)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
        .background(RT.surface)
    }
}

// MARK: - Artifact drawer

/// Port of the Web `Drawer`: the artifact opened from Files or the table tray.
struct ArtifactPanel: View {
    let file: MissionFile
    let agents: AgentRoster
    var onClose: () -> Void = {}

    var body: some View {
        let owner = agents[file.ownerAgentId]
        let color = RT.agentColor(file.ownerAgentId)
        VStack(spacing: 0) {
            HStack(spacing: 11) {
                AvatarImage(assetName: file.ownerAgentId == "orchestrator" ? "planning" : file.ownerAgentId,
                            name: owner?.displayName ?? "", color: color)
                    .frame(width: 28, height: 28).clipShape(Circle())
                    .overlay(Circle().stroke(color.opacity(0.55), lineWidth: 1.5))
                VStack(alignment: .leading, spacing: 3) {
                    Text(file.title).font(RT.mono(13.5, weight: .semibold)).foregroundStyle(RT.text).lineLimit(2)
                    HStack(spacing: 5) {
                        Circle().fill(color).frame(width: 6, height: 6)
                        Text("@\(owner?.role ?? file.ownerAgentId)")
                        Text("· \(owner?.displayName ?? "")").opacity(0.65)
                    }
                    .font(RT.mono(11.5, weight: .medium)).foregroundStyle(color)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(RT.tint(color, 16), in: RoundedRectangle(cornerRadius: 4))
                }
                Spacer(minLength: 0)
                VersionChip(version: file.version)
                Button(action: onClose) {
                    Image(systemName: "xmark").font(RT.ui(12, weight: .medium)).foregroundStyle(RT.textMuted)
                        .frame(width: 30, height: 30)
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.border))
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .accessibilityLabel("Close")
            }
            .padding(.horizontal, 18).padding(.vertical, 15)
            .overlay(alignment: .bottom) { Rectangle().fill(RT.border).frame(height: 1) }
            ScrollView {
                Group {
                    // The Web drawer shows non-preview artifacts as raw text (`CodeBlock`).
                    if file.content.isEmpty {
                        Text("No content captured for this artifact.").font(RT.ui(12).italic()).foregroundStyle(RT.textFaint)
                    } else {
                        Text(file.content).font(RT.mono(12)).foregroundStyle(RT.text).lineSpacing(2)
                    }
                }
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(RT.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(RT.border))
                .padding(18)
            }
            .background(RT.surface2)
        }
        .frame(maxHeight: .infinity)
        .background(RT.surface)
        .overlay(alignment: .leading) { Rectangle().fill(RT.border).frame(width: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("artifact.panel")
    }
}

// MARK: - Recommendation banner

struct RecommendationBanner: View {
    let recommendation: WorkflowRecommendation
    var onDismiss: () -> Void = {}

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "sparkle").font(RT.ui(13)).foregroundStyle(RT.accent)
            (Text("This task fits ") + Text("“\(recommendation.name)”").bold() + Text(" better")
                + Text(" — \(recommendation.reason)").foregroundColor(RT.textMuted))
                .font(RT.ui(12.5)).foregroundStyle(RT.text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button { } label: {
                Text("Use it").font(RT.ui(12, weight: .medium)).foregroundStyle(.white)
                    .padding(.horizontal, 12).padding(.vertical, 5)
                    .background(RT.accent.opacity(0.55), in: RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)
            .disabled(true)
            .help("Switching the workflow needs Host Runtime orchestration; a replay keeps its recorded template.")
            Button(action: onDismiss) {
                Image(systemName: "xmark").font(RT.ui(11)).foregroundStyle(RT.textFaint).frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .help("Dismiss")
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(RT.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.accent.opacity(0.30)))
        .accessibilityIdentifier("dock.recommendation")
    }
}

// MARK: - Workflow view (read-only)

// MARK: - Empty state

/// The workbench before any mission exists: what the table can build, as cards
/// that pre-fill a mission, plus the entry line with its team and template.
/// Replaces the Web's welcome overlay on the stage.
struct MissionStarterView: View {
    struct Card: Identifiable {
        var id: String
        var symbol: String
        var title: String
        var detail: String
        /// S2 bundles one recorded mission; the other templates need the Host Runtime.
        var available: Bool
    }

    let workbenchName: String
    let templateName: String
    let goal: String
    let cards: [Card]
    var onPick: (Card) -> Void = { _ in }
    var onStart: () -> Void = {}
    var onOpenTeam: () -> Void = {}
    var onOpenTemplate: () -> Void = {}

    var body: some View {
        // The prompt and the templates take the free space; the composer stays at
        // the foot of the window the way a chat composer does.
        VStack(spacing: 0) {
            GeometryReader { geo in
                ScrollView {
                    VStack(spacing: 0) {
                        Spacer(minLength: 28)
                        Text("What should the table build?")
                            .font(RT.ui(26, weight: .semibold)).foregroundStyle(RT.text)
                            .accessibilityAddTraits(.isHeader)
                        Text("Pick a starting point — the facilitator plans it and the table gets to work.")
                            .font(RT.ui(13.5)).foregroundStyle(RT.textMuted)
                            .padding(.top, 8)
                        HStack(alignment: .top, spacing: 12) {
                            ForEach(cards) { card in
                                Button { onPick(card) } label: { cardTile(card) }
                                    .buttonStyle(.plain)
                                    .disabled(!card.available)
                                    .help(card.available ? "Pre-fills a mission from this template"
                                          : "Needs the authenticated Host Runtime; S2 replays the recorded mission")
                                    .accessibilityIdentifier("starter.card.\(card.id)")
                            }
                        }
                        .padding(.top, 26)
                        .frame(maxWidth: 820)
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 28)
                    }
                    .padding(.horizontal, 28)
                    // Centred in the space the composer leaves, not pinned to the top.
                    .frame(maxWidth: .infinity, minHeight: geo.size.height)
                }
            }
            MissionComposer(workbenchName: workbenchName, templateName: templateName, text: goal,
                            hint: "Goal fixed in replay",
                            footnote: "Custom goals arrive with the Host Runtime.",
                            onTeam: onOpenTeam, onTemplate: onOpenTemplate, onSend: onStart)
                .frame(maxWidth: 820)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 28).padding(.bottom, 26)
        }
        .background(RT.bg)
        .accessibilityIdentifier("starter")
    }

    private func cardTile(_ card: Card) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: card.symbol).font(RT.ui(15)).foregroundStyle(card.available ? RT.accent : RT.textFaint)
            Text(card.title).font(RT.ui(13.5, weight: .semibold)).foregroundStyle(RT.text)
            Text(card.detail).font(RT.ui(11.5)).foregroundStyle(RT.textMuted).lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if !card.available {
                Text("Unavailable").font(RT.ui(10, weight: .semibold)).foregroundStyle(RT.textFaint)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(RT.surface3, in: RoundedRectangle(cornerRadius: 4))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 128, alignment: .topLeading)
        .background(RT.surface, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(RT.border))
        .opacity(card.available ? 1 : 0.6)
    }

}

// MARK: - Composer

/// The one composer the app uses, in the starter and under the chat: a context
/// strip attached to the top of the input card, the text, and a footer row that
/// states what will run and sends.
struct MissionComposer: View {
    let workbenchName: String
    let templateName: String
    let text: String
    /// True when `text` is a prompt rather than something to run.
    var isPlaceholder = false
    let hint: String
    var footnote: String?
    var sendEnabled = true
    /// Who the message goes to: nil is the whole table. Only the conversation
    /// composer offers this; the starter always talks to the table.
    var target: SceneAgent?
    var agents: [SceneAgent] = []
    var onTarget: ((SceneAgent?) -> Void)?
    var onTeam: () -> Void = {}
    var onTemplate: () -> Void = {}
    var onSend: () -> Void = {}

    @State private var choosingTarget = false

    var body: some View {
        VStack(alignment: .leading, spacing: -14) {
            HStack(spacing: 0) {
                HStack(spacing: 14) {
                    contextChip(symbol: "person.3", text: workbenchName, action: onTeam,
                                help: "Open the roundtable for this workbench")
                    contextChip(symbol: "sparkle", text: templateName, action: onTemplate,
                                help: "Open the workflow this mission runs")
                    if onTarget != nil { targetChip }
                }
                .padding(.horizontal, 14).padding(.top, 8).padding(.bottom, 20)
                .background(RT.surface2, in: TopRoundedRectangle(radius: 10))
                .overlay(TopRoundedRectangle(radius: 10).stroke(RT.border))
                Spacer(minLength: 0)
            }
            .padding(.leading, 14)

            VStack(alignment: .leading, spacing: 14) {
                Text(text)
                    .font(RT.ui(15)).foregroundStyle(isPlaceholder ? RT.textFaint : RT.text).lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
                HStack(spacing: 8) {
                    Image(systemName: "lock.shield").font(RT.ui(11)).foregroundStyle(RT.textFaint)
                    Text(hint).font(RT.ui(11.5)).foregroundStyle(RT.textFaint)
                    Spacer(minLength: 0)
                    Button(action: onSend) {
                        Image(systemName: "arrow.up").font(RT.ui(13, weight: .bold)).foregroundStyle(.white)
                            .frame(width: 32, height: 32)
                            .background(sendEnabled ? RT.accent : RT.accent.opacity(0.4), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!sendEnabled)
                    .help("Start the recorded mission")
                    .accessibilityIdentifier("composer.send")
                }
            }
            .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 12)
            .background(RT.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(RT.border))

            if let footnote {
                Text(footnote)
                    .font(RT.ui(11.5)).foregroundStyle(RT.textFaint)
                    .padding(.top, 24).padding(.leading, 2)
            }
        }
        .accessibilityIdentifier("composer")
    }

    /// The Web reaches an agent by typing @ in the composer; here the same list
    /// sits in the context strip, so who you are talking to is always visible.
    private var targetChip: some View {
        Button { choosingTarget.toggle() } label: {
            HStack(spacing: 6) {
                if let target {
                    AvatarImage(assetName: target.agentId == "orchestrator" ? "planning" : target.agentId,
                                name: target.displayName, color: RT.agentColor(target.agentId))
                        .frame(width: 16, height: 16).clipShape(Circle())
                    Text(target.displayName).font(RT.ui(12, weight: .medium))
                } else {
                    Image(systemName: "at").font(RT.ui(11.5))
                    Text("Talk to an agent").font(RT.ui(12, weight: .medium))
                }
                Image(systemName: "chevron.down").font(RT.ui(8, weight: .semibold))
            }
            .foregroundStyle(target == nil ? RT.textMuted : RT.agentColor(target?.agentId))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Choose who this message goes to")
        .accessibilityLabel(target.map { "Talking to \($0.displayName)" } ?? "Talk to an agent")
        .accessibilityIdentifier("composer.target")
        .popover(isPresented: $choosingTarget, arrowEdge: .bottom) { targetMenu }
    }

    private var targetMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Talk to").font(RT.ui(11)).foregroundStyle(RT.textFaint)
                .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            targetRow(nil)
            ForEach(agents, id: \.agentId) { targetRow($0) }
        }
        .frame(width: 260)
    }

    private func targetRow(_ agent: SceneAgent?) -> some View {
        Button {
            choosingTarget = false
            onTarget?(agent)
        } label: {
            HStack(spacing: 10) {
                if let agent {
                    AvatarImage(assetName: agent.agentId == "orchestrator" ? "planning" : agent.agentId,
                                name: agent.displayName, color: RT.agentColor(agent.agentId))
                        .frame(width: 24, height: 24).clipShape(Circle())
                    VStack(alignment: .leading, spacing: 1) {
                        Text(agent.displayName).font(RT.ui(12.5, weight: .medium)).foregroundStyle(RT.text)
                        Text("@\(agent.mention ?? agent.agentId) · \(agent.pm == true ? "facilitator" : agent.role)")
                            .font(RT.mono(10.5)).foregroundStyle(RT.agentColor(agent.agentId))
                    }
                } else {
                    Image(systemName: "person.3").font(RT.ui(11)).foregroundStyle(RT.textMuted)
                        .frame(width: 24, height: 24).background(RT.surface2, in: Circle())
                    VStack(alignment: .leading, spacing: 1) {
                        Text("The whole table").font(RT.ui(12.5, weight: .medium)).foregroundStyle(RT.text)
                        Text("the facilitator routes it").font(RT.ui(10.5)).foregroundStyle(RT.textFaint)
                    }
                }
                Spacer(minLength: 0)
                if agent?.agentId == target?.agentId {
                    Image(systemName: "checkmark").font(RT.ui(11, weight: .semibold)).foregroundStyle(RT.accent)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// A context chip: icon and label only, the way Codex labels its composer.
    private func contextChip(symbol: String, text: String, action: @escaping () -> Void, help: String) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: symbol).font(RT.ui(11.5))
                Text(text).font(RT.ui(12, weight: .medium))
            }
            .foregroundStyle(RT.textMuted)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityIdentifier("composer.chip.\(symbol)")
    }
}

/// `UnevenRoundedRectangle` needs macOS 14; the app targets 13.
private struct TopRoundedRectangle: Shape {
    let radius: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + radius))
        path.addArc(center: CGPoint(x: rect.minX + radius, y: rect.minY + radius), radius: radius,
                    startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        path.addLine(to: CGPoint(x: rect.maxX - radius, y: rect.minY))
        path.addArc(center: CGPoint(x: rect.maxX - radius, y: rect.minY + radius), radius: radius,
                    startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        return path
    }
}
