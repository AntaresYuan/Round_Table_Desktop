import Foundation

// The chat thread for one mission turn, ported from src/ui/components/live-turn.jsx
// (`LocalLiveTurn` and its cards) and src/ui/lib/plan-presentation.js. The view
// layer renders these models; every decision about which card shows and what
// it says lives here so it can be tested against the recorded fixture.

public enum CardTone: String, Equatable, Sendable {
    case ok, run, warn, bad, faint, accent
}

public struct ThreadArtifact: Equatable, Sendable, Identifiable {
    public var id: String
    public var title: String
    public var kind: String
    public var version: Int
    public var ownerAgentId: String
    /// `@role` label shown on the row.
    public var ownerLabel: String
    public var content: String
}

public struct MissionHeaderModel: Equatable, Sendable {
    public var missionId: String
    public var templateName: String
    public var statusLabel: String
    public var tone: CardTone
    public var completed: Bool
    public var stageLine: String
}

public struct PlanTodoRow: Equatable, Sendable, Identifiable {
    public var id: String
    public var cliNumber: Int
    public var ownerAgentId: String
    public var title: String
    public var objective: String
    public var metaLine: String
    public var status: String
    public var acceptanceCriteria: [String]
    public var activity: [String]
}

public struct PlanCardModel: Equatable, Sendable {
    public var doneCount: Int
    public var total: Int
    public var intakeLine: String
    public var approved: Bool
    public var summary: String
    public var rows: [PlanTodoRow]
}

public struct ChainRecordModel: Equatable, Sendable, Identifiable {
    public var id: String
    public var ownerAgentId: String
    public var ownerName: String
    public var mention: String
    public var status: String
    public var title: String?
    public var artifacts: [ThreadArtifact]
}

/// Port of `LiveTranscriptFeed`: a running task's conversation transcript.
public struct LiveFeedModel: Equatable, Sendable, Identifiable {
    public var id: String
    public var agentId: String
    public var displayName: String
    public var runtime: String?
    public var status: String
    public var entries: [TranscriptEntry]
    public var error: String?
    /// The placeholder the Web shows before the first entry.
    public var emptyText: String { status == "running" ? "Starting up — no output yet…" : "No live output captured." }
}

public struct AgentChainModel: Equatable, Sendable {
    public var statusText: String
    public var tone: CardTone
    public var adapter: String?
    public var records: [ChainRecordModel]
    /// Transcripts of tasks that have no dispatch record yet (shown while running).
    public var liveFeeds: [LiveFeedModel]
    public var waitingText: String?
    public var workspacePath: String?
}

public struct StageSeatModel: Equatable, Sendable {
    public var agentId: String
    public var displayName: String
    public var role: String
    public var status: String
    public var statusLabel: String
    public var tone: CardTone
}

public struct StageCardModel: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var icon: String?
    public var desc: String?
    public var status: String
    public var statusLabel: String
    public var tone: CardTone
    public var seats: [StageSeatModel]
    public var artifacts: [ThreadArtifact]
    /// Compact transcripts for the stage's tasks while it is active or failed.
    public var liveFeeds: [LiveFeedModel]
    public var showsWorking: Bool
}

public struct ResultCardModel: Equatable, Sendable {
    public var title: String
    public var metaLine: String
    public var statusText: String
    public var tone: CardTone
    public var completed: Bool
    /// Delivery is ready and still waiting for the user's decision.
    public var awaitingDecision: Bool
    public var decisionBanner: String?
    public var errorText: String?
    public var artifacts: [ThreadArtifact]
    public var workspacePath: String?
}

public struct MissionThread: Equatable, Sendable {
    public var message: String
    /// False while the turn is pending or its planning meeting is still playing:
    /// the Web then shows only the user's message.
    public var showsRun: Bool
    public var header: MissionHeaderModel?
    public var errorText: String?
    public var needsClarification: Bool
    public var plan: PlanCardModel?
    public var chain: AgentChainModel?
    public var stages: [StageCardModel]
    public var result: ResultCardModel?

