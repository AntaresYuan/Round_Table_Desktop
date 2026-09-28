import Foundation

// Port of the live-run scene projection in src/ui/lib/live-scene.js
// (`buildLocalScene` and its helpers). Given the client turns and the meeting
// playback position it produces what the roundtable shows: per-seat status,
// the current speech bubble, task states and the artifacts placed on the table.
// Parity with the Web is checked frame by frame against goldens generated from
// the Web's own code (scripts/generate-turn-scenes.mjs).

public struct SceneAgent: Codable, Equatable, Sendable {
    public var agentId: String
    public var role: String
    public var displayName: String
    public var mention: String?
    public var pm: Bool?

    public init(agentId: String, role: String, displayName: String, mention: String? = nil, pm: Bool? = nil) {
        self.agentId = agentId
        self.role = role
        self.displayName = displayName
        self.mention = mention
        self.pm = pm
    }
}

/// Agents in seating order. The Web iterates its agent map in insertion order
/// for role lookups, so the order is part of the projection's behaviour.
public struct AgentRoster: Equatable, Sendable {
    public let ordered: [SceneAgent]
    private let byId: [String: SceneAgent]

    public init(_ agents: [SceneAgent]) {
        ordered = agents
        byId = Dictionary(agents.map { ($0.agentId, $0) }, uniquingKeysWith: { first, _ in first })
    }

    public subscript(id: String) -> SceneAgent? { byId[id] }

    var orchestrator: SceneAgent? { byId["orchestrator"] }

    /// Port of `agentForArtifact` in src/ui/lib/agent-utils.js.
    func agentForArtifact(ownerAgentId: String) -> SceneAgent? {
        if let agent = byId[ownerAgentId] { return agent }
        return ordered.first { $0.role == ownerAgentId && $0.pm != true } ?? orchestrator
    }
}

public struct MeetingPlayback: Codable, Equatable, Sendable {
    public var meetingMessageIndex: Int
    public var meetingComplete: Bool

    public init(meetingMessageIndex: Int = 0, meetingComplete: Bool = true) {
        self.meetingMessageIndex = meetingMessageIndex
        self.meetingComplete = meetingComplete
    }

    /// Playback for a freshly planned turn: the meeting starts at its first message.
    public static let starting = MeetingPlayback(meetingMessageIndex: 0, meetingComplete: false)
    /// No meeting is playing (none, already played, or a different turn is selected).
    public static let idle = MeetingPlayback()

    /// The next playback state once the current message has been shown for its duration.
    public func advanced(messageCount: Int) -> MeetingPlayback {
        guard !meetingComplete else { return self }
        if meetingMessageIndex >= messageCount - 1 {
            return MeetingPlayback(meetingMessageIndex: meetingMessageIndex, meetingComplete: true)
        }
        return MeetingPlayback(meetingMessageIndex: meetingMessageIndex + 1, meetingComplete: false)
    }

    /// Port of `planningMessageDuration`: 27 ms per UTF-16 unit, clamped to 6–11 s.
    public static func durationMs(for content: String) -> Int {
        min(11_000, max(6_000, content.utf16.count * 27))
    }
}

public struct SceneSpeech: Codable, Equatable, Sendable {
    public var agentId: String
    public var mode: String
    public var text: String
    public var phase: String?
    public var step: Int
    public var steps: Int
}

public struct SceneWork: Codable, Equatable, Sendable {
    public var taskId: String
    public var mode: String
    public var text: String
    public var tool: String?
    public var steps: Int
}

public struct SceneRun: Codable, Equatable, Sendable {
    public var phase: String
    public var message: String
    public var meetingStep: Int?
    public var meetingSteps: Int?
    public var error: String?
    public var provider: String?
    public var model: String?
    public var dispatchStatus: String?
    public var artifactCount: Int?
    public var workspacePath: String?
}

public struct SceneTask: Codable, Equatable, Sendable {
    public var id: String
    public var title: String?
    public var assignee: String?
    public var owner: String
    public var role: String?
    public var stageId: String?
    public var brief: String?
    public var objective: String?
    public var deps: [String]?
    public var parallel: Bool?
    public var acceptanceCriteria: [String]?
    public var status: String
}

public struct ScenePlacedArtifact: Codable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var kind: String
    public var version: Int?
    public var ownerAgentId: String
}

public struct RoundtableScene: Codable, Equatable, Sendable {
    public var live: Bool
    public var started: Bool
    public var status: [String: String]
    public var speech: SceneSpeech?
    public var planPosted: Bool
    public var work: [String: SceneWork]
    public var run: SceneRun
    public var tasks: [SceneTask]
    public var placed: [ScenePlacedArtifact]
}

