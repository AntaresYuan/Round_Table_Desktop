import Foundation
import Testing
@testable import RoundTableScene

@Suite("Room layout and workflow strip")
struct RoomLayoutTests {
    static let members = ["orchestrator", "mira", "atlas", "beam", "vera", "nova", "fixer"]

    @Test("seats and positions match the Web's stacked layout")
    func seatGeometry() {
        // Reference values printed from buildSeats/seatPos in src/ui/components/roundtable.jsx.
        let expected: [(String, Double, Double, Double, Double)] = [
            ("pm", 270, 432.0000, 398.0000, 0.8200),
            ("mira", 315, 652.6173, 444.2771, 0.8581),
            ("atlas", 0, 744.0000, 556.0000, 0.9500),
            ("beam", 45, 652.6173, 667.7229, 1.0419),
            ("user", 90, 432.0000, 714.0000, 1.0800),
            ("vera", 135, 211.3827, 667.7229, 1.0419),
            ("nova", 180, 120.0000, 556.0000, 0.9500),
            ("fixer", 225, 211.3827, 444.2771, 0.8581),
        ]
        let seats = RoomLayout.seats(memberIds: Self.members)
        #expect(seats.map(\.key) == expected.map(\.0))
        #expect(seats.first?.head == true && seats.first(where: \.isUser)?.key == "user")
        for (seat, reference) in zip(seats, expected) {
            let position = RoomLayout.position(angle: seat.angle)
            #expect(seat.angle == reference.1, "\(seat.key)")
            #expect(abs(position.x - reference.2) < 0.001 && abs(position.y - reference.3) < 0.001, "\(seat.key)")
            #expect(abs(position.scale - reference.4) < 0.0001, "\(seat.key)")
        }
    }

    @Test("workflow strip follows the recorded run")
    func stripSteps() throws {
        let (timeline, _) = try TurnFixtures.load("feature-builder-local-dispatch")
        func describe(_ frame: Int) throws -> String {
            let turn = timeline.frames[frame].turn
            let workflow = try #require(turn.workflow)
            return WorkflowStripModel.steps(workflow: workflow, run: turn.workflowRun)
                .map { "\($0.stage.id)\($0.active ? "*" : "")\($0.done ? "+" : "")" }
                .joined(separator: " ")
        }
        // Repair stays pending in this run, so it is never shown.
        #expect(try describe(0) == "intake+ clarify plan* build review ship")
        #expect(try describe(1) == "intake+ clarify+ plan* build review ship")
        #expect(try describe(2) == "intake+ clarify+ plan+ build+ review+ ship*+")
        let template = try #require(timeline.frames[0].turn.workflow)
        let unbound = WorkflowStripModel.steps(workflow: template, run: nil)
        #expect(unbound.map(\.active) == [true] + Array(repeating: false, count: template.stages.count - 1))
    }

    @Test("dependency arrows appear as tasks complete")
    func dependencyEdges() throws {
        let (timeline, golden) = try TurnFixtures.load("feature-builder-local-dispatch")
        let agents = AgentRoster(golden.agents)
        let seats = RoomLayout.seats(memberIds: Self.members)
        func edges(_ frame: Int) throws -> [String] {
            let scene = try #require(SceneProjector.project(turns: [LiveTurn(stored: timeline.frames[frame].turn)],
                                                            agents: agents, playback: .idle))
            return RoomLayout.dependencyEdges(tasks: scene.tasks, seats: seats, agents: agents).map(\.id)
        }
        #expect(try edges(0).isEmpty)
        // task_nova has no deps; Vera and Nova's review both depend on Atlas.
        #expect(try edges(2) == ["task_atlas->task_nova", "task_vera->task_atlas", "task_nova_review->task_atlas"])
    }
}
