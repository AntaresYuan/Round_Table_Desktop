#if SWIFT_PACKAGE
import RoundTableScene
#endif
import SwiftUI

// Native port of the Web chat thread for a mission run
// (src/ui/components/live-turn.jsx). Content decisions come from
// `MissionThread`; this file only draws them.
struct MissionChatView: View {
    let thread: MissionThread?
    let approving: Bool
    var onApprove: () -> Void = {}
    var onDecide: (String) -> Void = { _ in }

    var anchorToBottom = false
    /// Room under the composer that floats over the thread.
    var bottomInset: CGFloat = 0

    var body: some View {
        ScrollViewReader { reader in
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let thread {
                    UserMessage(text: thread.message)
                    if thread.showsRun {
                        runBlock(thread)
                    }
                } else {
                    VStack(spacing: 5) {
                        Text("No live turn yet").font(RT.ui(14, weight: .semibold)).foregroundStyle(RT.textMuted)
                        Text("Start a mission to replay the recorded run here.").font(RT.ui(12.5)).foregroundStyle(RT.textFaint)
                    }
                    .frame(maxWidth: .infinity, minHeight: 220)
                }
            }
            .padding(.horizontal, 24).padding(.top, 18).padding(.bottom, 26 + bottomInset)
            Color.clear.frame(height: 1).id("chat.end")
        }
        .onChange(of: thread) { _ in
            if anchorToBottom { reader.scrollTo("chat.end", anchor: .bottom) }
        }
        }
        .accessibilityIdentifier("chat.thread")
    }

    private func runBlock(_ thread: MissionThread) -> some View {
        HStack(alignment: .top, spacing: 11) {
            AvatarImage(assetName: "planning", name: "Planning", color: RT.pm)
                .frame(width: 28, height: 28).clipShape(Circle())
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text("Roundtable").font(RT.ui(12.5, weight: .semibold)).foregroundStyle(RT.pm)
                    Text("MISSION RUN").font(RT.mono(10)).tracking(1).foregroundStyle(RT.textFaint)
                }
                .padding(.bottom, 6)
                if let header = thread.header { MissionHeaderCard(model: header).padding(.bottom, 10) }
                if let error = thread.errorText {
                    Text(error).font(RT.ui(13)).foregroundStyle(ChatTone.bad)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(ChatTone.bad.opacity(0.12), in: RoundedRectangle(cornerRadius: 6))
                }
                if thread.needsClarification {
                    Text("The planner needs a few answers before it can build. Clarification is not part of this recording.")
                        .font(RT.ui(12.5)).foregroundStyle(RT.textMuted)
                }
                if let plan = thread.plan {
                    PlanCard(model: plan, approving: approving, onApprove: onApprove)
                }
                if let chain = thread.chain {
                    AgentChainView(model: chain)
                    VStack(spacing: 0) {
                        ForEach(thread.stages) { StageCardView(model: $0).padding(.top, 10) }
                    }
                    .padding(.top, 4)
                    if let result = thread.result {
                        ResultCard(model: result, onDecide: onDecide).padding(.top, 12)
                    }
                }
            }
        }
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }
}

// MARK: - Tones and small parts

enum ChatTone {
    static let bad = Color(hex: 0xC4605A)

    static func color(_ tone: CardTone) -> Color {
        switch tone {
        case .ok: RT.ok
        case .run: RT.run
        case .warn: RT.warn
        case .bad: bad
        case .faint: RT.textFaint
        case .accent: RT.accent
        }
    }
}

private struct UserMessage: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Spacer(minLength: 40)
            Text(text).font(RT.ui(14)).foregroundStyle(.white).lineSpacing(3)
                .padding(.horizontal, 15).padding(.vertical, 11)
                .background(RT.accent, in: ChatBubbleShape())
                .shadow(color: .black.opacity(0.06), radius: 10, y: 5)
                .textSelection(.enabled)
            AvatarImage(assetName: "you", name: "You", color: RT.pm)
                .frame(width: 30, height: 30).clipShape(Circle())
                .overlay(Circle().stroke(RT.pm.opacity(0.55), lineWidth: 1.5))
        }
    }
}

