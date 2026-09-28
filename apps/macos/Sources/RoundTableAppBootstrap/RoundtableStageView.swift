#if SWIFT_PACKAGE
import RoundTableScene
#endif
import AppKit
import SwiftUI

// Native port of the Web roundtable room (src/ui/components/roundtable.jsx,
// stacked layout). Everything is laid out on the Web's fixed 900×848 canvas
// and the canvas is scaled to fit, so positions match the Web one to one.
// With no live turn the room shows the Web's idle state.
struct RoundtableStageView: View {
    let scene: RoundtableScene?
    let agents: AgentRoster
    var onOpenCodeLogs: () -> Void = {}
    /// Opens the board full size, as the Web's `WhiteboardZoom` lightbox does.
    var onZoomWhiteboard: () -> Void = {}

    private var seats: [RoomSeat] { RoomLayout.seats(memberIds: MissionReplayModel.memberIds) }
    private var status: [String: String] { scene?.status ?? [:] }
    private var speaker: String? { scene?.speech?.agentId }

    var body: some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width / RoomLayout.width, proxy.size.height / RoomLayout.height)
            room
                .frame(width: RoomLayout.width, height: RoomLayout.height)
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: RoomLayout.width * scale, height: RoomLayout.height * scale, alignment: .topLeading)
                .position(x: proxy.size.width / 2, y: proxy.size.height / 2)
        }
        .background(roomBackground)
        .clipped()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Roundtable")
    }

    private var roomBackground: some View {
        ZStack {
            LinearGradient(stops: [
                .init(color: RT.mix(RT.surface, 0.45, into: RT.bg), location: 0),
                .init(color: RT.bg, location: 0.52),
                .init(color: RT.mix(.black, 0.03, into: RT.bg), location: 1),
            ], startPoint: .top, endPoint: .bottom)
            RadialGradient(colors: [RT.surface.opacity(0.32), RT.surface.opacity(0)],
                           center: .top, startRadius: 0, endRadius: 520)
        }
    }

    private var room: some View {
        ZStack(alignment: .topLeading) {
            Whiteboard(scene: scene, agents: agents, onZoom: onZoomWhiteboard)
                .frame(width: RoomLayout.whiteboardSize.width, height: RoomLayout.whiteboardSize.height)
                .position(x: RoomLayout.whiteboardCenter.x, y: RoomLayout.whiteboardCenter.y)
                .zIndex(6)
            TableBody()
                .zIndex(1)
            Beams(scene: scene, agents: agents, seats: seats)
                .frame(width: RoomLayout.width, height: RoomLayout.height)
                .allowsHitTesting(false)
                .zIndex(20)
            DocTray(placed: scene?.placed ?? [], onOpen: onOpenCodeLogs)
                .position(x: RoomLayout.table.cx - 30, y: RoomLayout.table.cy + RoomLayout.table.ry * 0.32)
                .zIndex(70)
            ForEach(seats) { seat in
                let position = RoomLayout.position(angle: seat.angle)
                let showSpeech = scene?.speech?.agentId == seat.agentId && seat.agentId != nil
                let nowDoing = seat.isUser || seat.head || showSpeech ? nil : seat.agentId.flatMap { scene?.work[$0] }
                SeatView(
                    seat: seat,
                    agent: seat.agentId.flatMap { agents[$0] },
                    status: seat.agentId.flatMap { status[$0] } ?? "idle",
                    scale: position.scale,
                    speech: showSpeech ? scene?.speech : nil,
                    nowDoing: nowDoing,
                    dimmed: speaker != nil && speaker != seat.agentId && !seat.isUser && !seat.head
                )
                .position(x: position.x, y: position.y)
                .zIndex(showSpeech ? 400 : nowDoing != nil ? 350 : 200 + position.y)
            }
        }
    }
}

// MARK: - Whiteboard

private struct Whiteboard: View {
    let scene: RoundtableScene?
    let agents: AgentRoster
    var onZoom: () -> Void = {}

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 20)
                .fill(Color.black.opacity(0.20))
                .blur(radius: 24).opacity(0.55)
                .padding(.horizontal, -8).padding(.top, -8).padding(.bottom, -22)
            RoundedRectangle(cornerRadius: 15)
                .fill(LinearGradient(stops: [
                    .init(color: RT.mix(RT.surface3, 0.7, into: .white), location: 0),
                    .init(color: RT.borderStrong, location: 0.54),
                    .init(color: RT.surface2, location: 1),
                ], startPoint: .topLeading, endPoint: .bottomTrailing))
                .shadow(color: .black.opacity(0.3), radius: 22, y: 20)
            // The writing surface is fixed to the Web's size and clips its content.
            WhiteboardSurface(scene: scene, agents: agents)
                .frame(width: RoomLayout.whiteboardSize.width - 22, height: RoomLayout.whiteboardSize.height - 22)
                .clipShape(RoundedRectangle(cornerRadius: 7))
                .padding(11)
            ZoomButton(action: onZoom)
                .padding(.top, 18).padding(.trailing, 18)
                .frame(maxWidth: .infinity, alignment: .topTrailing)
        }
        .overlay(alignment: .bottom) { MarkerTray().offset(y: 9) }
    }
}

