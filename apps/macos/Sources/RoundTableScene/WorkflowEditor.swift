import Foundation

// Editing a workflow template. The Web keeps the same operations in
// `src/ui/components/workflow.jsx`; the differences are deliberate and listed
// in docs/architecture/macos-native-ui-parity-replay.md §4:
//   * every gate kind the orchestrator understands can be set, and an unknown
//     kind is carried through instead of being silently downgraded;
//   * the rules the Web only learns from a server error are checked here,
//     before a template can be saved.

/// The gate kinds the editor offers, in menu order.
public struct GateOption: Equatable, Sendable, Identifiable {
    public var kind: String
    public var label: String
    public var icon: String
    public var hint: String
    /// Gates the orchestrator raises on its own; the user picks the others.
    public var required: Bool

    public var id: String { kind }

    public init(kind: String, label: String, icon: String, hint: String, required: Bool) {
        self.kind = kind
        self.label = label
        self.icon = icon
        self.hint = hint
        self.required = required
    }

    public static let all: [GateOption] = [
        .init(kind: "none", label: "No gate", icon: "dot",
              hint: "Flows straight through.", required: false),
        .init(kind: "requirement_clarification", label: "Clarification", icon: "search",
              hint: "The planner pauses when the request is too vague.", required: true),
        .init(kind: "plan_approval", label: "Plan approval", icon: "check",
              hint: "Pauses for you to approve the plan before any agent runs.", required: true),
        .init(kind: "handoff_acceptance", label: "Handoff accepted", icon: "layers",
              hint: "The next stage inspects the handoff before it starts.", required: false),
        .init(kind: "reviewer_signoff", label: "Reviewer sign-off", icon: "eye",
              hint: "A reviewer must approve before the run continues.", required: true),
        .init(kind: "test_failure_repair", label: "Repair on failure", icon: "wrench",
              hint: "Runs only when tests or review report a failure.", required: false),
        .init(kind: "final_delivery_acceptance", label: "Delivery acceptance", icon: "rocket",
              hint: "Pauses for you to accept or reject the final delivery.", required: true),
    ]

    public static func option(for kind: String?) -> GateOption? {
        guard let kind else { return nil }
        return all.first { $0.kind == kind }
    }
}

public enum WorkflowEditor {
    /// The icons a stage can be given, in picker order.
    public static let iconOptions = ["clip", "search", "layers", "code", "eye", "wrench", "rocket", "check"]
    /// Stage kinds that do actual work; a template needs at least one.
    public static let runnableKinds: Set<String> = ["plan", "work", "review"]

    // MARK: - Stages

    /// Inserts a stage after `index`. Intake stays first, so `index` is never
    /// below zero; unlike the Web, appending after the last stage is allowed.
    public static func insertStage(into template: WorkflowTemplate, after index: Int,
                                   id: String = "stage-\(UUID().uuidString.prefix(8))") -> WorkflowTemplate {
        var next = template
        let stage = WorkflowStage(id: id, name: "New stage", icon: "layers", kind: "work",
                                  desc: "Describe what happens here.", seats: [], gate: StageGate(kind: "none"),
                                  requiredInputs: [], expectedOutputs: [], requiredCapabilities: [])
        let position = min(max(index + 1, 1), next.stages.count)
        next.stages.insert(stage, at: position)
        return next
    }

    /// Moves a stage by `offset` places. Out-of-range moves are no-ops.
    public static func moveStage(in template: WorkflowTemplate, at index: Int, by offset: Int) -> WorkflowTemplate {
        let target = index + offset
        guard template.stages.indices.contains(index), template.stages.indices.contains(target) else { return template }
        var next = template
        let stage = next.stages.remove(at: index)
        next.stages.insert(stage, at: target)
        return next
    }

    /// Fixed stages (Intake) cannot be removed, as on the Web.
    public static func removeStage(from template: WorkflowTemplate, at index: Int) -> WorkflowTemplate {
        guard template.stages.indices.contains(index), template.stages[index].fixed != true else { return template }
        var next = template
        next.stages.remove(at: index)
        return next
    }

    public static func updateStage(in template: WorkflowTemplate, at index: Int,
                                   _ change: (inout WorkflowStage) -> Void) -> WorkflowTemplate {
        guard template.stages.indices.contains(index) else { return template }
        var next = template
        change(&next.stages[index])
        return next
    }

