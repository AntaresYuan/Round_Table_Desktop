import Foundation

// Pure geometry and state for the roundtable room, ported from
// src/ui/components/roundtable.jsx (stacked layout) and the WorkflowStrip in
// src/ui/components/workflow.jsx. The view layer draws on a fixed canvas in
// these coordinates and scales it to fit, as the Web's RoomStage does.

public struct RoomPoint: Equatable, Sendable {
    public var x: Double
    public var y: Double
}

public struct RoomSeat: Equatable, Sendable, Identifiable {
    public var key: String
    /// nil for the user's chair.
    public var agentId: String?
    public var angle: Double
    public var head: Bool

    public var id: String { key }
    public var isUser: Bool { agentId == nil }
}

public struct RoomSeatPosition: Equatable, Sendable {
    public var x: Double
    public var y: Double
    /// Perspective scale: seats nearer the viewer are drawn larger.
    public var scale: Double
}

public struct DependencyEdge: Equatable, Sendable, Identifiable {
    public var id: String
    public var fromSeat: RoomSeat
    public var toSeat: RoomSeat
    /// The agent whose completed task draws this arrow (its colour).
    public var ownerAgentId: String
}

public enum RoomLayout {
    // `LAYOUTS.stacked`
    public static let width = 900.0
    public static let height = 848.0
    public static let whiteboardCenter = RoomPoint(x: 400, y: 152)
    public static let whiteboardSize = (width: 556.0, height: 276.0)
    public static let table = (cx: 432.0, cy: 556.0, rx: 244.0, ry: 112.0, depth: 26.0)
    public static let seatRadius = (x: 312.0, y: 158.0)
    public static let door = RoomPoint(x: 802, y: 174)

    /// Port of `buildSeats`: the facilitator at the head, the user at the foot,
    /// every other member split evenly across the two sides.
    public static func seats(memberIds: [String]) -> [RoomSeat] {
        let others = memberIds.filter { $0 != "orchestrator" }
        let rightCount = Int((Double(others.count) / 2).rounded(.up))
        let right = Array(others.prefix(rightCount))
        let left = Array(others.dropFirst(rightCount))
        var seats = [RoomSeat(key: "pm", agentId: "orchestrator", angle: 270, head: true)]
        for (index, id) in right.enumerated() {
            let angle = (270 + Double(index + 1) * (180 / Double(right.count + 1))).truncatingRemainder(dividingBy: 360)
            seats.append(RoomSeat(key: id, agentId: id, angle: angle, head: false))
        }
        seats.append(RoomSeat(key: "user", agentId: nil, angle: 90, head: false))
        for (index, id) in left.enumerated() {
            let angle = (90 + Double(index + 1) * (180 / Double(left.count + 1))).truncatingRemainder(dividingBy: 360)
            seats.append(RoomSeat(key: id, agentId: id, angle: angle, head: false))
        }
        return seats
    }

    /// Port of `seatPos`.
    public static func position(angle: Double) -> RoomSeatPosition {
        let radians = angle * .pi / 180
        return RoomSeatPosition(
            x: table.cx + seatRadius.x * cos(radians),
            y: table.cy + seatRadius.y * sin(radians),
            scale: 0.82 + 0.26 * ((sin(radians) + 1) / 2)
        )
    }

    /// Port of `DependencyArrows`: once a task completes, an arrow runs from its
    /// owner's seat to the seat of each task it depends on.
    public static func dependencyEdges(tasks: [SceneTask], seats: [RoomSeat], agents: AgentRoster) -> [DependencyEdge] {
        let unique = SceneProjector.uniqueById(tasks, id: \.id)
        let byId = Dictionary(unique.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        func seat(for task: SceneTask?) -> RoomSeat? {
            guard let task else { return nil }
            if let direct = seats.first(where: { $0.agentId == task.owner }) { return direct }
            let role = (task.assignee ?? "").hasPrefix("@") ? String((task.assignee ?? "").dropFirst()) : (task.assignee ?? "")
            guard let byRole = agents.ordered.first(where: { $0.role == role && $0.pm != true }) else { return nil }
            return seats.first { $0.agentId == byRole.agentId }
        }
        var edges: [DependencyEdge] = []
        for task in unique where task.status == "completed" {
            guard let from = seat(for: task) else { continue }
            for depId in task.deps ?? [] {
                guard let to = seat(for: byId[depId]), to.angle != from.angle else { continue }
                edges.append(DependencyEdge(id: "\(task.id)->\(depId)", fromSeat: from, toSeat: to, ownerAgentId: task.owner))
            }
        }
        return edges
    }
}

public struct WorkflowStripStep: Equatable, Sendable, Identifiable {
    public var stage: WorkflowStage
    public var done: Bool
    public var active: Bool
    public var id: String { stage.id }
}

public enum WorkflowStripModel {
    /// Port of `liveStageFlags` plus the WorkflowStrip filter: a pending repair
    /// stage is hidden. Without a bound run (before planning returns) the strip
    /// shows the template with its first stage active, like the Web's clock at 0.
    public static func steps(workflow: WorkflowTemplate, run: WorkflowRun?) -> [WorkflowStripStep] {
        guard let run else {
            return workflow.stages.enumerated().map { index, stage in
                WorkflowStripStep(stage: stage, done: false, active: index == 0)
            }
        }
        return workflow.stages.compactMap { stage in
            let status = run.stageStates?[stage.id]?.status ?? "pending"
            let visible = stage.kind != "repair" || status != "pending"
            guard visible else { return nil }
            return WorkflowStripStep(
                stage: stage,
                done: status == "done" || status == "completed",
                active: stage.fixed != true
                    && (run.activeStageId == stage.id || status == "active" || status == "running")
            )
        }
    }
}