private struct ZoomButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.up.left.and.arrow.down.right")
                .font(RT.ui(11, weight: .medium))
                .foregroundStyle(RT.textMuted)
                .frame(width: 28, height: 28)
                .background(RT.surface, in: RoundedRectangle(cornerRadius: 7))
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(RT.border))
        }
        .buttonStyle(.plain)
        .help("Open whiteboard")
        .accessibilityLabel("Open whiteboard")
        .accessibilityIdentifier("whiteboard.zoom")
    }
}

/// Port of the Web `WhiteboardZoom`: the same surface, room-sized.
struct WhiteboardZoomView: View {
    let scene: RoundtableScene?
    let agents: AgentRoster
    var onClose: () -> Void = {}
    @State private var boardHeight: CGFloat = 0

    var body: some View {
        ZStack {
            Color.black.opacity(0.42).ignoresSafeArea().onTapGesture(perform: onClose)
            VStack(spacing: 0) {
                HStack(spacing: 9) {
                    Image(systemName: "square.3.layers.3d").font(RT.ui(12)).foregroundStyle(RT.accent)
                    Text("Whiteboard").font(RT.ui(13, weight: .semibold)).foregroundStyle(RT.text)
                    Text("· what the table sketched").font(RT.ui(11.5)).foregroundStyle(RT.textFaint)
                    Spacer(minLength: 0)
                    Button(action: onClose) {
                        Image(systemName: "xmark").font(RT.ui(11, weight: .medium)).foregroundStyle(RT.textMuted)
                            .frame(width: 28, height: 28)
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.border))
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("Close whiteboard")
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .overlay(alignment: .bottom) { Rectangle().fill(RT.border).frame(height: 1) }
                // Laid out at the board's own width, so it is the same drawing as
                // in the room, then scaled up; the run board is not clipped here,
                // so what the room cuts off can be read, scrolling if needed.
                GeometryReader { proxy in
                    let width = RoomLayout.whiteboardSize.width - 22
                    let scale = min(proxy.size.width / width, 1.7)
                    ScrollView {
                        WhiteboardSurface(scene: scene, agents: agents, expanded: true)
                            .frame(width: width)
                            .frame(minHeight: proxy.size.height / scale, alignment: .top)
                            .background(GeometryReader { measured in
                                Color.clear.preference(key: BoardHeightKey.self, value: measured.size.height)
                            })
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                            .scaleEffect(scale, anchor: .topLeading)
                            .frame(width: width * scale, height: boardHeight * scale, alignment: .topLeading)
                            .frame(maxWidth: .infinity)
                    }
                    // The callback is Sendable under Swift 6; hop back to the main actor.
                    .onPreferenceChange(BoardHeightKey.self) { height in
                        Task { @MainActor in boardHeight = height }
                    }
                }
                .padding(16)
            }
            .frame(maxWidth: 980, maxHeight: 660)
            .background(RT.surface, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(RT.borderStrong))
            .shadow(color: .black.opacity(0.35), radius: 40, y: 18)
            .padding(40)
        }
        .accessibilityIdentifier("whiteboard.zoom.panel")
    }
}

private struct MarkerTray: View {
    var body: some View {
        HStack(spacing: 9) {
            ForEach([0xE5687A, 0x5EB0EF, 0x4CC38A] as [UInt32], id: \.self) { hex in
                Capsule().fill(Color(hex: hex)).frame(width: 28, height: 6).offset(y: -5)
                    .shadow(color: .black.opacity(0.3), radius: 1, y: 1)
            }
            RoundedRectangle(cornerRadius: 2).fill(RT.textFaint.opacity(0.8)).frame(width: 20, height: 9).offset(y: -5)
        }
        .frame(width: RoomLayout.whiteboardSize.width * 0.42, height: 14)
        .background(LinearGradient(colors: [RT.borderStrong, RT.surface3], startPoint: .top, endPoint: .bottom),
                    in: BottomRoundedRectangle(radius: 7))
        .shadow(color: .black.opacity(0.3), radius: 6, y: 6)
    }
}

