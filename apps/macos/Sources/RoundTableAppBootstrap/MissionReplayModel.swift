#if SWIFT_PACKAGE
import RoundTableScene
#endif
import Foundation
import SwiftUI

/// Drives the roundtable from a `TurnSource`. In S2 the source replays the
/// bundled TurnTimeline fixture; the Host Runtime stream replaces it in S3.
/// Meeting playback timing follows the Web (`planningMessageDuration`).
@MainActor
final class MissionReplayModel: ObservableObject {
    /// Workbench members in seating order (`RT.WORKBENCH.members` on the Web).
    static let memberIds = ["orchestrator", "mira", "atlas", "beam", "vera", "nova", "fixer"]
    static let agents = AgentRoster([
        SceneAgent(agentId: "orchestrator", role: "planner", displayName: "Planning", mention: "planning", pm: true),
        SceneAgent(agentId: "mira", role: "pm", displayName: "Mira", mention: "pm"),
        SceneAgent(agentId: "atlas", role: "implementer", displayName: "Atlas", mention: "atlas"),
        SceneAgent(agentId: "beam", role: "implementer", displayName: "Beam", mention: "beam"),
        SceneAgent(agentId: "vera", role: "reviewer", displayName: "Vera", mention: "vera"),
        SceneAgent(agentId: "nova", role: "architect", displayName: "Nova", mention: "nova"),
        SceneAgent(agentId: "fixer", role: "fixer", displayName: "Fixer", mention: "fixer"),
    ])

    @Published private(set) var turns: [LiveTurn] = []
    @Published private(set) var playback = MeetingPlayback.idle
    @Published private(set) var awaiting: TurnGate?
    /// Set between "Start building" and the next recorded frame (the Web's `approving`).
    @Published private(set) var approving = false
    /// A delivery decision made in this replay; the recording has none.
    @Published private(set) var deliveryDecision: String?
    @Published private(set) var isRunning = false
    @Published private(set) var loadError: String?
    /// Debug captures only: keeps the chat scrolled to its last card.
    private(set) var chatAnchorsToBottom = false

    /// The replay sources bundled with the app.
    enum Source: String, CaseIterable {
        case recorded = "feature-builder-local-dispatch"
        case syntheticLive = "feature-builder-synthetic-live"

        var title: String {
            switch self {
            case .recorded: "Recorded run"
            case .syntheticLive: "Synthetic live activity"
            }
        }
    }

    /// Chosen in Mission › Replay Source; read when a mission starts.
    @Published var source: Source {
        didSet { UserDefaults.standard.set(source.rawValue, forKey: "replaySource") }
    }
    private var timelines: [Source: TurnTimeline] = [:]
    /// The timeline of the running replay (or the one the next mission will use).
    var timeline: TurnTimeline? { timelines[activeSource ?? source] }
    private var activeSource: Source?
    private let speed: Double
    private var turnSource: (any TurnSource)?
    private var playTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var meetingTimer: Task<Void, Never>?
    private var meetingPlayedFor: Set<String> = []