/// `border-radius: 14px 14px 4px 14px`.
private struct ChatBubbleShape: Shape {
    func path(in rect: CGRect) -> Path {
        let big = 14.0, small = 4.0
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + big, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - big, y: rect.minY))
        path.addArc(center: CGPoint(x: rect.maxX - big, y: rect.minY + big), radius: big, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - small))
        path.addArc(center: CGPoint(x: rect.maxX - small, y: rect.maxY - small), radius: small, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        path.addLine(to: CGPoint(x: rect.minX + big, y: rect.maxY))
        path.addArc(center: CGPoint(x: rect.minX + big, y: rect.maxY - big), radius: big, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        path.addLine(to: CGPoint(x: rect.minX, y: rect.minY + big))
        path.addArc(center: CGPoint(x: rect.minX + big, y: rect.minY + big), radius: big, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        return path
    }
}

private struct Pill: View {
    let text: String
    let tone: CardTone
    var size: Double = 11.5

    var body: some View {
        Text(text).font(RT.ui(size, weight: .heavy)).foregroundStyle(ChatTone.color(tone))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(ChatTone.color(tone).opacity(0.14), in: Capsule())
            .fixedSize()
    }
}

private struct CardChrome<Content: View>: View {
    var accent: Color? = nil
    @ViewBuilder var content: Content

    var body: some View {
        content
            .background(RT.surface)
            .overlay(alignment: .leading) { if let accent { accent.frame(width: 3) } }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(RT.border))
            .shadow(color: Color(red: 40 / 255, green: 36 / 255, blue: 30 / 255).opacity(0.08), radius: 10, y: 5)
    }
}

// MARK: - Mission header

private struct MissionHeaderCard: View {
    let model: MissionHeaderModel

    var body: some View {
        let color = ChatTone.color(model.tone)
        CardChrome(accent: color) {
            HStack(spacing: 10) {
                Image(systemName: model.completed ? "checkmark" : "square.3.layers.3d")
                    .font(RT.ui(13, weight: .semibold)).foregroundStyle(color)
                    .frame(width: 28, height: 28)
                    .background(color.opacity(0.14), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    (Text("Mission").font(RT.ui(13.5, weight: .heavy)).foregroundColor(RT.text)
                        + Text("  \(model.templateName)").font(RT.ui(12.5)).foregroundColor(RT.textMuted)
                        + Text("  \(model.missionId)").font(RT.mono(10.5)).foregroundColor(RT.textFaint))
                        .fixedSize(horizontal: false, vertical: true)
                    Text(model.stageLine).font(RT.ui(12.5)).foregroundStyle(RT.textMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                Pill(text: model.statusLabel, tone: model.tone)
            }
            .padding(.horizontal, 14).padding(.vertical, 11)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat.mission-header")
    }
}

// MARK: - Plan card

private struct PlanCard: View {
    let model: PlanCardModel
    let approving: Bool
    let onApprove: () -> Void

    var body: some View {
        CardChrome {
            VStack(alignment: .leading, spacing: 0) {
                // The Web header is a wrapping flex row; in the narrow chat pane the
                // status and the action wrap below the title.
                VStack(alignment: .leading, spacing: 9) {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "square.3.layers.3d").font(RT.ui(13)).foregroundStyle(RT.accent).padding(.top, 2)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text("Plan").font(RT.ui(14, weight: .bold)).foregroundStyle(RT.text)
                                Text("\(model.doneCount)/\(model.total) done").font(RT.mono(11.5, weight: .semibold))
                                    .monospacedDigit().foregroundStyle(RT.textFaint)
                            }
                            Text(model.intakeLine).font(RT.mono(11)).foregroundStyle(RT.textFaint)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack(spacing: 8) {
                        Pill(text: model.approved ? "approved" : "awaiting approval", tone: model.approved ? .ok : .warn)
                        Spacer(minLength: 0)
                        if !model.approved {
                            Button(action: onApprove) {
                                HStack(spacing: 6) {
                                    if approving {
                                        ProgressView().controlSize(.mini)
                                        Text("Starting…")
                                    } else {
                                        Image(systemName: "play.fill").font(RT.ui(10))
                                        Text("Start building")
                                    }
                                }
                                .font(RT.ui(12.5, weight: .bold))
                                .foregroundStyle(approving ? RT.textFaint : .white)
                                .fixedSize()
                                .padding(.horizontal, 13).frame(minHeight: 30)
                                .background(approving ? RT.surface3 : RT.accent, in: RoundedRectangle(cornerRadius: 6))
                            }
                            .buttonStyle(.plain)
                            .disabled(approving)
                            .help("Approve this plan and continue the replay. No agent runs.")
                            .accessibilityIdentifier("chat.plan.start-building")
                        }
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                Divider().overlay(RT.border)
                Text(model.summary).font(RT.ui(12.5)).foregroundStyle(RT.textMuted).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RT.surface2)
                Divider().overlay(RT.border)
                VStack(spacing: 0) {
                    ForEach(Array(model.rows.enumerated()), id: \.element.id) { index, row in
                        TodoRowView(row: row, last: index == model.rows.count - 1)
                    }
                }
                .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 6)
            }
        }
        .accessibilityIdentifier("chat.plan")
    }
}

private struct TodoRowView: View {
    let row: PlanTodoRow
    let last: Bool
    @State private var open = false