private struct WhiteboardSurface: View {
    let scene: RoundtableScene?
    let agents: AgentRoster
    /// Opened full size: the run board shows everything instead of being
    /// clipped to the frame the room gives it.
    var expanded = false

    private var live: Bool { scene?.live ?? false }
    private var posted: Bool { scene?.planPosted ?? false }

    var body: some View {
        ZStack(alignment: .topLeading) {
            LinearGradient(colors: [RT.mix(RT.surface, 0.84, into: .white), RT.surface], startPoint: .top, endPoint: .init(x: 0.5, y: 0.7))
            DotGrid().opacity(0.5)
            LinearGradient(stops: [
                .init(color: .clear, location: 0.34), .init(color: .white.opacity(0.16), location: 0.45), .init(color: .clear, location: 0.54),
            ], startPoint: .topLeading, endPoint: .bottomTrailing)
            header
                .padding(.top, 16).padding(.leading, 22).padding(.trailing, 64)
            if posted && live, let scene {
                // Web: top 44, left 20, width w − 40, height h − 62; overflow is clipped from the bottom.
                if expanded {
                    LiveRunBoard(scene: scene, agents: agents)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: RoomLayout.whiteboardSize.width - 62, alignment: .top)
                        .padding(.top, 44).padding(.leading, 20).padding(.bottom, 22)
                } else {
                    LiveRunBoard(scene: scene, agents: agents)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(width: RoomLayout.whiteboardSize.width - 62, height: RoomLayout.whiteboardSize.height - 84,
                               alignment: .top)
                        .clipped()
                        .padding(.top, 44).padding(.leading, 20)
                }
            } else {
                Text("the team will sketch the system here…")
                    .font(RT.ui(13)).italic()
                    .foregroundStyle(RT.textFaint)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.top, 46).padding(.horizontal, 20).padding(.bottom, 18)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.3.layers.3d").font(RT.ui(12)).foregroundStyle(RT.textFaint)
            Text(live ? "WORKFLOW BOARD" : "ARCHITECTURE")
                .font(RT.mono(10.5)).tracking(1.47).foregroundStyle(RT.textFaint)
            Text(live ? "· current run" : "· waitlist app")
                .font(RT.ui(12, weight: .semibold)).foregroundStyle(RT.textMuted)
            Spacer(minLength: 0)
            if posted {
                Text(live ? "state map" : "data flow →").font(RT.mono(9.5)).foregroundStyle(RT.textFaint)
            }
        }
        .lineLimit(1)
    }
}

private struct DotGrid: View {
    var body: some View {
        Canvas { context, size in
            let color = RT.mix(RT.textFaint, 0.26, into: .clear)
            var y = 11.0
            while y < size.height {
                var x = 11.0
                while x < size.width {
                    context.fill(Path(ellipseIn: CGRect(x: x - 1, y: y - 1, width: 2, height: 2)), with: .color(color))
                    x += 22
                }
                y += 22
            }
        }
    }
}

/// Port of `LiveRunBoard`: the run map drawn on the whiteboard once a plan exists.
private struct LiveRunBoard: View {
    let scene: RoundtableScene
    let agents: AgentRoster

    private var run: SceneRun { scene.run }
    private var rows: [SceneTask] { Array(SceneProjectorBridge.uniqueTasks(scene.tasks).prefix(5)) }
    private var pending: Bool { run.phase == "planning" }
    private var completed: Bool { run.phase == "completed" || run.dispatchStatus == "completed" }
    private var running: Bool { run.dispatchStatus == "running" || run.phase == "running" || run.phase == "approved" }

    private func owner(of task: SceneTask) -> SceneAgent? {
        if let agent = agents[task.owner] { return agent }
        let role = (task.assignee ?? "").hasPrefix("@") ? String((task.assignee ?? "").dropFirst()) : (task.assignee ?? "")
        return agents.ordered.first { $0.role == role && $0.pm != true } ?? agents["orchestrator"]
    }