    /// Sets a gate by kind, filling in the label, hint and required flag the
    /// orchestrator expects. An unknown kind keeps whatever the template had.
    public static func setGate(in template: WorkflowTemplate, at index: Int, kind: String) -> WorkflowTemplate {
        updateStage(in: template, at: index) { stage in
            guard let option = GateOption.option(for: kind) else { return }
            if option.kind == "none" {
                stage.gate = StageGate(kind: "none", label: stage.gate?.label, required: false,
                                       description: stage.gate?.description, actions: [])
            } else {
                stage.gate = StageGate(kind: option.kind, label: option.label, required: option.required,
                                       description: option.hint, actions: stage.gate?.actions ?? [])
            }
        }
    }

    /// Seats of one stage run concurrently when the stage carries its own id.
    public static func toggleParallel(in template: WorkflowTemplate, at index: Int) -> WorkflowTemplate {
        updateStage(in: template, at: index) { stage in
            stage.parallelGroup = stage.parallelGroup == nil ? stage.id : nil
        }
    }

    public static func addSeat(to template: WorkflowTemplate, at index: Int, seat: StageSeat) -> WorkflowTemplate {
        updateStage(in: template, at: index) { stage in
            var seats = stage.seats ?? []
            // The Web allows the same agent twice; a seat is a slot, not a set.
            seats.append(seat)
            stage.seats = seats
        }
    }

    public static func removeSeat(from template: WorkflowTemplate, at index: Int, seatIndex: Int) -> WorkflowTemplate {
        updateStage(in: template, at: index) { stage in
            guard var seats = stage.seats, seats.indices.contains(seatIndex) else { return }
            seats.remove(at: seatIndex)
            stage.seats = seats
        }
    }

    // MARK: - Presets

    /// A stage you can drop into a workflow. Presets are derived from the
    /// built-in templates rather than invented here, so every one of them is a
    /// stage the orchestrator already knows how to run.
    public struct StagePreset: Equatable, Sendable, Identifiable {
        public var id: String
        public var name: String
        public var icon: String?
        public var kind: String
        public var desc: String?
        public var gateLabel: String?
        /// The stage this preset copies, minus its identity.
        public var stage: WorkflowStage

        public init(id: String, name: String, icon: String?, kind: String, desc: String?, gateLabel: String?,
                    stage: WorkflowStage) {
            self.id = id
            self.name = name
            self.icon = icon
            self.kind = kind
            self.desc = desc
            self.gateLabel = gateLabel
            self.stage = stage
        }
    }

    /// One preset per stage kind, in the order the built-ins run them. Intake is
    /// left out: every workflow already has one and it cannot be removed.
    public static func presets(from templates: [WorkflowTemplate]) -> [StagePreset] {
        var presets: [StagePreset] = []
        var seen: Set<String> = ["intake"]
        for template in templates {
            for stage in template.stages {
                let kind = stage.kind ?? "work"
                guard seen.insert(kind).inserted else { continue }
                let gate = stage.gate.flatMap { $0.kind == "none" ? nil : ($0.label ?? $0.kind) }
                presets.append(StagePreset(id: "preset-\(kind)", name: stage.name, icon: stage.icon, kind: kind,
                                           desc: stage.desc, gateLabel: gate, stage: stage))
            }
        }
        presets.append(StagePreset(id: "preset-blank", name: "Blank stage", icon: "layers", kind: "work",
                                   desc: "Describe what happens here.", gateLabel: nil,
                                   stage: WorkflowStage(id: "blank", name: "New stage", icon: "layers", kind: "work",
                                                        desc: "Describe what happens here.", seats: [],
                                                        gate: StageGate(kind: "none"), requiredInputs: [],
                                                        expectedOutputs: [], requiredCapabilities: [])))
        return presets
    }

    /// Drops a preset in after `index`, with an id of its own so the copy and
    /// the original can live in the same workflow.
    public static func insertStage(into template: WorkflowTemplate, after index: Int, preset: StagePreset,
                                   id: String = "stage-\(UUID().uuidString.prefix(8))") -> WorkflowTemplate {
        var stage = preset.stage
        stage.id = id
        stage.fixed = nil
        if stage.parallelGroup != nil { stage.parallelGroup = id }
        var next = template
        let position = min(max(index + 1, 1), next.stages.count)
        next.stages.insert(stage, at: position)
        return next
    }

    // MARK: - Templates