    private var tone: CardTone {
        switch row.status { case "running": .run; case "completed": .ok; case "failed": .bad; default: .faint }
    }
    private var label: String { row.status == "completed" ? "done" : row.status }

    var body: some View {
        let color = ChatTone.color(tone)
        VStack(alignment: .leading, spacing: 0) {
            Button { open.toggle() } label: {
                HStack(alignment: .top, spacing: 10) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 5).fill(color.opacity(row.status == "pending" ? 0.08 : 0.16))
                        switch row.status {
                        case "running": ProgressView().controlSize(.mini)
                        case "completed": Image(systemName: "checkmark").font(RT.ui(9, weight: .bold)).foregroundStyle(color)
                        case "failed": Image(systemName: "xmark").font(RT.ui(9, weight: .bold)).foregroundStyle(color)
                        default: Circle().fill(color.opacity(0.6)).frame(width: 6, height: 6)
                        }
                    }
                    .frame(width: 18, height: 18).padding(.top, 3)
                    AvatarImage(assetName: row.ownerAgentId == "orchestrator" ? "planning" : row.ownerAgentId, name: row.ownerAgentId,
                                color: RT.agentColor(row.ownerAgentId))
                        .frame(width: 24, height: 24).clipShape(Circle())
                        .overlay(Circle().stroke(RT.agentColor(row.ownerAgentId).opacity(0.55), lineWidth: 1.5))
                    VStack(alignment: .leading, spacing: 0) {
                        // A wrapping row on the Web: the title drops below the badge when narrow.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 7) { cliBadge; titleText.fixedSize() }
                            VStack(alignment: .leading, spacing: 4) { cliBadge; titleText }
                        }
                        Text(row.objective).font(RT.ui(12.5)).foregroundStyle(RT.textMuted).lineSpacing(3)
                            .fixedSize(horizontal: false, vertical: true).padding(.top, 5)
                        Text(row.metaLine).font(RT.mono(11)).foregroundStyle(RT.textFaint).padding(.top, 3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Pill(text: label, tone: tone, size: 10.5).padding(.top, 3)
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(RT.ui(9, weight: .semibold))
                        .foregroundStyle(RT.textFaint).padding(.top, 7)
                }
                .padding(.vertical, 9)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Expand task activity")
            if open { details.padding(.leading, 28).padding(.bottom, 9) }
            if !last { Divider().overlay(RT.border) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("CLI \(row.cliNumber), \(row.title), \(label)")
    }

    private var cliBadge: some View {
        Text("CLI \(row.cliNumber)").font(RT.mono(9.5, weight: .heavy)).foregroundStyle(RT.accent)
            .padding(.horizontal, 5).padding(.vertical, 2)
            .background(RT.accent.opacity(0.10), in: RoundedRectangle(cornerRadius: 5))
            .fixedSize()
    }

    private var titleText: some View {
        Text(row.title).font(RT.ui(13.5, weight: .semibold))
            .foregroundStyle(row.status == "completed" ? RT.textMuted : RT.text)
            .strikethrough(row.status == "completed", color: RT.ok.opacity(0.5))
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(row.id).font(RT.mono(10)).foregroundStyle(RT.textFaint)
            if !row.acceptanceCriteria.isEmpty {
                Text("DEFINITION OF DONE").font(RT.mono(10)).tracking(0.6).foregroundStyle(RT.textFaint)
                ForEach(Array(row.acceptanceCriteria.enumerated()), id: \.offset) { _, criterion in
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text("✓").foregroundStyle(RT.ok)
                        Text(criterion).foregroundStyle(RT.textMuted).fixedSize(horizontal: false, vertical: true)
                    }
                    .font(RT.ui(12))
                }
            }
            if row.activity.isEmpty && row.acceptanceCriteria.isEmpty {
                Text(row.status == "pending" ? "Not started yet." : "No activity captured.")
                    .font(RT.ui(12).italic()).foregroundStyle(RT.textFaint)
            }
            ForEach(Array(row.activity.enumerated()), id: \.offset) { _, line in
                Label(line, systemImage: "sparkle").font(RT.ui(12)).foregroundStyle(RT.textMuted).lineLimit(1)
            }
        }
        .padding(.horizontal, 11).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RT.surface2, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.border))
    }
}