    /// Port of `LocalLiveTurn`. `deliveryDecision` overlays a decision the user
    /// made locally (replay) on top of the recorded `finalDelivery`.
    public static func build(turn: LiveTurn, meetingComplete: Bool, agents: AgentRoster,
                             deliveryDecision: String? = nil) -> MissionThread {
        let result = turn.result
        let meetingPlaying = result?.planningMeeting != nil && !meetingComplete
        let planningOnly = turn.status == "pending" || meetingPlaying
        let dispatchStatus = result?.dispatchStatus
        let awaitingApproval = result != nil
            && result?.needsClarification != true
            && !meetingPlaying
            && result?.approvalStatus != "approved"
            && dispatchStatus == "not_started"
        var thread = MissionThread(message: turn.message, showsRun: !planningOnly, header: nil,
                                   errorText: turn.status == "error" ? turn.error : nil,
                                   needsClarification: result?.needsClarification == true,
                                   plan: nil, chain: nil, stages: [], result: nil)
        guard !planningOnly else { return thread }
        var mission = result?.mission
        if let decision = deliveryDecision, mission?.finalDelivery?.status == "ready" {
            mission?.finalDelivery?.status = decision == "accept" ? "accepted" : "rejected"
        }
        thread.header = mission.map { header(mission: $0, workflow: result?.workflow) }
        guard let result else { return thread }
        let artifacts = result.artifacts ?? []
        if awaitingApproval {
            thread.plan = planCard(result: result, agents: agents)
        } else if result.needsClarification != true {
            thread.chain = agentChain(result: result, artifacts: artifacts, agents: agents)
            thread.stages = stageCards(result: result, artifacts: artifacts, agents: agents)
            let running = dispatchStatus == "running"
            let failed = dispatchStatus == "failed"
            if dispatchStatus == "completed" || failed || running {
                thread.result = resultCard(result: result, mission: mission, artifacts: artifacts, agents: agents)
            }
        }
        return thread
    }

    // MARK: Mission header

    static func header(mission: TurnMission, workflow: WorkflowTemplate?) -> MissionHeaderModel {
        let styles: [String: (String, CardTone)] = [
            "awaiting_clarification": ("needs details", .warn), "awaiting_approval": ("awaiting approval", .warn),
            "running": ("running", .run), "blocked": ("blocked", .warn), "completed": ("ready", .ok), "failed": ("failed", .bad),
        ]
        let style = styles[mission.status] ?? styles["awaiting_approval"]!
        let checkpoint = (mission.checkpoints ?? []).first { $0.status == "pending" || $0.status == "blocked" }
        let stageName = workflow?.stages.first { $0.id == mission.currentStageId }?.name
            ?? mission.stages?.first { $0.id == mission.currentStageId }?.name
        var line = stageName.map { "Current stage: \($0)" } ?? "Preparing mission state"
        if let action = checkpoint?.requiredAction, !action.isEmpty { line += " · \(action)" }
        return MissionHeaderModel(missionId: mission.id, templateName: mission.workflowTemplateName ?? workflow?.name ?? "Workflow",
                                  statusLabel: style.0, tone: style.1, completed: mission.status == "completed", stageLine: line)
    }

    // MARK: Plan card

    static func planCard(result: RoundtableTurn, agents: AgentRoster) -> PlanCardModel {
        let tasks = result.plan?.tasks ?? []
        let approved = result.approvalStatus == "approved"
        let intake = result.intake
        func owner(_ task: PlanTask) -> SceneAgent? {
            if let id = task.owner, let agent = agents[id] { return agent }
            let target = stripAt(task.assignee ?? "@planning")
            return agents[target] ?? agents.ordered.first { $0.role == target && $0.pm != true } ?? agents["orchestrator"]
        }
        let labels = Dictionary(tasks.map { ($0.id, conciseTaskTitle($0, owner: owner($0))) }, uniquingKeysWith: { first, _ in first })
        let rows = tasks.enumerated().map { index, task -> PlanTodoRow in
            let record = result.dispatch?.first { $0.taskId == task.id }
            let status = todoStatus(record: record, approved: approved, dispatchStatus: result.dispatchStatus)
            let deps = task.deps ?? []
            var meta = task.assignee ?? "@planner"
            if task.parallel == true { meta += " · parallel" }
            meta += deps.isEmpty ? " · ready after approval" : " · starts after \(deps.map { labels[$0] ?? $0 }.joined(separator: " + "))"
            let activity = (record?.events ?? []).filter { $0.type == "thinking_delta" || $0.type == "tool_use" }.prefix(6).map { event in
                event.type == "tool_use" ? "\(event.name ?? "")(\(event.input?.path ?? event.input?.title ?? ""))" : event.delta ?? ""
            }
            return PlanTodoRow(id: task.id, cliNumber: index + 1, ownerAgentId: owner(task)?.agentId ?? "orchestrator",
                               title: labels[task.id] ?? task.id, objective: planTaskObjective(task), metaLine: meta,
                               status: status, acceptanceCriteria: task.acceptanceCriteria ?? [], activity: Array(activity))
        }
        return PlanCardModel(
            doneCount: rows.filter { $0.status == "completed" }.count,
            total: tasks.count,
            intakeLine: "intent=\(intake?.intentType ?? "build") · risk=\(intake?.risk ?? "medium") · clarity=\(intake?.clarity ?? "medium")",
            approved: approved,
            summary: planSummaryForDisplay(result.plan),
            rows: rows
        )
    }