    var body: some View {
        let statusColor = completed ? RT.ok : RT.run
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 9) {
                PulsingDot(color: statusColor, size: 9, pulsing: !completed)
                Text("Run board").font(RT.ui(13.5, weight: .heavy)).foregroundStyle(RT.text)
                Text(pending ? "starting agent chain" : completed ? "result ready · \(run.artifactCount ?? 0) artifacts" : "dispatching agents")
                    .font(RT.mono(9.5, weight: .bold)).foregroundStyle(statusColor)
                Spacer(minLength: 0)
                Text("\(rows.count) queued tasks").font(RT.mono(9)).foregroundStyle(RT.textFaint)
            }
            .lineLimit(1)
            HStack(spacing: 5) {
                stageChip("Request", state: "done")
                stageChip("Planning", state: pending ? "active" : "done")
                stageChip("Handoff", state: completed ? "done" : running ? "active" : "todo")
                stageChip("Agents", state: completed ? "done" : running ? "active" : "todo")
                stageChip("Result", state: completed ? "done" : "todo")
            }
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 7) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("WHAT THIS BOARD MEANS").font(RT.ui(10.5, weight: .bold)).tracking(0.84).foregroundStyle(RT.textFaint)
                        Text(pending
                             ? "Planning is running first. Its output becomes the handoff for the next agent."
                             : completed
                             ? "Agents finished the run. Open Files or Code/logs to inspect the website, code, and review output."
                             : "Each agent receives the previous agent output and continues the chain.")
                            .font(RT.ui(11.5)).foregroundStyle(RT.text).lineSpacing(1.5)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RT.surface, in: RoundedRectangle(cornerRadius: 9))
                    .overlay(RoundedRectangle(cornerRadius: 9).stroke(RT.border))
                    VStack(spacing: 5) {
                        ForEach(rows, id: \.id) { task in
                            let color = RT.agentColor(owner(of: task)?.agentId)
                            HStack(spacing: 7) {
                                Text(task.id).font(RT.mono(9, weight: .heavy)).foregroundStyle(color)
                                Text(task.title ?? "").font(RT.ui(10.5, weight: .semibold)).foregroundStyle(RT.text)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                Text(owner(of: task)?.displayName ?? "").font(RT.mono(8.5)).foregroundStyle(RT.textFaint)
                            }
                            .lineLimit(1)
                            .padding(.horizontal, 8).padding(.vertical, 6)
                            .background(RT.tint(color, 7), in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.alpha(color, 24)))
                        }
                    }
                }
                // grid-template-columns: 1.05fr .95fr over 494 − 8 points.
                .frame(width: 255, alignment: .top)
                VStack(spacing: 6) {
                    ForEach(agents.ordered.filter { $0.pm != true }.prefix(4), id: \.agentId) { agent in
                        let color = RT.agentColor(agent.agentId)
                        let count = rows.filter { owner(of: $0)?.agentId == agent.agentId }.count
                        HStack(spacing: 7) {
                            Circle().fill(count > 0 ? color : RT.textFaint).frame(width: 8, height: 8)
                            Text(agent.displayName).font(RT.ui(10.5, weight: .bold)).foregroundStyle(RT.text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(count > 0 ? (completed ? "\(count) done" : "\(count) queued") : "no task")
                                .font(RT.mono(8.5)).foregroundStyle(count > 0 ? color : RT.textFaint)
                        }
                        .lineLimit(1)
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .background(RT.surface, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.alpha(color, count > 0 ? 35 : 16)))
                    }
                    Text("Code/logs are opened from the table button. This board is only the live run map.")
                        .font(RT.ui(9.5)).foregroundStyle(RT.textMuted).lineSpacing(1.2)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 8).padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RT.alpha(RT.warn, 9), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.alpha(RT.warn, 28)))
                }
                .frame(width: 231, alignment: .top)
            }
        }
    }

    private func stageChip(_ label: String, state: String) -> some View {
        let color = state == "done" ? RT.ok : state == "active" ? RT.run : state == "blocked" ? RT.warn : RT.textFaint
        return HStack(spacing: 5) {
            BlinkingDot(color: color, size: 8, blinking: state == "active")
            Text(label).font(RT.ui(9.5, weight: .bold)).foregroundStyle(color).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 7).padding(.vertical, 6)
        .frame(maxWidth: .infinity)
        .background(RT.alpha(color, state == "todo" ? 6 : 12), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.alpha(color, 28)))
    }
}

enum SceneProjectorBridge {
    /// `uniqueTasksById`: last duplicate wins, first position kept.
    static func uniqueTasks(_ tasks: [SceneTask]) -> [SceneTask] {
        var order: [String] = []
        var byId: [String: SceneTask] = [:]
        for task in tasks {
            if byId[task.id] == nil { order.append(task.id) }
            byId[task.id] = task
        }
        return order.compactMap { byId[$0] }
    }
}

// MARK: - Door, table, tray