    /// A brand new template: intake, one work stage, one delivery stage.
    public static func newTemplate(id: String = "wf-user-\(UUID().uuidString.prefix(8))",
                                   now: Date = Date()) -> WorkflowTemplate {
        WorkflowTemplate(
            id: id, name: "Untitled workflow", tag: "Yours",
            desc: "Describe what this workflow is for.", builtin: false, version: 1,
            updatedAt: iso(now), planning: .init(),
            stages: [
                WorkflowStage(id: "intake", name: "Intake", icon: "clip", kind: "intake",
                              desc: "Capture the goal in plain language.", fixed: true,
                              seats: [.user], gate: StageGate(kind: "none", label: "Goal captured", required: false),
                              requiredInputs: ["goal"], expectedOutputs: ["intake artifact"], requiredCapabilities: []),
                WorkflowStage(id: "build", name: "Build", icon: "code", kind: "work",
                              desc: "Describe what happens here.", seats: [], gate: StageGate(kind: "none"),
                              requiredInputs: [], expectedOutputs: [], requiredCapabilities: []),
                WorkflowStage(id: "ship", name: "Delivery", icon: "rocket", kind: "ship",
                              desc: "Hand the result back for acceptance.", seats: [],
                              gate: StageGate(kind: "final_delivery_acceptance", label: "Delivery acceptance",
                                              required: true,
                                              description: "Pauses for you to accept or reject the final delivery.",
                                              actions: ["accept_delivery", "request_repair"]),
                              requiredInputs: [], expectedOutputs: ["final delivery"], requiredCapabilities: []),
            ]
        )
    }

    /// Saving: a built-in forks to a new id, a user template saves in place.
    public static func saved(_ template: WorkflowTemplate, name: String,
                             forkId: String = "wf-user-\(UUID().uuidString.prefix(8))",
                             now: Date = Date()) -> WorkflowTemplate {
        var next = template
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        next.name = trimmed.isEmpty ? "Untitled workflow" : trimmed
        if template.builtin == true {
            next.id = forkId
            next.tag = "Yours"
        }
        next.builtin = false
        next.version = (template.version ?? 0) + 1
        next.updatedAt = iso(now)
        return next
    }

    private static func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }
}

// MARK: - Validation

/// The rules the Web only discovers from a server error on save
/// (`saveWorkflowTemplate` in src/server/actions/mission-actions.ts).
public struct WorkflowProblem: Equatable, Sendable, Identifiable {
    public var id: String
    public var message: String
    /// The stage the problem belongs to, when it is about one.
    public var stageId: String?
}

public enum WorkflowValidation {
    public static func problems(in template: WorkflowTemplate, agents: AgentRoster) -> [WorkflowProblem] {
        var problems: [WorkflowProblem] = []
        if template.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            problems.append(.init(id: "missing_template_name", message: "Give the workflow a name."))
        }
        if template.stages.isEmpty {
            problems.append(.init(id: "missing_stages", message: "A workflow needs at least one stage."))
            return problems
        }
        var seen: Set<String> = []
        for stage in template.stages {
            if stage.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                problems.append(.init(id: "missing_stage_id", message: "Every stage needs an id."))
            } else if !seen.insert(stage.id).inserted {
                problems.append(.init(id: "duplicate_stage_id:\(stage.id)",
                                      message: "Two stages share the id “\(stage.id)”.", stageId: stage.id))
            }
            if stage.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                problems.append(.init(id: "missing_stage_name:\(stage.id)",
                                      message: "Stage \(stage.id) needs a name.", stageId: stage.id))
            }
            for seat in stage.seats ?? [] where seat.ref.kind == "role" {
                if let agentId = seat.ref.agentId, agents[agentId] == nil {
                    problems.append(.init(id: "unknown_seat_agent:\(agentId)",
                                          message: "“\(agentId)” is not on this workbench.", stageId: stage.id))
                }
            }
        }
        let runnable = template.stages.filter { WorkflowEditor.runnableKinds.contains($0.kind ?? "work") }
        if runnable.isEmpty {
            problems.append(.init(id: "no_runnable_stage",
                                  message: "Add a Plan, Build or Review stage — nothing would run."))
        } else if !runnable.contains(where: { stage in
            (stage.seats ?? []).contains { seat in
                guard seat.ref.kind == "role" else { return false }
                if let agentId = seat.ref.agentId { return agents[agentId] != nil }
                return agents.ordered.contains { $0.role == seat.ref.role }
            }
        }) {
            problems.append(.init(id: "no_runnable_agent_seat",
                                  message: "Give at least one Plan, Build or Review stage an agent seat."))
        }
        return problems
    }
}