// MARK: - Agent chain and stage cards

private struct AgentChainView: View {
    let model: AgentChainModel

    var body: some View {
        let color = ChatTone.color(model.tone)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if model.statusText == "running" {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(systemName: model.tone == .bad ? "xmark" : "checkmark").font(RT.ui(11, weight: .bold))
                }
                Text(model.statusText)
                if let adapter = model.adapter {
                    Text("via \(adapter)").font(RT.mono(12.5)).fontWeight(.regular).foregroundStyle(RT.textFaint)
                }
            }
            .font(RT.ui(12.5, weight: .bold)).foregroundStyle(color)
            ForEach(model.liveFeeds) { LiveFeedView(feed: $0, compact: false) }
            if let waiting = model.waitingText {
                Text(waiting).font(RT.ui(13)).foregroundStyle(RT.textMuted)
            }
            ForEach(model.records) { record in
                let owner = RT.agentColor(record.ownerAgentId)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        AvatarImage(assetName: record.ownerAgentId, name: record.ownerName, color: owner)
                            .frame(width: 24, height: 24).clipShape(Circle())
                        Text(record.ownerName).font(RT.ui(13.5, weight: .bold)).foregroundStyle(RT.text)
                        Text("@\(record.mention)").font(RT.mono(11)).foregroundStyle(RT.textFaint)
                        if record.artifacts.count > 1 {
                            Text("\(record.artifacts.count) files").font(RT.mono(10.5)).foregroundStyle(RT.textFaint)
                        }
                        Spacer(minLength: 0)
                        Text(record.status).font(RT.ui(11, weight: .bold))
                            .foregroundStyle(record.status == "failed" ? ChatTone.bad : RT.ok)
                    }
                    if let title = record.title {
                        Text(title).font(RT.ui(13)).foregroundStyle(RT.textMuted).fixedSize(horizontal: false, vertical: true)
                    }
                    if record.artifacts.isEmpty {
                        Text("No output captured.").font(RT.ui(12).italic()).foregroundStyle(RT.textFaint)
                    }
                    ForEach(record.artifacts) { ExpandableArtifactRow(artifact: $0) }
                }
                .padding(.leading, 12)
                .overlay(alignment: .leading) { owner.opacity(0.6).frame(width: 2) }
            }
            if let path = model.workspacePath {
                Text("workspace: \(path)").font(RT.mono(10.5)).foregroundStyle(RT.textFaint).lineLimit(1).truncationMode(.middle)
            }
        }
        .padding(.top, 6)
        .accessibilityIdentifier("chat.agent-chain")
    }
}

