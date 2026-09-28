import Foundation
import Testing
@testable import RoundTableScene

@Suite("Workflow editing")
struct WorkflowEditorTests {
    private func recorded() throws -> (WorkflowTemplate, AgentRoster) {
        let (timeline, golden) = try TurnFixtures.load("feature-builder-local-dispatch")
        return (try #require(timeline.frames.first?.turn.workflow), AgentRoster(golden.agents))
    }

    @Test("inserting puts the new stage after the chosen one and never before intake")
    func insert() throws {
        let (template, _) = try recorded()
        let after = WorkflowEditor.insertStage(into: template, after: 1, id: "stage-test")
        #expect(after.stages.map(\.id).prefix(3) == ["intake", "clarify", "stage-test"])
        #expect(after.stages[2].kind == "work" && after.stages[2].gate?.kind == "none")
        // Appending past the end lands last; the Web cannot do this at all.
        let appended = WorkflowEditor.insertStage(into: template, after: template.stages.count, id: "stage-last")
        #expect(appended.stages.last?.id == "stage-last")
    }

    @Test("moving is a no-op at the ends")
    func move() throws {
        let (template, _) = try recorded()
        let ids = template.stages.map(\.id)
        #expect(WorkflowEditor.moveStage(in: template, at: 0, by: -1).stages.map(\.id) == ids)
        #expect(WorkflowEditor.moveStage(in: template, at: ids.count - 1, by: 1).stages.map(\.id) == ids)
        let moved = WorkflowEditor.moveStage(in: template, at: 1, by: 1)
        #expect(moved.stages.map(\.id).prefix(3) == ["intake", "plan", "clarify"])
    }

    @Test("a fixed stage cannot be removed")
    func remove() throws {
        let (template, _) = try recorded()
        #expect(template.stages[0].fixed == true)
        #expect(WorkflowEditor.removeStage(from: template, at: 0).stages.count == template.stages.count)
        #expect(WorkflowEditor.removeStage(from: template, at: 1).stages.map(\.id).contains("clarify") == false)
    }

    @Test("setting a gate fills in what the orchestrator reads")
    func gates() throws {
        let (template, _) = try recorded()
        let cleared = WorkflowEditor.setGate(in: template, at: 2, kind: "none")
        #expect(cleared.stages[2].gate?.kind == "none" && cleared.stages[2].gate?.required == false)
        let signoff = WorkflowEditor.setGate(in: cleared, at: 2, kind: "reviewer_signoff")
        #expect(signoff.stages[2].gate?.label == "Reviewer sign-off")
        #expect(signoff.stages[2].gate?.required == true)
        // Unlike the Web, a kind the editor does not offer is left alone.
        let untouched = WorkflowEditor.setGate(in: signoff, at: 2, kind: "invented_kind")
        #expect(untouched.stages[2].gate?.kind == "reviewer_signoff")
    }

    @Test("parallel toggles the stage's own group and seats are slots, not a set")
    func parallelAndSeats() throws {
        let (template, _) = try recorded()
        let build = try #require(template.stages.firstIndex { $0.id == "build" })
        #expect(template.stages[build].parallelGroup == "build")
        let serial = WorkflowEditor.toggleParallel(in: template, at: build)
        #expect(serial.stages[build].parallelGroup == nil)
        #expect(WorkflowEditor.toggleParallel(in: serial, at: build).stages[build].parallelGroup == "build")

        let twice = WorkflowEditor.addSeat(to: template, at: build, seat: .role("implementer", "atlas"))
        #expect(twice.stages[build].seats?.count == (template.stages[build].seats?.count ?? 0) + 1)
        let back = WorkflowEditor.removeSeat(from: twice, at: build, seatIndex: 0)
        #expect(back.stages[build].seats?.count == template.stages[build].seats?.count)
    }

    @Test("saving forks a built-in and saves a user template in place")
    func saving() throws {
        let (template, _) = try recorded()
        let forked = WorkflowEditor.saved(template, name: "  My flow  ", forkId: "wf-user-test")
        #expect(forked.id == "wf-user-test" && forked.name == "My flow")
        #expect(forked.builtin == false && forked.tag == "Yours" && forked.version == 2)
        let again = WorkflowEditor.saved(forked, name: "My flow", forkId: "wf-user-other")
        #expect(again.id == "wf-user-test" && again.version == 3)
        #expect(WorkflowEditor.saved(template, name: "   ").name == "Untitled workflow")
    }

    @Test("a new template starts runnable-shaped but not yet valid")
    func newTemplate() throws {
        let (_, agents) = try recorded()
        let fresh = WorkflowEditor.newTemplate(id: "wf-user-new")
        #expect(fresh.stages.map(\.id) == ["intake", "build", "ship"])
        #expect(fresh.stages[0].fixed == true)
        // Its work stage has no seats yet, so validation tells the user what to do.
        #expect(WorkflowValidation.problems(in: fresh, agents: agents).map(\.id) == ["no_runnable_agent_seat"])
        let staffed = WorkflowEditor.addSeat(to: fresh, at: 1, seat: .role("implementer", "atlas"))
        #expect(WorkflowValidation.problems(in: staffed, agents: agents).isEmpty)
    }

    @Test("validation covers what the Web only learns from a server error")
    func validation() throws {
        let (template, agents) = try recorded()
        #expect(WorkflowValidation.problems(in: template, agents: agents).isEmpty)

        var unnamed = template
        unnamed.name = " "
        #expect(WorkflowValidation.problems(in: unnamed, agents: agents).map(\.id).contains("missing_template_name"))

        var duplicated = template
        duplicated.stages.append(template.stages[1])
        #expect(WorkflowValidation.problems(in: duplicated, agents: agents).map(\.id) == ["duplicate_stage_id:clarify"])

        let stranger = WorkflowEditor.addSeat(to: template, at: 1, seat: .role("implementer", "ghost"))
        #expect(WorkflowValidation.problems(in: stranger, agents: agents).map(\.id) == ["unknown_seat_agent:ghost"])

        var intakeOnly = template
        intakeOnly.stages = [template.stages[0]]
        #expect(WorkflowValidation.problems(in: intakeOnly, agents: agents).map(\.id) == ["no_runnable_stage"])

        var empty = template
        empty.stages = []
        #expect(WorkflowValidation.problems(in: empty, agents: agents).map(\.id) == ["missing_stages"])
    }
}

@Suite("Stage presets")
struct StagePresetTests {
    private func builtins() throws -> [WorkflowTemplate] {
        try WorkflowBuiltins.decode(Data(contentsOf: WorkflowLibraryTests.builtinsURL))
    }