public enum SceneProjector {
    /// Port of `buildLocalScene`. Returns nil when no turn is live, where the
    /// Web keeps showing its base (idle) scene.
    public static func project(turns: [LiveTurn], agents: AgentRoster, playback: MeetingPlayback) -> RoundtableScene? {
        guard let latest = latestLiveTurn(turns) else { return nil }
        var status = Dictionary(uniqueKeysWithValues: agents.ordered.map { ($0.agentId, "idle") })
        let result = latest.result
        let completed = result?.dispatchStatus == "completed"
        status["orchestrator"] = latest.status == "pending" ? "working" : result != nil ? "done" : "idle"

        let meeting = result?.planningMeeting
        let messages = meeting?.messages ?? []
        let meetingActive = latest.status == "pending" || (!messages.isEmpty && !playback.meetingComplete)
        if meetingActive {
            let index = max(0, min(playback.meetingMessageIndex, max(0, messages.count - 1)))
            let message = messages.indices.contains(index) ? messages[index] : nil
            for participant in meeting?.participants ?? ["orchestrator"] where status[participant] != nil {
                status[participant] = "thinking"
            }
            let speech: SceneSpeech
            if let message {
                speech = SceneSpeech(
                    agentId: agents[message.agentId] != nil ? message.agentId : "orchestrator",
                    mode: "speaking",
                    text: meetingSpeechText(message.content),
                    phase: message.phase,
                    step: index + 1,
                    steps: max(messages.count, 1)
                )
            } else {
                speech = SceneSpeech(agentId: "orchestrator", mode: "speaking", text: pendingSpeech(for: latest.message),
                                     phase: "opening", step: 1, steps: 1)
            }
            status[speech.agentId] = "speaking"
            return RoundtableScene(
                live: true, started: true, status: status, speech: speech, planPosted: false, work: [:],
                run: SceneRun(phase: "planning_meeting", message: latest.message,
                              meetingStep: index + 1, meetingSteps: max(messages.count, 1)),
                tasks: [], placed: []
            )
        }

        var roleCursor: [String: Int] = [:]
        func owner(for task: PlanTask) -> SceneAgent? {
            if let owner = task.owner, let agent = agents[owner] { return agent }
            let target = (task.assignee ?? "").hasPrefix("@") ? String((task.assignee ?? "").dropFirst()) : (task.assignee ?? "")
            if let agent = agents[target] { return agent }
            let candidates = agents.ordered.filter { $0.role == target && $0.pm != true }
            guard !candidates.isEmpty else { return agents.orchestrator }
            let index = roleCursor[target] ?? 0
            roleCursor[target] = index + 1
            return candidates[index % candidates.count]
        }

        let stageStates = result?.workflowRun?.stageStates ?? [:]
        let stageToTaskStatus = ["done": "completed", "failed": "failed", "blocked": "blocked",
                                 "running": "running", "pending": "pending"]
        let liveTasks: [SceneTask] = uniqueById(result?.plan?.tasks ?? [], id: \.id).map { task in
            let ownerId = owner(for: task)?.agentId ?? "orchestrator"
            let taskStatus: String
            if let stageStatus = stageStates[task.id]?.status, !stageStatus.isEmpty {
                taskStatus = stageToTaskStatus[stageStatus] ?? "pending"
            } else {
                taskStatus = completed ? "completed" : result?.dispatchStatus == "running" ? "running" : "pending"
            }
            status[ownerId] = taskStatus == "completed" ? "done" : taskStatus == "running" ? "working" : "idle"
            return SceneTask(id: task.id, title: task.title, assignee: task.assignee, owner: ownerId, role: task.role,
                             stageId: task.stageId, brief: task.brief, objective: task.objective, deps: task.deps,
                             parallel: task.parallel, acceptanceCriteria: task.acceptanceCriteria, status: taskStatus)
        }

        let work = workByAgent(result?.liveActivity, tasks: liveTasks, agents: agents)
        for (agentId, now) in work {
            status[agentId] = now.mode == "thinking" ? "thinking" : "working"
        }

        let phase: String
        if completed {
            phase = "completed"
        } else if result?.dispatchStatus == "running" {
            phase = "running"
        } else if result?.dispatchStatus == "not_started" && result?.approvalStatus != "approved" {
            phase = "awaiting_approval"
        } else {
            phase = "running"
        }

        return RoundtableScene(
            live: true, started: true, status: status, speech: nil, planPosted: result?.plan != nil, work: work,
            run: SceneRun(phase: phase, message: latest.message, error: latest.error, provider: result?.provider,
                          model: result?.model, dispatchStatus: result?.dispatchStatus,
                          artifactCount: result?.artifacts?.count ?? 0, workspacePath: result?.dispatchWorkspacePath),
            tasks: liveTasks,
            placed: result?.plan != nil ? placedArtifacts(for: latest, agents: agents) : []
        )
    }