    /// Port of `todoStatusFor` in src/ui/lib/agent-utils.js.
    static func todoStatus(record: DispatchRecord?, approved: Bool, dispatchStatus: String?) -> String {
        if record?.status == "completed" || record?.status == "failed" { return record!.status }
        if record?.status == "running" { return "running" }
        if approved && dispatchStatus == "running" { return "running" }
        return "pending"
    }

    /// Port of `conciseTaskTitle`.
    static func conciseTaskTitle(_ task: PlanTask, owner: SceneAgent?) -> String {
        let stage = task.stageKind ?? task.stageId
        switch task.role {
        case "pm": return "Product direction"
        case "architect": return stage == "review" ? "Architecture check" : "Architecture direction"
        case "implementer": return "Build · \(owner?.displayName ?? "Implementer")"
        case "reviewer": return "Review the build"
        case "fixer": return "Apply review fixes"
        default: return String((task.title ?? "Assigned task").prefix(64))
        }
    }

    /// Port of `planSummaryForDisplay`.
    static func planSummaryForDisplay(_ plan: TurnPlan?) -> String {
        let summary = (plan?.summary ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if !summary.isEmpty, summary.range(of: #"^(?:Executable plan after|Meeting closed with)\b"#,
                                           options: [.regularExpression, .caseInsensitive]) == nil {
            return summary
        }
        let tasks = plan?.tasks ?? []
        let zh = tasks.contains { hasCJK("\($0.brief ?? "") \($0.title ?? "")") }
        return zh
            ? "主要执行计划共 \(tasks.count) 个 CLI 任务；确认后按下面的前置依赖顺序执行。"
            : "\(tasks.count) CLI tasks make up the main execution plan; after approval they run in the dependency order below."
    }

    /// Port of `planTaskObjective`.
    static func planTaskObjective(_ task: PlanTask) -> String {
        let explicit = (task.objective ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let agreed = explicit.isEmpty ? briefSection(task.brief, label: "Planning meeting objective") : explicit
        let placeholder = #"(?:awaiting plan|awaits the build|^Architecture\s*[·:]|^Build\s*[·:]|^Review\s*[·:])"#
        if !agreed.isEmpty, agreed.range(of: placeholder, options: [.regularExpression, .caseInsensitive]) == nil {
            return agreed
        }
        let goal = compactGoal(userRequest(task.brief).isEmpty ? task.title ?? "" : userRequest(task.brief))
        let zh = hasCJK("\(goal) \(task.brief ?? "")")
        let stage = task.stageKind ?? task.stageId
        switch (task.role, zh) {
        case ("architect", true) where stage == "review": return "复核实现是否遵守已经确定的模块边界、复用方式和依赖关系，并指出集成风险。"
        case ("architect", true): return "检查真实代码入口和可复用部分，确定页面结构、数据流、模块边界与实现约束。"
        case ("implementer", true): return "在现有项目中完成核心页面与交互：\(goal.isEmpty ? "用户确认的功能" : goal)，并提供可运行结果和移动端验证。"
        case ("reviewer", true): return "独立检查构建结果是否覆盖需求、关键交互和移动端，列出带证据的阻塞或回归问题。"
        case ("fixer", true): return "只修复审查确认的问题，并补充对应的回归验证。"
        case (_, true): return goal.isEmpty ? "完成分配的工作，并附上验证证据。" : goal
        case ("architect", false) where stage == "review":
            return "Check that the implementation follows the agreed module boundaries, reuse strategy, and dependencies, and flag integration risk."
        case ("architect", false):
            return "Inspect the real entrypoint and reusable code, then define page structure, data flow, module boundaries, and implementation constraints."
        case ("implementer", false):
            return "Build the core pages and interactions in the existing project for: \(goal.isEmpty ? "the approved scope" : goal), with a runnable result and mobile verification."
        case ("reviewer", false):
            return "Independently check requirement coverage, critical interactions, mobile behavior, and regressions, with evidence for every blocker."
        case ("fixer", false): return "Repair only the confirmed review findings and add matching regression evidence."
        default: return goal.isEmpty ? "Complete the assigned work and attach verification evidence." : goal
        }
    }

    private static let briefLabels = "Clarified requirements|Planning meeting objective|Acceptance criteria|Locked prerequisites"

    static func briefSection(_ brief: String?, label: String) -> String {
        let escaped = NSRegularExpression.escapedPattern(for: label)
        return firstCapture(in: brief ?? "", pattern: "(?:^|\\n\\n)\(escaped):\\s*([\\s\\S]*?)(?=\\n\\n(?:\(briefLabels)):|$)")
    }

    static func userRequest(_ brief: String?) -> String {
        firstCapture(in: brief ?? "", pattern: "User request:\\s*([\\s\\S]*?)(?=\\n\\n(?:\(briefLabels)):|$)")
    }

    static func compactGoal(_ value: String, max: Int = 76) -> String {
        let clean = value
            .replacingOccurrences(of: #"\s*Clarified requirements:[\s\S]*$"#, with: "", options: [.regularExpression, .caseInsensitive])
            .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.utf16.count > max else { return clean }
        let prefix = String(decoding: Array(clean.utf16.prefix(max)), as: UTF16.self)
        return prefix.trimmingCharacters(in: .whitespacesAndNewlines) + "…"
    }

    // MARK: Agent chain

    static func agentChain(result: RoundtableTurn, artifacts: [TurnArtifact], agents: AgentRoster) -> AgentChainModel {
        let tasks = result.plan?.tasks ?? []
        let records = result.dispatch ?? []
        let status = result.dispatchStatus
        func owner(_ task: PlanTask?, _ record: DispatchRecord) -> SceneAgent? {
            if let id = task?.owner, let agent = agents[id] { return agent }
            if let id = record.agentId, let agent = agents[id] { return agent }
            let target = stripAt(task?.assignee ?? record.agentId ?? "")
            return agents[target] ?? agents.ordered.first { $0.role == target && $0.pm != true } ?? agents["orchestrator"]
        }
        let chainRecords = records.map { record -> ChainRecordModel in
            let task = tasks.first { $0.id == record.taskId }
            let agent = owner(task, record)
            let ids = Set(record.artifactIds ?? [])
            let matched = ids.isEmpty
                ? artifacts.filter { $0.id.hasPrefix("\(record.taskId)_") }
                : artifacts.filter { ids.contains($0.id) }
            // Real workspace files sort before this system's own run logs (stable).
            let sorted = matched.enumerated().sorted { lhs, rhs in
                let l = lhs.element.title.hasPrefix(".roundtable/runs/") ? 1 : 0
                let r = rhs.element.title.hasPrefix(".roundtable/runs/") ? 1 : 0
                return l == r ? lhs.offset < rhs.offset : l < r
            }.map(\.element)
            return ChainRecordModel(
                id: record.taskId, ownerAgentId: agent?.agentId ?? "orchestrator", ownerName: agent?.displayName ?? "Planning",
                mention: agent?.mention ?? agent?.agentId ?? agent?.role ?? "", status: record.status, title: task?.title,
                artifacts: sorted.map { row($0, owner: agent) }
            )
        }
        // The Web passes liveActivity to the chain only while the dispatch runs.
        let liveFeeds = status == "running"
            ? feeds(result.liveActivity, taskIds: orderedActivityIds(result.liveActivity, tasks: tasks), agents: agents)
                .filter { feed in !records.contains { $0.taskId == feed.id } }
            : []
        let waiting: String?
        if records.isEmpty && liveFeeds.isEmpty {
            waiting = status == "failed" && result.dispatchError != nil ? result.dispatchError : "Waiting for the first agent output."
        } else {
            waiting = nil
        }
        return AgentChainModel(
            statusText: status == "completed" ? "run complete" : status == "failed" ? "run failed" : "running",
            tone: status == "completed" ? .ok : status == "failed" ? .bad : .run,
            adapter: result.dispatchAdapter, records: chainRecords, liveFeeds: liveFeeds, waitingText: waiting,
            workspacePath: result.dispatchWorkspacePath
        )
    }

    // MARK: Stage cards

    static func stageCards(result: RoundtableTurn, artifacts: [TurnArtifact], agents: AgentRoster) -> [StageCardModel] {
        guard let workflow = result.workflow, let run = result.workflowRun else { return [] }
        func status(_ stage: WorkflowStage) -> String { run.stageStates?[stage.id]?.status ?? "pending" }
        let stages = workflow.stages.filter { stage in
            stage.kind != "intake" && !(stage.seats ?? []).isEmpty && (stage.kind != "repair" || status(stage) != "pending")
        }
        let running = result.dispatchStatus == "running"
        let firstUnfinished = stages.first { status($0) != "done" && status($0) != "completed" }?.id
        let visible = stages.filter { status($0) != "pending" || (running && $0.id == firstUnfinished) }
        return visible.map { stage in
            var stageRun = run.stageStates?[stage.id] ?? StageState()
            var stageStatus = stageRun.status ?? "pending"
            if stageStatus == "running" {
                stageStatus = "active"
            } else if running && stageStatus == "pending" && stage.id == firstUnfinished {
                stageStatus = "active"
                let seatRuns = stageRun.seatRuns ?? (stage.seats ?? []).map { seat in
                    SeatRun(agentId: seat.ref.kind == "role" ? seat.ref.agentId ?? seat.ref.role : "user", status: "pending", artifactIds: [])
                }
                stageRun.seatRuns = seatRuns.map { SeatRun(agentId: $0.agentId, status: $0.status == "done" ? "done" : "active", artifactIds: $0.artifactIds) }
            }
            let style = stageStyle(stageStatus)
            let roles = Set((stage.seats ?? []).compactMap { $0.ref.kind == "role" ? $0.ref.role : nil })
            let explicitIds = Set(stageRun.artifactIds ?? [])
            let taskIds = Set(stageRun.taskIds ?? [])
            let recordIds = Set((result.dispatch ?? []).filter { taskIds.contains($0.taskId) }.flatMap { $0.artifactIds ?? [] })
            let stageArtifacts = artifacts.filter { artifact in
                explicitIds.contains(artifact.id) || recordIds.contains(artifact.id)
                    || taskIds.contains { artifact.id.hasPrefix("\($0)_") } || roles.contains(artifact.ownerAgentId)
            }
            let stageFeeds = feeds(result.liveActivity, taskIds: stageRun.taskIds ?? [], agents: agents)
            let seats = (stageRun.seatRuns ?? []).enumerated().map { index, seatRun -> StageSeatModel in
                let seat = (stage.seats ?? []).indices.contains(index) ? stage.seats?[index] : nil
                let role = seat?.ref.kind == "role" ? seat?.ref.role ?? "user" : "user"
                let agent = agents[seatRun.agentId ?? ""] ?? agents.ordered.first { $0.role == role } ?? agents["orchestrator"]
                let seatStyle = stageStyle(seatRun.status ?? "pending")
                return StageSeatModel(agentId: agent?.agentId ?? "orchestrator", displayName: agent?.displayName ?? "",
                                      role: agent?.role ?? role, status: seatRun.status ?? "pending",
                                      statusLabel: seatStyle.label, tone: seatStyle.tone)
            }
            return StageCardModel(
                id: stage.id, name: stage.name, icon: stage.icon, desc: stage.desc, status: stageStatus,
                statusLabel: style.label, tone: style.tone, seats: seats,
                artifacts: stageArtifacts.map { row($0, owner: agents.agentForArtifact(ownerAgentId: $0.ownerAgentId)) },
                liveFeeds: stageStatus == "active" || stageStatus == "failed" ? stageFeeds : [],
                showsWorking: stageStatus == "active" && stageArtifacts.isEmpty && stageFeeds.isEmpty
            )
        }
    }

    /// `STAGE_STATUS_STYLE`.
    static func stageStyle(_ status: String) -> (label: String, tone: CardTone) {
        switch status {
        case "done": ("done", .ok)
        case "running", "active": ("running", .accent)
        case "blocked": ("blocked", .warn)
        case "failed": ("failed", .bad)
        default: ("pending", .faint)
        }
    }

    static func feeds(_ activity: [String: TaskLiveActivity]?, taskIds: [String], agents: AgentRoster) -> [LiveFeedModel] {
        taskIds.compactMap { taskId in
            guard let entry = activity?[taskId] else { return nil }
            let agent = entry.agentId.flatMap { agents[$0] } ?? agents["orchestrator"]
            return LiveFeedModel(id: taskId, agentId: agent?.agentId ?? "orchestrator", displayName: agent?.displayName ?? "Planning",
                                 runtime: entry.runtime, status: entry.status ?? "running",
                                 entries: entry.transcript ?? [], error: entry.error)
        }
    }

    /// `Object.entries(liveActivity)` order: the Web keeps insertion order; here plan order, then the rest by key.
    static func orderedActivityIds(_ activity: [String: TaskLiveActivity]?, tasks: [PlanTask]) -> [String] {
        guard let activity else { return [] }
        let planned = tasks.map(\.id).filter { activity[$0] != nil }
        return planned + activity.keys.filter { !planned.contains($0) }.sorted()
    }

    // MARK: Result card

    static func resultCard(result: RoundtableTurn, mission: TurnMission?, artifacts: [TurnArtifact],
                           agents: AgentRoster) -> ResultCardModel {
        let status = result.dispatchStatus
        let completed = status == "completed"
        let delivery = mission?.finalDelivery
        let reportReady = delivery?.status == "ready"
        let codeCount = artifacts.filter { $0.kind == "code" }.count
        let reviewCount = artifacts.filter { $0.ownerAgentId == "reviewer" }.count
        let meta = [
            "\(artifacts.count) artifacts", "\(codeCount) code", "\(reviewCount) review",
            "confidence=\(delivery?.confidence ?? "unknown")",
            "tests=\(delivery?.testsObserved == true ? "observed" : "missing")",
            "risks=\(delivery?.risks?.count ?? 0)",
            "delivery=\(reportReady ? delivery?.recommendation ?? "" : "not_ready")",
            "adapter=\(result.dispatchAdapter ?? "local-dispatch")",
            "next=\(result.dispatchStage ?? "done")",
        ].joined(separator: " · ")
        let banner: String? = switch delivery?.status {
        case "accepted": "Final delivery accepted."
        case "rejected": "Repair requested for final delivery."
        default: nil
        }
        return ResultCardModel(
            title: completed ? "Delivery ready" : "Delivery in progress", metaLine: meta,
            statusText: status ?? "not_started", tone: completed ? .ok : status == "failed" ? .bad : .run,
            completed: completed, awaitingDecision: reportReady, decisionBanner: banner,
            errorText: status == "failed" ? result.dispatchError : nil,
            artifacts: artifacts.prefix(8).map { row($0, owner: agents.agentForArtifact(ownerAgentId: $0.ownerAgentId)) },
            workspacePath: result.dispatchWorkspacePath
        )
    }

    // MARK: Helpers

    static func row(_ artifact: TurnArtifact, owner: SceneAgent?) -> ThreadArtifact {
        ThreadArtifact(id: artifact.id, title: artifact.title, kind: artifact.kind, version: artifact.version ?? 1,
                       ownerAgentId: owner?.agentId ?? artifact.ownerAgentId,
                       ownerLabel: "@\(owner?.role ?? artifact.ownerAgentId)",
                       content: artifact.preview ?? "")
    }

    static func stripAt(_ value: String) -> String { value.hasPrefix("@") ? String(value.dropFirst()) : value }

    static func hasCJK(_ value: String) -> Bool {
        value.unicodeScalars.contains { (0x3400...0x9FFF).contains($0.value) }
    }

    static func firstCapture(in text: String, pattern: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1, let range = Range(match.range(at: 1), in: text) else { return "" }
        return String(text[range]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