private struct TableBody: View {
    var body: some View {
        let t = RoomLayout.table
        let size = CGSize(width: t.rx * 2, height: t.ry * 2)
        ZStack(alignment: .topLeading) {
            Ellipse()
                .fill(RadialGradient(colors: [.black.opacity(0.26), .clear], center: .center, startRadius: 0, endRadius: t.rx * 0.72))
                .frame(width: size.width, height: size.height).blur(radius: 26).opacity(0.5)
                .position(x: t.cx, y: t.cy + t.depth + 24)
            // color-mix(surface-3 60%, #000 6%): percentages sum to 66%, so the mix is
            // normalised (≈9% black) and the result keeps 66% opacity.
            Ellipse().fill(RT.mix(.black, 6.0 / 66, into: RT.surface3).opacity(0.66))
                .frame(width: size.width, height: size.height)
                .position(x: t.cx, y: t.cy + t.depth)
            Ellipse()
                .fill(RadialGradient(colors: [RT.mix(RT.surface, 0.92, into: .white), RT.surface2],
                                     center: UnitPoint(x: 0.5, y: 0.28), startRadius: 0, endRadius: t.rx * 1.2))
                .overlay(Ellipse().stroke(RT.border))
                .overlay(Ellipse().stroke(Color.black.opacity(0.06), lineWidth: 14).blur(radius: 14).clipShape(Ellipse()))
                .frame(width: size.width, height: size.height)
                .position(x: t.cx, y: t.cy)
            Ellipse().stroke(RT.textFaint.opacity(0.45), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                .frame(width: size.width * 0.74, height: size.height * 0.74).opacity(0.45)
                .position(x: t.cx, y: t.cy)
        }
        .frame(width: RoomLayout.width, height: RoomLayout.height, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}

private struct DocTray: View {
    let placed: [ScenePlacedArtifact]
    let onOpen: () -> Void

    var body: some View {
        // The Web counts a neutral card for the run log placeholder plus every placed artifact.
        let owners: [String?] = [nil] + placed.map(\.ownerAgentId)
        let top = Array(owners.suffix(3))
        Button(action: onOpen) {
            HStack(spacing: 13) {
                ZStack(alignment: .topLeading) {
                    ForEach(Array(top.enumerated()), id: \.offset) { index, owner in
                        let offset = Double(top.count - 1 - index)
                        let color = owner.map { RT.agentColor($0) } ?? RT.textFaint
                        RT.surface
                            .overlay(alignment: .leading) { color.frame(width: 3) }
                            .overlay(Image(systemName: "chevron.left.forwardslash.chevron.right")
                                .font(RT.ui(14, weight: .medium)).foregroundStyle(color))
                            .frame(width: 60, height: 48)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.border))
                            .shadow(color: .black.opacity(0.35), radius: 8, y: 8)
                            .offset(x: offset * 8, y: offset * 6)
                    }
                }
                .frame(width: 76, height: 56, alignment: .topLeading)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Code & logs").font(RT.ui(18, weight: .semibold)).foregroundStyle(RT.text)
                    HStack(spacing: 4) {
                        Text("\(owners.count) records · open")
                        Image(systemName: "chevron.right").font(RT.ui(11, weight: .semibold))
                    }
                    .font(RT.ui(14)).foregroundStyle(RT.accent)
                }
            }
        }
        .buttonStyle(.plain)
        .help("Open files")
        .accessibilityLabel("Code and logs, \(owners.count) records")
    }
}

// MARK: - Beams and dependency arrows

private struct Beams: View {
    let scene: RoundtableScene?
    let agents: AgentRoster
    let seats: [RoomSeat]

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
            Canvas { context, _ in
                let t = RoomLayout.table
                if let speech = scene?.speech, speech.mode == "working" || speech.mode == "speaking",
                   let seat = seats.first(where: { $0.agentId == speech.agentId }) {
                    let p = RoomLayout.position(angle: seat.angle)
                    var line = Path()
                    line.move(to: CGPoint(x: p.x, y: p.y))
                    line.addLine(to: CGPoint(x: t.cx, y: t.cy))
                    let phase = -(timeline.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.1) / 1.1) * 24
                    context.stroke(line, with: .color(RT.agentColor(speech.agentId).opacity(0.4)),
                                   style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: [1, 9], dashPhase: -phase))
                }
                for edge in RoomLayout.dependencyEdges(tasks: scene?.tasks ?? [], seats: seats, agents: agents) {
                    let a = RoomLayout.position(angle: edge.fromSeat.angle)
                    let b = RoomLayout.position(angle: edge.toSeat.angle)
                    let mx = (a.x + b.x) / 2 + (t.cx - (a.x + b.x) / 2) * 0.5
                    let my = (a.y + b.y) / 2 + (t.cy - (a.y + b.y) / 2) * 0.5
                    let dx = b.x - mx, dy = b.y - my
                    let length = max(hypot(dx, dy), 1)
                    let end = CGPoint(x: b.x - dx / length * 26, y: b.y - dy / length * 26)
                    var curve = Path()
                    curve.move(to: CGPoint(x: a.x, y: a.y))
                    curve.addQuadCurve(to: end, control: CGPoint(x: mx, y: my))
                    let color = RT.agentColor(edge.ownerAgentId)
                    context.stroke(curve, with: .color(color.opacity(0.7)), style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    // Arrowhead aligned with the curve's end tangent (marker refX 6 of a 7-long head).
                    let angle = atan2(end.y - my, end.x - mx)
                    var head = Path()
                    head.move(to: CGPoint(x: -6, y: -4))
                    head.addLine(to: CGPoint(x: 1, y: 0))
                    head.addLine(to: CGPoint(x: -6, y: 4))
                    head.closeSubpath()
                    let transform = CGAffineTransform(translationX: end.x, y: end.y).rotated(by: angle)
                    context.fill(head.applying(transform), with: .color(RT.textMuted.opacity(0.7)))
                }
            }
        }
    }
}

