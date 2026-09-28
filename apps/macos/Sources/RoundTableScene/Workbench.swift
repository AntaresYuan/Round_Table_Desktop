import Foundation

// Workbench-level views of a mission, ported from the Web: the sidebar mission
// summary (`turnToTask` in app-root.jsx), the Files list
// (`liveArtifactsFromTurns` in live-scene.js), the workflow recommendation
// banner (`recommendWorkflow` in stage-scene.jsx) and the read-only stage cards
// of the Workflow view (workflow.jsx).

public struct MissionSummary: Equatable, Sendable {
    public enum Status: String, Sendable { case live, done, queued }

    public var id: String
    public var title: String
    public var meta: String
    public var status: Status

    /// Port of `turnToTask`.
    public static func from(_ turn: LiveTurn) -> MissionSummary {
        let title = turn.message.utf16.count > 40
            ? String(decoding: Array(turn.message.utf16.prefix(40)), as: UTF16.self) + "..."
            : turn.message
        if !turn.serverConfirmed {
            return MissionSummary(id: turn.id, title: title, meta: turn.error ?? "saving plan", status: .live)
        }
        if turn.status == "error" {
            return MissionSummary(id: turn.id, title: title, meta: turn.error ?? "failed", status: .queued)
        }
        let result = turn.result
        let count = result?.plan?.tasks.count ?? 0
        let artifactCount = result?.artifacts?.count ?? 0
        let meta: String
        switch result?.dispatchStatus {
        case "completed": meta = "\(artifactCount) artifacts · result ready"
        case "failed": meta = "\(artifactCount) artifacts · failed"
        case "running": meta = "\(count) agents · running"
        default: meta = count > 0 ? "\(count) agents · queued" : "queued"
        }
        let status: Status = result?.dispatchStatus == "completed" ? .done
            : result?.dispatchStatus == "running" || turn.status == "pending" ? .live : .queued
        return MissionSummary(id: turn.id, title: title, meta: meta, status: status)
    }
}

public struct MissionFile: Equatable, Sendable, Identifiable {
    public var id: String
    /// Full artifact title (usually a workspace path).
    public var title: String
    /// Last path component, as the Web's Files row shows it.
    public var name: String
    public var kind: String
    public var version: Int
    public var ownerAgentId: String
    /// "Owner · kind".
    public var subtitle: String
    public var content: String
}

public enum MissionFiles {
    /// Port of `liveArtifactsFromTurns([turn])`: the generated run log first,
    /// then the turn's artifacts deduplicated by id (highest version wins).
    public static func files(for turn: LiveTurn?, agents: AgentRoster) -> [MissionFile] {
        guard let turn else { return [] }
        var files = [runLog(for: turn, agents: agents)]
        var order: [String] = []
        var byId: [String: TurnArtifact] = [:]
        for artifact in turn.result?.artifacts ?? [] {
            if let existing = byId[artifact.id] {
                if (artifact.version ?? 0) >= (existing.version ?? 0) { byId[artifact.id] = artifact }
            } else {
                order.append(artifact.id)
                byId[artifact.id] = artifact
            }
        }
        for id in order {
            guard let artifact = byId[id] else { continue }
            let owner = agents.agentForArtifact(ownerAgentId: artifact.ownerAgentId)
            files.append(file(id: artifact.id, title: artifact.title, kind: artifact.kind, version: artifact.version ?? 1,
                              owner: owner, content: artifact.code ?? artifact.preview ?? ""))
        }
        return files
    }

    static func file(id: String, title: String, kind: String, version: Int, owner: SceneAgent?, content: String) -> MissionFile {
        MissionFile(id: id, title: title, name: title.split(separator: "/").last.map(String.init) ?? title, kind: kind,
                    version: version, ownerAgentId: owner?.agentId ?? "orchestrator",
                    subtitle: owner.map { "\($0.displayName) · \(kind)" } ?? kind, content: content)
    }

