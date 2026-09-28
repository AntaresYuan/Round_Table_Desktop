import Foundation

// UI-layer mirror of a stored orchestrator Turn, as returned by the Web's
// GET /api/orchestrator/history and recorded in TurnTimeline fixtures. Only the
// fields the native UI reads are modelled; unknown fields are ignored. This is
// a display DTO, not a security contract: it never passes the Host Runtime v1
// exact-key validators. See docs/architecture/macos-native-ui-parity-replay.md.

public struct RoundtableTurn: Codable, Equatable, Sendable {
    public var id: String
    public var localChatId: String?
    public var missionId: String?
    public var workflowTemplateId: String?
    public var message: String
    public var status: String
    public var createdAt: String?
    public var provider: String?
    public var model: String?
    public var needsApproval: Bool?
    public var approvalStatus: String?
    public var dispatchStatus: String?
    public var dispatchAdapter: String?
    public var dispatchStage: String?
    public var dispatchError: String?
    public var dispatchWorkspacePath: String?
    public var needsClarification: Bool?
    public var intake: TurnIntake?
    public var mission: TurnMission?
    public var dispatch: [DispatchRecord]?
    public var artifacts: [TurnArtifact]?
    public var plan: TurnPlan?
    public var planningMeeting: PlanningMeeting?
    public var workflow: WorkflowTemplate?
    public var workflowRun: WorkflowRun?
    public var liveActivity: [String: TaskLiveActivity]?
    public var error: String?
}

public struct TurnArtifact: Codable, Equatable, Sendable {
    public var id: String
    public var kind: String
    public var title: String
    public var ownerAgentId: String
    public var version: Int?
    public var uri: String?
    public var preview: String?
    public var code: String?
}

public struct TurnPlan: Codable, Equatable, Sendable {
    public var summary: String?
    public var tasks: [PlanTask]
}

public struct PlanTask: Codable, Equatable, Sendable {
    public var id: String
    public var title: String?
    public var assignee: String?
    public var owner: String?
    public var role: String?
    public var stageId: String?
    public var brief: String?
    public var objective: String?
    public var deps: [String]?
    public var parallel: Bool?
    public var acceptanceCriteria: [String]?
    public var stageKind: String?
}

public struct TurnIntake: Codable, Equatable, Sendable {
    public var intentType: String?
    public var risk: String?
    public var clarity: String?
}

public struct TurnMission: Codable, Equatable, Sendable {
    public var id: String
    public var status: String
    public var workflowTemplateName: String?
    public var currentStageId: String?
    public var stages: [MissionStage]?
    public var checkpoints: [MissionCheckpoint]?
    public var finalDelivery: FinalDelivery?
}

public struct MissionStage: Codable, Equatable, Sendable {
    public var id: String
    public var name: String?
}

public struct MissionCheckpoint: Codable, Equatable, Sendable {
    public var status: String
    public var requiredAction: String?
}

public struct FinalDelivery: Codable, Equatable, Sendable {
    public var status: String
    public var recommendation: String?
    public var confidence: String?
    public var testsObserved: Bool?
    public var risks: [String]?
}

public struct DispatchRecord: Codable, Equatable, Sendable {
    public var taskId: String
    public var agentId: String?
    public var status: String
    public var events: [DispatchEvent]?
    public var artifactIds: [String]?
}

public struct DispatchEvent: Codable, Equatable, Sendable {
    public struct Input: Codable, Equatable, Sendable {
        public var path: String?
        public var title: String?
    }

    public var type: String
    public var delta: String?
    public var name: String?
    public var input: Input?
}

public struct PlanningMeeting: Codable, Equatable, Sendable {
    public var participants: [String]?
    public var messages: [MeetingMessage]
}

public struct MeetingMessage: Codable, Equatable, Sendable {
    public var id: String
    public var phase: String?
    public var agentId: String
    public var role: String?
    public var content: String
}

/// The whole template, not just what the read-only view draws: editing writes
/// these back, so every field the orchestrator reads has to survive the round
/// trip. `planning` and the capability lists are carried untouched by the editor.
public struct WorkflowTemplate: Codable, Equatable, Sendable {
    public struct Planning: Codable, Equatable, Sendable {
        public var cut: String?
        public var clarifyThreshold: Double?
        public var maxClarifyQuestions: Int?

        public init(cut: String? = "by_capability", clarifyThreshold: Double? = 0.6, maxClarifyQuestions: Int? = 3) {
            self.cut = cut
            self.clarifyThreshold = clarifyThreshold
            self.maxClarifyQuestions = maxClarifyQuestions
        }
    }

    public var id: String
    public var name: String
    public var tag: String?
    public var desc: String?
    public var builtin: Bool?
    public var version: Int?
    public var updatedAt: String?
    public var planning: Planning?
    public var stages: [WorkflowStage]

    public init(id: String, name: String, tag: String? = nil, desc: String? = nil, builtin: Bool? = nil,
                version: Int? = nil, updatedAt: String? = nil, planning: Planning? = nil, stages: [WorkflowStage]) {
        self.id = id
        self.name = name
        self.tag = tag
        self.desc = desc
        self.builtin = builtin
        self.version = version
        self.updatedAt = updatedAt
        self.planning = planning
        self.stages = stages
    }
}