// MARK: - Seats

private struct SeatView: View {
    let seat: RoomSeat
    let agent: SceneAgent?
    let status: String
    let scale: Double
    let speech: SceneSpeech?
    let nowDoing: SceneWork?
    let dimmed: Bool
    @State private var bobbing = false

    private var active: Bool { status == "speaking" || status == "working" || status == "thinking" }
    private var figureSize: Double { ((seat.head ? 56 : 60) * scale).rounded() }
    private var color: Color { seat.isUser ? RT.pm : RT.agentColor(agent?.agentId) }

    var body: some View {
        VStack(spacing: 0) {
            SeatFigure(assetName: seat.isUser ? "you" : (agent?.agentId == "orchestrator" ? "planning" : agent?.agentId ?? ""),
                       name: seat.isUser ? "You" : agent?.displayName ?? "",
                       color: color, size: figureSize, head: seat.head, speaking: active)
                .overlay(alignment: .topTrailing) {
                    if !seat.isUser { statusBadge.offset(x: 3, y: figureSize * 0.05) }
                }
                .offset(y: active || !bobbing ? 0 : -4)
                .animation(active ? .default : .easeInOut(duration: 2.25).repeatForever(autoreverses: true)
                    .delay(seat.angle.truncatingRemainder(dividingBy: 360) / 90), value: bobbing)
            VStack(spacing: 0) {
                Text(seat.isUser ? "You" : agent?.displayName ?? "")
                    .font(RT.ui(18 * scale, weight: .semibold)).foregroundStyle(RT.text)
                Text(seat.isUser ? "chair" : agent?.pm == true ? "facilitator" : "@\(agent?.role ?? "")")
                    .font(RT.ui(13.5 * scale)).foregroundStyle(RT.textFaint)
            }
            .padding(.top, 8)
        }
        .fixedSize()
        // Bubbles hang off a zero-height anchor on the seat's top edge (or, for the
        // head seat, its bottom edge), so they sit fully outside the seat as on the Web.
        .overlay(alignment: .top) {
            if !seat.head {
                Color.clear.frame(height: 0).overlay(alignment: .bottom) {
                    if let speech, let agent {
                        SpeechCard(agent: agent, speech: speech, scale: scale, drop: false).offset(y: -8)
                    } else if let nowDoing, let agent {
                        NowDoingBubble(agent: agent, now: nowDoing, scale: scale).offset(y: -6)
                    }
                }
            }
        }
        .overlay(alignment: .bottom) {
            if seat.head, let speech, let agent {
                Color.clear.frame(height: 0).overlay(alignment: .top) {
                    SpeechCard(agent: agent, speech: speech, scale: scale, drop: true).offset(y: 10)
                }
            }
        }
        .offset(y: active ? -7 : 0)
        .animation(.spring(response: 0.4, dampingFraction: 0.8), value: active)
        .opacity(dimmed ? 0.5 : 1)
        .saturation(dimmed ? 0.7 : 1)
        .onAppear { bobbing = true }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(seat.isUser ? "You, chair" : "\(agent?.displayName ?? ""), \(status)")
    }

    @ViewBuilder
    private var statusBadge: some View {
        let size = 17 * scale
        ZStack {
            Circle().fill(RT.surface)
            switch status {
            case "done":
                Image(systemName: "checkmark").font(RT.ui(9 * scale, weight: .bold)).foregroundStyle(RT.ok)
            case "working":
                ProgressView().controlSize(.mini).tint(color).scaleEffect(0.75 * scale)
            case "thinking":
                Image(systemName: "sparkle").font(RT.ui(9 * scale)).foregroundStyle(RT.textFaint)
            case "speaking":
                Circle().fill(color).frame(width: 7 * scale, height: 7 * scale)
            default:
                Circle().fill(RT.textFaint.opacity(0.5)).frame(width: 7 * scale, height: 7 * scale)
            }
        }
        .frame(width: size, height: size)
        .overlay(Circle().stroke(RT.surface, lineWidth: 2))
    }
}