    /// Port of `meetingSpeechText`: collapse whitespace per line, drop blank
    /// lines, and cap at 520 UTF-16 units with an ellipsis.
    public static func meetingSpeechText(_ content: String) -> String {
        let lines = content.replacingOccurrences(of: "\r", with: "")
            .components(separatedBy: "\n")
            .map { line in
                line.replacingOccurrences(of: "[ \\t]+", with: " ", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .filter { !$0.isEmpty }
        let spoken = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard spoken.utf16.count > 520 else { return spoken }
        let prefix = String(decoding: Array(spoken.utf16.prefix(520)), as: UTF16.self)
        return prefix.trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }

    static func pendingSpeech(for message: String) -> String {
        let hasCJK = message.unicodeScalars.contains { (0x3400...0x9FFF).contains($0.value) }
        return hasCJK
            ? "我先读取项目上下文，然后请团队依次从计划、架构、执行和风险角度发言。"
            : "I am reading the project context, then the team will speak in order: plan, architecture, execution, and risk."
    }

    /// Port of `latestLiveTurn`: the newest turn that is planned, pending or failed.
    static func latestLiveTurn(_ turns: [LiveTurn]) -> LiveTurn? {
        let candidates = turns.filter { $0.result != nil || $0.status == "pending" || $0.status == "error" }
        func time(_ turn: LiveTurn) -> Double {
            if let createdAt = turn.createdAt, let date = parseISODate(createdAt) {
                return date.timeIntervalSince1970 * 1000
            }
            if turn.id.hasPrefix("live-"), let millis = Double(turn.id.dropFirst(5)),
               turn.id.dropFirst(5).allSatisfy(\.isASCII), turn.id.dropFirst(5).allSatisfy(\.isNumber) {
                return millis
            }
            return 0
        }
        // Stable: among equal times the earlier turn wins, as with Array.prototype.sort.
        return candidates.enumerated().max { lhs, rhs in
            let (l, r) = (time(lhs.element), time(rhs.element))
            return l == r ? lhs.offset > rhs.offset : l < r
        }?.element
    }

    /// Port of `workByAgent`: the running task transcripts become "now doing" bubbles.
    /// The Web iterates `liveActivity` in object key order; here tasks follow plan order,
    /// then any remaining keys sorted, which only differs when one agent runs two tasks at once.
    static func workByAgent(_ activity: [String: TaskLiveActivity]?, tasks: [SceneTask],
                            agents: AgentRoster) -> [String: SceneWork] {
        guard let activity else { return [:] }
        let planned = tasks.map(\.id).filter { activity[$0] != nil }
        let rest = activity.keys.filter { !planned.contains($0) }.sorted()
        var work: [String: SceneWork] = [:]
        for taskId in planned + rest {
            guard let entry = activity[taskId], entry.status == "running" else { continue }
            let task = tasks.first { $0.id == taskId }
            let agentId = entry.agentId.flatMap { agents[$0] != nil ? $0 : nil } ?? task?.owner
            guard let agentId else { continue }
            let transcript = entry.transcript ?? []
            let latest = transcript.last
            let mode: String
            switch latest?.kind {
            case nil: mode = "starting"
            case "thinking": mode = "thinking"
            case "status": mode = "working"
            default: mode = "speaking"
            }
            let tool = latest?.kind == "status"
                ? latest?.content.replacingOccurrences(of: "^Using\\s+", with: "", options: [.regularExpression, .caseInsensitive])
                : nil
            work[agentId] = SceneWork(taskId: taskId, mode: mode, text: latest?.content ?? "Starting up…",
                                      tool: tool, steps: transcript.count)
        }
        return work
    }

    /// Identity of what `liveArtifactsFromTurns([latest])` places on the table:
    /// the generated run log first, then the turn's artifacts deduplicated by id.
    /// Preview HTML bundling does not change identity or order and is not ported here.
    static func placedArtifacts(for turn: LiveTurn, agents: AgentRoster) -> [ScenePlacedArtifact] {
        let runLog = ScenePlacedArtifact(id: "live-code-log", title: "roundtable-live-run.json", kind: "code",
                                         version: 1, ownerAgentId: "orchestrator")
        var order: [String] = []
        var byId: [String: ScenePlacedArtifact] = [:]
        for artifact in turn.result?.artifacts ?? [] {
            let owner = agents.agentForArtifact(ownerAgentId: artifact.ownerAgentId)?.agentId ?? "orchestrator"
            let placed = ScenePlacedArtifact(id: artifact.id, title: artifact.title, kind: artifact.kind,
                                             version: artifact.version, ownerAgentId: owner)
            if let existing = byId[artifact.id] {
                if (artifact.version ?? 0) >= (existing.version ?? 0) { byId[artifact.id] = placed }
            } else {
                order.append(artifact.id)
                byId[artifact.id] = placed
            }
        }
        return [runLog] + order.compactMap { byId[$0] }
    }

    /// Map-by-id where the last duplicate wins but keeps the first position (JS `Map` semantics).
    static func uniqueById<T>(_ items: [T], id: (T) -> String) -> [T] {
        var order: [String] = []
        var byId: [String: T] = [:]
        for item in items {
            let key = id(item)
            if byId[key] == nil { order.append(key) }
            byId[key] = item
        }
        return order.compactMap { byId[$0] }
    }

    static func parseISODate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        return ISO8601DateFormatter().date(from: value)
    }
}