private struct StageCardView: View {
    let model: StageCardModel

    var body: some View {
        let color = ChatTone.color(model.tone)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6).fill(color.opacity(0.16))
                    if model.status == "active" {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: model.status == "done" ? "checkmark" : RT.symbol(forStageIcon: model.icon))
                            .font(RT.ui(10, weight: .semibold)).foregroundStyle(color)
                    }
                }
                .frame(width: 22, height: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.name).font(RT.ui(13.5, weight: .bold)).foregroundStyle(RT.text)
                    if let desc = model.desc {
                        Text(desc).font(RT.ui(11)).foregroundStyle(RT.textFaint).lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(1)
                Pill(text: model.statusLabel, tone: model.tone, size: 10.5)
            }
            .padding(.horizontal, 13).padding(.vertical, 10)
            .background(color.opacity(0.06))
            Divider().overlay(RT.border)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(model.seats.enumerated()), id: \.offset) { _, seat in
                    let seatColor = ChatTone.color(seat.tone)
                    HStack(spacing: 8) {
                        AvatarImage(assetName: seat.agentId == "orchestrator" ? "planning" : seat.agentId, name: seat.displayName,
                                    color: RT.agentColor(seat.agentId))
                            .frame(width: 22, height: 22).clipShape(Circle())
                        Text(seat.displayName).font(RT.ui(12.5, weight: .semibold)).foregroundStyle(RT.agentColor(seat.agentId))
                        Text("@\(seat.role)").font(RT.mono(10.5)).foregroundStyle(RT.textFaint)
                        Spacer(minLength: 0)
                        HStack(spacing: 5) {
                            if seat.status == "active" { ProgressView().controlSize(.mini) }
                            if seat.status == "done" { Image(systemName: "checkmark").font(RT.ui(9, weight: .bold)) }
                            Text(seat.statusLabel)
                        }
                        .font(RT.ui(11, weight: .semibold)).foregroundStyle(seatColor)
                    }
                }
                ForEach(model.liveFeeds) { LiveFeedView(feed: $0, compact: true) }
                ForEach(model.artifacts) { ExpandableArtifactRow(artifact: $0) }
                if model.showsWorking {
                    Text("Working…").font(RT.ui(12).italic()).foregroundStyle(RT.textFaint)
                }
            }
            .padding(.horizontal, 13).padding(.vertical, 10)
        }
        .background(RT.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(color.opacity(0.35)))
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Stage \(model.name), \(model.statusLabel)")
    }
}

/// Port of `LiveTranscriptFeed`. `compact` drops the agent and status from the
/// header, as inside a stage card where the seat row already shows them.
private struct LiveFeedView: View {
    let feed: LiveFeedModel
    let compact: Bool