private struct SeatFigure: View {
    let assetName: String
    let name: String
    let color: Color
    let size: Double
    let head: Bool
    let speaking: Bool
    @State private var glow = false

    var body: some View {
        ZStack(alignment: .top) {
            if head {
                // radial-gradient(circle …) sizes to the farthest corner: 0.8d·√2, transparent at 68%.
                Circle()
                    .fill(RadialGradient(colors: [RT.alpha(color, 24), .clear], center: .center, startRadius: 0, endRadius: size * 0.77))
                    .frame(width: size * 1.6, height: size * 1.6)
                    .offset(y: -size * 0.2)
            }
            Ellipse().fill(Color(red: 40 / 255, green: 40 / 255, blue: 70 / 255).opacity(0.2))
                .frame(width: size * 0.84, height: 11).blur(radius: 5)
                .frame(maxHeight: .infinity, alignment: .bottom).offset(y: 3)
            if speaking {
                Circle().stroke(color.opacity(glow ? 0 : 0.9), lineWidth: glow ? 10 : 0.5)
                    .frame(width: size + (glow ? 10 : 0), height: size + (glow ? 10 : 0))
                    .offset(y: glow ? -5 : 0)
                    .animation(.easeOut(duration: 1.3).repeatForever(autoreverses: false), value: glow)
                    .onAppear { glow = true }
                    .onDisappear { glow = false }
            }
            // box-shadow rings: a surface ring, then a thin identity-colour ring outside it.
            ZStack {
                Circle().fill(RT.alpha(color, 70)).frame(width: size + 2 * max(3, size * 0.075), height: size + 2 * max(3, size * 0.075))
                Circle().fill(RT.surface).frame(width: size + 2 * max(2, size * 0.05), height: size + 2 * max(2, size * 0.05))
                AvatarImage(assetName: assetName, name: name, color: color)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            }
            .frame(width: size, height: size)
            .shadow(color: Color(red: 40 / 255, green: 40 / 255, blue: 70 / 255).opacity(0.35), radius: size * 0.08, y: size * 0.08)
        }
        .frame(width: size, height: size * 1.16, alignment: .top)
    }
}

struct AvatarImage: View {
    let assetName: String
    let name: String
    let color: Color

    var body: some View {
        if let url = Bundle.main.url(forResource: assetName, withExtension: "png"), let image = NSImage(contentsOf: url) {
            Image(nsImage: image).resizable().scaledToFill().background(RT.surface)
        } else {
            ZStack {
                RT.surface2
                Text(String(name.prefix(1)).uppercased()).font(RT.ui(22, weight: .bold)).foregroundStyle(RT.textMuted)
            }
        }
    }
}

private struct RoleTag: View {
    let agent: SceneAgent

    var body: some View {
        let color = RT.agentColor(agent.agentId)
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text("@\(agent.role)")
        }
        .font(RT.mono(11.5, weight: .medium)).foregroundStyle(color)
        .padding(.horizontal, 8).padding(.vertical, 2)
        .background(RT.tint(color, 16), in: RoundedRectangle(cornerRadius: 4))
        .fixedSize()
    }
}

/// Port of `SpeechCard` (the aggregate variant belongs to the demo script only).
private struct SpeechCard: View {
    let agent: SceneAgent
    let speech: SceneSpeech
    let scale: Double
    let drop: Bool