    init(bundle: Bundle = .main, environment: [String: String] = ProcessInfo.processInfo.environment) {
        speed = environment["ROUNDTABLE_REPLAY_SPEED"].flatMap(Double.init) ?? 1
        source = Source(rawValue: environment["ROUNDTABLE_REPLAY_SOURCE"]
            ?? UserDefaults.standard.string(forKey: "replaySource") ?? "") ?? .recorded
        for candidate in Source.allCases {
            guard let url = bundle.url(forResource: "\(candidate.rawValue).timeline", withExtension: "json") else { continue }
            if let decoded = try? TurnTimeline.decode(Data(contentsOf: url)) { timelines[candidate] = decoded }
        }
        if timelines[.recorded] == nil { loadError = "Replay fixture is not bundled." }
        #if DEBUG
        // Screenshot parity runs drive the replay without synthetic input events.
        autoResolveGates = environment["ROUNDTABLE_REPLAY_AUTOAPPROVE"] == "1"
        gatePause = environment["ROUNDTABLE_REPLAY_GATE_PAUSE"].flatMap(Double.init) ?? 3
        chatAnchorsToBottom = environment["ROUNDTABLE_CHAT_ANCHOR"] == "bottom"
        if environment["ROUNDTABLE_REPLAY_AUTOSTART"] == "1" {
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(1.5))
                self?.start()
            }
        }
        #endif
    }

    #if DEBUG
    private var autoResolveGates = false
    private var gatePause = 3.0

    /// Resolves each gate after a short pause so every state can be captured.
    private func autoResolveIfRequested() {
        guard autoResolveGates else { return }
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(self?.gatePause ?? 3))
            guard let self else { return }
            if self.canApprovePlan { self.approvePlan() }
            else if self.canDecideDelivery { self.decideDelivery("accept") }
            else if self.awaiting != nil { self.autoResolveIfRequested() }
        }
    }
    #endif

    var agents: AgentRoster { Self.agents }
    var latestTurn: LiveTurn? { turns.last }
    var scene: RoundtableScene? { SceneProjector.project(turns: turns, agents: agents, playback: playback) }
    /// The workflow shown in the strip: the run's own, else the recorded template.
    var workflow: WorkflowTemplate? { latestTurn?.result?.workflow ?? timeline?.frames.first?.turn.workflow }
    /// The exact goal and workflow represented by the selected bundled fixture.
    /// The S2 UI displays these read-only so it cannot imply arbitrary execution.
    var fixtureGoal: String { timeline?.frames.first?.turn.message ?? "Recorded mission unavailable" }
    var fixtureWorkflowName: String { timeline?.frames.first?.turn.workflow?.name ?? "Feature Builder" }
    var workflowRun: WorkflowRun? { latestTurn?.result?.workflowRun }
    var canStart: Bool { timeline != nil && !isRunning }
    var thread: MissionThread? {
        latestTurn.map { MissionThread.build(turn: $0, meetingComplete: playback.meetingComplete, agents: agents,
                                             deliveryDecision: deliveryDecision) }
    }
    /// The Files tab and the table tray: the run log plus the turn's artifacts.
    var files: [MissionFile] { MissionFiles.files(for: latestTurn, agents: agents) }
    var summary: MissionSummary? { latestTurn.map(MissionSummary.from) }
    var canApprovePlan: Bool { awaiting == .planApproval && playback.meetingComplete && !approving }
    var canDecideDelivery: Bool { awaiting == .deliveryDecision && deliveryDecision == nil }

    /// "Start building": continues the replay past the recorded plan approval.
    func approvePlan() {
        guard canApprovePlan else { return }
        approving = true
        resolve(.planApproval)
    }

    /// Only acceptance can be replayed; repair and tests would need a new run.
    func decideDelivery(_ decision: String) {
        guard canDecideDelivery, decision == "accept" else { return }
        deliveryDecision = decision
        resolve(.deliveryDecision)
    }

    /// Whether the running replay is synthesized rather than recorded.
    var isSynthetic: Bool { (activeSource ?? source) == .syntheticLive }

    /// Replays the recorded mission from the beginning.
    func start() {
        stop()
        activeSource = source
        guard let timeline = timelines[source] else { return }
        let source: any TurnSource = activeSource == .recorded
            ? HostRuntimeTurnSource(goal: timeline.frames[0].turn.message,
                                    workflowTemplateId: timeline.frames[0].turn.workflowTemplateId
                                        ?? "wf-feature-builder")
            : ReplayTurnSource(timeline: timeline, speed: speed)
        turnSource = source
        isRunning = true
        meetingPlayedFor = []
        eventTask = Task { [weak self] in
            for await event in source.events {
                self?.handle(event)
            }
        }
        playTask = Task { await source.startMission() }
    }

    func resolve(_ gate: TurnGate) {
        guard awaiting == gate, let turnSource else { return }
        awaiting = nil
        Task { await turnSource.resolve(gate) }
    }

    func stop() {
        let source = turnSource
        playTask?.cancel()
        eventTask?.cancel()
        meetingTimer?.cancel()
        playTask = nil
        eventTask = nil
        meetingTimer = nil
        turnSource = nil
        if let source { Task { await source.cancel() } }
        turns = []
        playback = .idle
        awaiting = nil
        approving = false
        deliveryDecision = nil
        isRunning = false
    }

    private func handle(_ event: TurnSourceEvent) {
        switch event {
        case .turns(let next):
            if next.last?.result?.approvalStatus == "approved" { approving = false }
            turns = next
            // The Web starts meeting playback when a planned turn first arrives.
            if let turn = next.last, let messages = turn.result?.planningMeeting?.messages, !messages.isEmpty,
               !meetingPlayedFor.contains(turn.id) {
                meetingPlayedFor.insert(turn.id)
                playback = .starting
                scheduleMeetingStep(messages: messages)
            }
        case .awaiting(let gate):
            awaiting = gate
            #if DEBUG
            autoResolveIfRequested()
            #endif
        case .failed(let error):
            loadError = error
            isRunning = false
            awaiting = nil
        case .finished:
            isRunning = false
            awaiting = nil
        }
    }

    private func scheduleMeetingStep(messages: [MeetingMessage]) {
        meetingTimer?.cancel()
        guard !playback.meetingComplete else { return }
        let current = messages[min(playback.meetingMessageIndex, messages.count - 1)]
        let delay = Double(MeetingPlayback.durationMs(for: current.content)) / speed
        meetingTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(delay)))
            guard !Task.isCancelled, let self else { return }
            self.playback = self.playback.advanced(messageCount: messages.count)
            self.scheduleMeetingStep(messages: messages)
        }
    }
}