public struct WorkflowStage: Codable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var icon: String?
    public var kind: String?
    public var desc: String?
    public var fixed: Bool?
    /// Set to the stage's own id when its seats run concurrently.
    public var parallelGroup: String?
    public var seats: [StageSeat]?
    public var gate: StageGate?
    public var requiredInputs: [String]?
    public var expectedOutputs: [String]?
    public var requiredCapabilities: [String]?

    public init(id: String, name: String, icon: String? = nil, kind: String? = nil, desc: String? = nil,
                fixed: Bool? = nil, parallelGroup: String? = nil, seats: [StageSeat]? = nil, gate: StageGate? = nil,
                requiredInputs: [String]? = nil, expectedOutputs: [String]? = nil,
                requiredCapabilities: [String]? = nil) {
        self.id = id
        self.name = name
        self.icon = icon
        self.kind = kind
        self.desc = desc
        self.fixed = fixed
        self.parallelGroup = parallelGroup
        self.seats = seats
        self.gate = gate
        self.requiredInputs = requiredInputs
        self.expectedOutputs = expectedOutputs
        self.requiredCapabilities = requiredCapabilities
    }
}

public struct StageGate: Codable, Equatable, Sendable {
    public var kind: String
    public var label: String?
    public var required: Bool?
    public var description: String?
    public var actions: [String]?

    public init(kind: String, label: String? = nil, required: Bool? = nil, description: String? = nil,
                actions: [String]? = nil) {
        self.kind = kind
        self.label = label
        self.required = required
        self.description = description
        self.actions = actions
    }
}

public struct StageSeat: Codable, Equatable, Sendable {
    public struct Ref: Codable, Equatable, Sendable {
        public var kind: String
        public var role: String?
        public var agentId: String?

        public init(kind: String, role: String? = nil, agentId: String? = nil) {
            self.kind = kind
            self.role = role
            self.agentId = agentId
        }
    }

    public var ref: Ref

    public init(ref: Ref) { self.ref = ref }

    public static let user = StageSeat(ref: Ref(kind: "user"))
    public static func role(_ role: String, _ agentId: String? = nil) -> StageSeat {
        StageSeat(ref: Ref(kind: "role", role: role, agentId: agentId))
    }
}

public struct WorkflowRun: Codable, Equatable, Sendable {
    public var activeStageId: String?
    /// Keyed by stage id and by task id; task entries carry the per-task status.
    public var stageStates: [String: StageState]?
}

public struct StageState: Codable, Equatable, Sendable {
    public var status: String?
    public var taskIds: [String]?
    public var artifactIds: [String]?
    public var seatRuns: [SeatRun]?
}

public struct SeatRun: Codable, Equatable, Sendable {
    public var agentId: String?
    public var status: String?
    public var artifactIds: [String]?
}

public struct TaskLiveActivity: Codable, Equatable, Sendable {
    public var status: String?
    public var agentId: String?
    public var transcript: [TranscriptEntry]?
    public var runtime: String?
    public var error: String?

    public init(status: String?, agentId: String?, transcript: [TranscriptEntry]?, runtime: String? = nil, error: String? = nil) {
        self.status = status
        self.agentId = agentId
        self.transcript = transcript
        self.runtime = runtime
        self.error = error
    }
}

public struct TranscriptEntry: Codable, Equatable, Sendable {
    public var kind: String
    public var content: String
}

/// The client-side turn the Web keeps in state (`localTurns`). A planned or
/// finished server turn carries its snapshot as `result`; a turn the client
/// created before the planning request returns is `pending` with no result.
public struct LiveTurn: Equatable, Sendable {
    public var id: String
    public var chatId: String?
    public var message: String
    public var status: String
    public var createdAt: String?
    public var serverConfirmed: Bool
    public var error: String?
    public var result: RoundtableTurn?

    public init(id: String, chatId: String?, message: String, status: String, createdAt: String?,
                serverConfirmed: Bool, error: String? = nil, result: RoundtableTurn? = nil) {
        self.id = id
        self.chatId = chatId
        self.message = message
        self.status = status
        self.createdAt = createdAt
        self.serverConfirmed = serverConfirmed
        self.error = error
        self.result = result
    }

    /// Port of `storedTurnToLiveTurn` in src/ui/lib/live-scene.js.
    public init(stored turn: RoundtableTurn) {
        self.init(id: turn.id, chatId: turn.localChatId, message: turn.message, status: turn.status,
                  createdAt: turn.createdAt, serverConfirmed: true)
        if turn.status == "error" {
            error = turn.error ?? "orchestrator_turn_failed"
        } else if turn.status == "done" {
            result = turn
        }
    }

    /// The turn the Web shows between "Start Mission" and the planning response.
    public static func pending(id: String, chatId: String?, message: String, createdAt: String?) -> LiveTurn {
        LiveTurn(id: id, chatId: chatId, message: message, status: "pending", createdAt: createdAt, serverConfirmed: false)
    }
}