    var body: some View {
        let accent = agent.pm == true ? RT.pm : RT.agentColor(agent.agentId)
        VStack(spacing: 0) {
            if drop { tail(pointingUp: true) }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(agent.displayName).font(RT.ui(15, weight: .bold)).foregroundStyle(accent)
                    if agent.pm == true {
                        Text("FACILITATOR").font(RT.mono(10)).tracking(0.8).foregroundStyle(RT.textFaint)
                    } else {
                        RoleTag(agent: agent)
                    }
                    Spacer(minLength: 0)
                    if speech.steps > 1 {
                        Text("\(speech.step)/\(speech.steps)").font(RT.mono(10.5)).monospacedDigit().foregroundStyle(RT.textFaint)
                    }
                }
                switch speech.mode {
                case "thinking":
                    Label("thinking…", systemImage: "sparkle").font(RT.ui(12.5).italic()).foregroundStyle(RT.textFaint)
                case "working":
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small).tint(accent)
                        Text("working…")
                    }
                    .font(RT.ui(12.5)).foregroundStyle(RT.textMuted)
                default:
                    ScrollView {
                        (Text(speech.text) + Text("▍").foregroundColor(RT.accent))
                            .font(RT.ui(14.25)).foregroundStyle(RT.text).lineSpacing(14.25 * 0.62 - 3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxHeight: 280)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 13).padding(.vertical, 11)
            .background(RT.surface)
            .overlay(alignment: .top) { accent.frame(height: 2.5) }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(RT.border))
            .shadow(color: Color(red: 20 / 255, green: 20 / 255, blue: 30 / 255).opacity(0.28), radius: 20, y: 12)
            if !drop { tail(pointingUp: false) }
        }
        .frame(width: (364 * max(0.94, scale)).rounded())
        .transition(.opacity)
        .accessibilityElement(children: .combine)
    }

    private func tail(pointingUp: Bool) -> some View {
        Rectangle().fill(RT.surface).frame(width: 13, height: 13)
            .overlay(Rectangle().stroke(RT.border))
            .rotationEffect(.degrees(45))
            .frame(width: 13, height: 7, alignment: pointingUp ? .bottom : .top)
            .clipped()
            .offset(y: pointingUp ? 1 : -1)
            .zIndex(1)
    }
}

/// Port of `NowDoingBubble`: a compact per-seat bubble while a task runs.
private struct NowDoingBubble: View {
    let agent: SceneAgent
    let now: SceneWork
    let scale: Double

    var body: some View {
        let accent = agent.pm == true ? RT.pm : RT.agentColor(agent.agentId)
        let text = now.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let shown = text.count > 84 ? String(text.prefix(84)) + "…" : text
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                if now.mode == "thinking" {
                    Image(systemName: "sparkle").font(RT.ui(9))
                } else {
                    ProgressView().controlSize(.mini).tint(accent)
                }
                Text(now.mode == "thinking" ? "thinking" : now.tool.map { "using \($0)" } ?? (now.mode == "starting" ? "starting up" : "working"))
                if now.steps > 1 {
                    Spacer(minLength: 0)
                    Text("step \(now.steps)").fontWeight(.semibold).foregroundStyle(RT.textFaint).monospacedDigit()
                }
            }
            .font(RT.ui(10.5, weight: .bold)).foregroundStyle(accent)
            if !shown.isEmpty && now.mode != "starting" {
                Text(shown).font(RT.ui(11)).foregroundStyle(RT.textMuted).lineSpacing(2)
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .frame(width: (210 * max(0.94, scale)).rounded(), alignment: .leading)
        .background(RT.surface, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.border))
        .overlay(alignment: .leading) { Rectangle().fill(accent).frame(width: 2.5) }
        .shadow(color: .black.opacity(0.1), radius: 10, y: 6)
    }
}

// MARK: - Small animated marks

struct PulsingDot: View {
    let color: Color
    let size: Double
    let pulsing: Bool
    @State private var expanded = false

    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
            .background(
                Circle().stroke(color.opacity(expanded ? 0 : 0.5), lineWidth: expanded ? 7 : 0)
                    .frame(width: size + (expanded ? 7 : 0), height: size + (expanded ? 7 : 0))
                    .opacity(pulsing ? 1 : 0)
            )
            .onAppear {
                guard pulsing else { return }
                withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) { expanded = true }
            }
    }
}

private struct BlinkingDot: View {
    let color: Color
    let size: Double
    let blinking: Bool
    @State private var dim = false

    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
            .opacity(blinking && dim ? 0.2 : 1)
            .onAppear {
                guard blinking else { return }
                withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) { dim = true }
            }
    }
}

// MARK: - Shapes (UnevenRoundedRectangle needs macOS 14; the app targets 13)

private struct DoorShape: Shape {
    let top: Double
    let bottom: Double

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + top))
        path.addArc(center: CGPoint(x: rect.minX + top, y: rect.minY + top), radius: top, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        path.addLine(to: CGPoint(x: rect.maxX - top, y: rect.minY))
        path.addArc(center: CGPoint(x: rect.maxX - top, y: rect.minY + top), radius: top, startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - bottom))
        path.addArc(center: CGPoint(x: rect.maxX - bottom, y: rect.maxY - bottom), radius: bottom, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        path.addLine(to: CGPoint(x: rect.minX + bottom, y: rect.maxY))
        path.addArc(center: CGPoint(x: rect.minX + bottom, y: rect.maxY - bottom), radius: bottom, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        path.closeSubpath()
        return path
    }
}

private struct BottomRoundedRectangle: Shape {
    let radius: Double

    func path(in rect: CGRect) -> Path {
        DoorShape(top: 0, bottom: radius).path(in: rect)
    }
}

private struct BoardHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