    /// The Web's `livePlanArtifact`: a JSON log of the run. The Web also embeds its
    /// dev-server URL and UI status; the replay records its source instead.
    static func runLog(for turn: LiveTurn, agents: AgentRoster) -> MissionFile {
        struct Entry: Encodable {
            var id: String, createdAt: String?, status: String
            var approvalStatus: String?, dispatchStatus: String?, dispatchAdapter: String?
            var artifactCount: Int, workspacePath: String?, taskCount: Int, message: String, error: String?
        }
        struct Log: Encodable { var source: String; var turns: [Entry] }
        let result = turn.result
        let log = Log(source: "replay", turns: [Entry(
            id: turn.id, createdAt: turn.createdAt, status: turn.status, approvalStatus: result?.approvalStatus,
            dispatchStatus: result?.dispatchStatus, dispatchAdapter: result?.dispatchAdapter,
            artifactCount: result?.artifacts?.count ?? 0, workspacePath: result?.dispatchWorkspacePath,
            taskCount: result?.plan?.tasks.count ?? 0, message: turn.message, error: turn.error
        )])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let json = (try? encoder.encode(log)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return file(id: "live-code-log", title: "roundtable-live-run.json", kind: "code", version: 1,
                    owner: agents["orchestrator"], content: json)
    }
}

public struct WorkflowRecommendation: Equatable, Sendable {
    public var id: String
    public var name: String
    public var reason: String

    /// The Web's built-in workflow catalogue (`RT.BUILTIN_WORKFLOWS`).
    public static let builtins: [(id: String, name: String)] = [
        ("wf-fullstack", "Ship a PR-ready feature"),
        ("wf-research", "Research & brief"),
        ("wf-growth", "Landing page that converts"),
    ]

    /// Port of `recommendWorkflow`. The Web compares against its workbench
    /// default (`wf-fullstack`), not the orchestrator template of the run.
    public static func recommend(task: String, currentId: String = "wf-fullstack") -> WorkflowRecommendation? {
        let text = task.lowercased()
        guard text.count >= 4 else { return nil }
        var pick = "wf-fullstack"
        var reason = "A full build → review → ship loop fits a feature like this."
        if text.range(of: #"research|brief|spec|investigat|explore|compare|analy|gather|source|study|audit"#, options: .regularExpression) != nil {
            pick = "wf-research"
            reason = "This reads like research — gather → synthesize → brief fits better."
        } else if text.range(of: #"landing|marketing|convert|sign\s?up|wait\s?list|campaign|\bseo\b|hero|pricing page"#, options: .regularExpression) != nil {
            pick = "wf-growth"
            reason = "This is a marketing page — brief → build → QA → launch fits better."
        }
        guard pick != currentId, let workflow = builtins.first(where: { $0.id == pick }) else { return nil }
        return WorkflowRecommendation(id: workflow.id, name: workflow.name, reason: reason)
    }
}

public struct WorkflowStageCard: Equatable, Sendable, Identifiable {
    public struct Seat: Equatable, Sendable {
        public var agentId: String?
        public var label: String
        public var role: String
    }

    public var id: String
    public var index: Int
    public var name: String
    public var icon: String?
    public var desc: String?
    public var seats: [Seat]
    /// The template's gate label, or nil when the stage has no gate.
    public var gateLabel: String?
    public var fixed: Bool

    /// Read-only stage cards for the Workflow view.
    public static func cards(for workflow: WorkflowTemplate, agents: AgentRoster) -> [WorkflowStageCard] {
        workflow.stages.enumerated().map { index, stage in
            let seats = (stage.seats ?? []).map { seat -> Seat in
                guard seat.ref.kind == "role" else { return Seat(agentId: nil, label: "You", role: "user") }
                let agent = seat.ref.agentId.flatMap { agents[$0] }
                    ?? agents.ordered.first { $0.role == seat.ref.role }
                return Seat(agentId: agent?.agentId, label: agent?.displayName ?? seat.ref.role ?? "agent",
                            role: seat.ref.role ?? agent?.role ?? "agent")
            }
            let gate = stage.gate.flatMap { $0.kind == "none" ? nil : $0.label }
            return WorkflowStageCard(id: stage.id, index: index + 1, name: stage.name, icon: stage.icon, desc: stage.desc,
                                     seats: seats, gateLabel: gate, fixed: stage.fixed == true)
        }
    }
}