    var body: some View {
        let running = feed.status == "running"
        let failed = feed.status == "failed"
        let color = RT.agentColor(feed.agentId)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                if !compact {
                    AvatarImage(assetName: feed.agentId == "orchestrator" ? "planning" : feed.agentId, name: feed.displayName, color: color)
                        .frame(width: 18, height: 18).clipShape(Circle())
                    Text(feed.displayName).font(RT.ui(11.5, weight: .bold)).foregroundStyle(color)
                }
                if let runtime = feed.runtime { Text(runtime).font(RT.mono(10)).foregroundStyle(RT.textFaint) }
                Spacer(minLength: 0)
                HStack(spacing: 5) {
                    if running { ProgressView().controlSize(.mini) }
                    if !compact { Text(feed.status) }
                }
                .font(RT.ui(10.5, weight: .bold))
                .foregroundStyle(failed ? ChatTone.bad : running ? RT.run : RT.ok)
            }
            .padding(.horizontal, 10).padding(.vertical, compact ? 4 : 6)
            .overlay(alignment: .bottom) { Rectangle().fill(RT.border).frame(height: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 3) {
                    if feed.entries.isEmpty {
                        Text(feed.emptyText).font(RT.ui(11.5).italic()).foregroundStyle(RT.textFaint)
                    }
                    ForEach(Array(feed.entries.enumerated()), id: \.offset) { _, entry in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: symbol(entry.kind)).font(.system(size: 9))
                            Text(entry.content).fixedSize(horizontal: false, vertical: true)
                        }
                        .font(RT.ui(11.5)).foregroundStyle(tone(entry.kind))
                    }
                    if failed, let error = feed.error, !feed.entries.contains(where: { $0.kind == "error" }) {
                        Text(error).font(RT.ui(11.5)).foregroundStyle(ChatTone.bad)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10).padding(.vertical, 7)
            }
            .frame(maxHeight: 150)
            .fixedSize(horizontal: false, vertical: true)
        }
        .background(RT.surface2, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(failed ? ChatTone.bad.opacity(0.3) : RT.border))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(feed.displayName) transcript, \(feed.status)")
    }

    /// `TRANSCRIPT_KIND_STYLE`.
    private func symbol(_ kind: String) -> String {
        switch kind { case "thinking": "sparkle"; case "response": "paperclip"; case "error": "xmark"; default: "wrench.adjustable" }
    }

    private func tone(_ kind: String) -> Color {
        switch kind { case "thinking", "response": RT.textMuted; case "error": ChatTone.bad; default: RT.textFaint }
    }
}

// MARK: - Result card

private struct ResultCard: View {
    let model: ResultCardModel
    let onDecide: (String) -> Void

    var body: some View {
        let color = ChatTone.color(model.tone)
        CardChrome {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: model.completed ? "checkmark" : "chevron.left.forwardslash.chevron.right")
                        .font(RT.ui(13, weight: .semibold)).foregroundStyle(color).padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.title).font(RT.ui(14, weight: .bold)).foregroundStyle(RT.text)
                        Text(model.metaLine).font(RT.mono(11)).foregroundStyle(RT.textFaint).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
                    Pill(text: model.statusText, tone: model.tone)
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
                Divider().overlay(RT.border)
                if model.awaitingDecision {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Delivery is ready for acceptance.").font(RT.ui(12.5)).foregroundStyle(RT.textMuted)
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 8) { repairButton; testsButton; acceptButton }
                            VStack(alignment: .leading, spacing: 8) {
                                HStack(spacing: 8) { repairButton; testsButton }
                                acceptButton
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(RT.surface2)
                    Divider().overlay(RT.border)
                }
                if let banner = model.decisionBanner {
                    let accepted = banner.hasPrefix("Final")
                    Text(banner).font(RT.ui(12.5, weight: .bold)).foregroundStyle(accepted ? RT.ok : RT.warn)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background((accepted ? RT.ok : RT.warn).opacity(0.10))
                    Divider().overlay(RT.border)
                }
                if let error = model.errorText {
                    Text(error).font(RT.mono(11.5)).foregroundStyle(ChatTone.bad)
                        .padding(.horizontal, 14).padding(.vertical, 10)
                    Divider().overlay(RT.border)
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(model.artifacts) { ExpandableArtifactRow(artifact: $0) }
                    if let path = model.workspacePath {
                        Text("workspace: \(path)").font(RT.mono(10.5)).foregroundStyle(RT.textFaint).lineLimit(1).truncationMode(.middle)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 11)
            }
        }
        .accessibilityIdentifier("chat.delivery")
    }

    private var repairButton: some View {
        decisionButton("Request repair", symbol: "wrench.adjustable", enabled: false) { onDecide("repair") }
    }

    private var testsButton: some View {
        decisionButton("Request tests", symbol: "eye", enabled: false) { onDecide("tests") }
    }

    private var acceptButton: some View {
        Button { onDecide("accept") } label: {
            Label("Accept delivery", systemImage: "checkmark")
                .font(RT.ui(12.5, weight: .bold)).foregroundStyle(.white)
                .fixedSize()
                .padding(.horizontal, 11).padding(.vertical, 7)
                .background(RT.ok, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat.delivery.accept")
    }

    /// Repair and tests need a new run, which a recording cannot provide; they stay visible but disabled.
    private func decisionButton(_ title: String, symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(RT.ui(12.5, weight: .bold)).foregroundStyle(RT.textMuted)
                .fixedSize()
                .padding(.horizontal, 11).padding(.vertical, 7)
                .background(RT.surface, in: RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.border))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.55)
        .help(enabled ? title : "Not available in a recorded replay")
    }
}