    @Test("presets are the built-ins' own stages, one per kind, without intake")
    func derivedFromBuiltins() throws {
        let presets = WorkflowEditor.presets(from: try builtins())
        #expect(presets.map(\.kind) == ["clarify", "plan", "work", "review", "repair", "ship", "work"])
        #expect(presets.map(\.id).last == "preset-blank")
        #expect(!presets.contains { $0.kind == "intake" })
        let review = try #require(presets.first { $0.kind == "review" })
        #expect(review.name == "Review" && review.gateLabel == "Reviewer confidence")
        #expect(!(review.stage.seats ?? []).isEmpty)
    }

    @Test("dropping a preset copies it with a new id and stays valid")
    func insertPreset() throws {
        let builtins = try builtins()
        let (_, golden) = try TurnFixtures.load("feature-builder-local-dispatch")
        let agents = AgentRoster(golden.agents)
        let presets = WorkflowEditor.presets(from: builtins)
        let template = try #require(builtins.first)
        let review = try #require(presets.first { $0.kind == "review" })

        let next = WorkflowEditor.insertStage(into: template, after: 2, preset: review, id: "stage-copy")
        #expect(next.stages[3].id == "stage-copy" && next.stages[3].name == "Review")
        #expect(next.stages[3].fixed == nil)
        // A parallel stage's group follows the copy, not the stage it came from.
        #expect(next.stages[3].parallelGroup == "stage-copy")
        #expect(WorkflowValidation.problems(in: next, agents: agents).isEmpty)
    }

    @Test("a blank stage lands empty and asks to be staffed")
    func insertBlank() throws {
        let builtins = try builtins()
        let (_, golden) = try TurnFixtures.load("feature-builder-local-dispatch")
        let blank = try #require(WorkflowEditor.presets(from: builtins).first { $0.id == "preset-blank" })
        var template = WorkflowEditor.newTemplate(id: "wf-user-blank")
        template.stages.removeAll { $0.kind == "work" }
        let next = WorkflowEditor.insertStage(into: template, after: 0, preset: blank, id: "stage-blank")
        #expect(next.stages[1].seats?.isEmpty == true && next.stages[1].gate?.kind == "none")
        #expect(WorkflowValidation.problems(in: next, agents: AgentRoster(golden.agents)).map(\.id)
                == ["no_runnable_agent_seat"])
    }
}