// MARK: - Artifact row

/// Port of `ExpandableArtifact`: attribution row, click to read the content.
struct ExpandableArtifactRow: View {
    let artifact: ThreadArtifact
    @State private var open = false

    var body: some View {
        let owner = RT.agentColor(artifact.ownerAgentId)
        VStack(alignment: .leading, spacing: 0) {
            Button { open.toggle() } label: {
                HStack(spacing: 9) {
                    Image(systemName: open ? "chevron.down" : "chevron.right").font(RT.ui(9, weight: .semibold)).foregroundStyle(owner)
                    AvatarImage(assetName: artifact.ownerAgentId == "orchestrator" ? "planning" : artifact.ownerAgentId,
                                name: artifact.ownerAgentId, color: owner)
                        .frame(width: 20, height: 20).clipShape(Circle())
                    Image(systemName: artifact.kind == "preview" ? "eye" : artifact.kind == "markdown" ? "paperclip" : "chevron.left.forwardslash.chevron.right")
                        .font(RT.ui(11)).foregroundStyle(owner)
                    Text(artifact.title).font(RT.mono(12)).foregroundStyle(RT.text).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 0)
                    if artifact.version > 1 {
                        Text("v\(artifact.version)").font(RT.mono(10.5, weight: .semibold)).foregroundStyle(RT.textMuted)
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(RT.surface3, in: RoundedRectangle(cornerRadius: 5))
                    }
                    Text(artifact.ownerLabel).font(RT.ui(11, weight: .bold)).foregroundStyle(owner)
                }
                .padding(.horizontal, 10).padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                Divider().overlay(owner.opacity(0.22))
                ScrollView {
                    Group {
                        if artifact.content.isEmpty {
                            Text("No content captured for this artifact.").font(RT.ui(12).italic()).foregroundStyle(RT.textFaint)
                        } else if let markdown = try? AttributedString(markdown: artifact.content,
                                                                         options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)),
                                  artifact.kind == "markdown" {
                            Text(markdown).font(RT.ui(12.5)).foregroundStyle(RT.text)
                        } else {
                            Text(artifact.content).font(RT.mono(11.5)).foregroundStyle(RT.text)
                        }
                    }
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                }
                .frame(maxHeight: 320)
                .background(RT.bg)
            }
        }
        .background(RT.tint(owner, 7))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(owner.opacity(0.22)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(artifact.title), \(artifact.ownerLabel)")
    }
}
