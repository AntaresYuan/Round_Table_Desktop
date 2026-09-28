import Foundation
import Testing
@testable import RoundTableScene

@Suite("Workbench views")
struct WorkbenchTests {
    private func load() throws -> (TurnTimeline, AgentRoster) {
        let (timeline, golden) = try TurnFixtures.load("feature-builder-local-dispatch")
        return (timeline, AgentRoster(golden.agents))
    }

    @Test("sidebar summary follows turnToTask")
    func missionSummary() throws {
        let (timeline, _) = try load()
        let first = timeline.frames[0].turn
        let pending = MissionSummary.from(.pending(id: first.id, chatId: nil, message: first.message, createdAt: nil))
        #expect(pending.title == "Create a waitlist flow with email captur..." && pending.meta == "saving plan" && pending.status == .live)
        let planned = MissionSummary.from(LiveTurn(stored: first))
        #expect(planned.meta == "4 agents · queued" && planned.status == .queued)
        #expect(MissionSummary.from(LiveTurn(stored: timeline.frames[1].turn)).meta == "4 agents · running")
        let done = MissionSummary.from(LiveTurn(stored: timeline.frames[2].turn))
        #expect(done.meta == "8 artifacts · result ready" && done.status == .done)
    }

    @Test("files list the run log then every artifact, as the Web's Files tab")
    func files() throws {
        let (timeline, agents) = try load()
        let planned = MissionFiles.files(for: LiveTurn(stored: timeline.frames[0].turn), agents: agents)
        #expect(planned.count == 3)
        let files = MissionFiles.files(for: LiveTurn(stored: timeline.frames[2].turn), agents: agents)
        // The Web showed "Files · 9" for the completed run.
        #expect(files.count == 9)
        #expect(files[0].name == "roundtable-live-run.json" && files[0].subtitle == "Planning · code")
        #expect(files[1].name == "intake.md" && files[1].subtitle == "Planning · markdown")
        #expect(files[2].name == "plan.json" && files[2].subtitle == "Planning · code")
        #expect(files[3].subtitle == "Nova · markdown" && files[4].subtitle == "Atlas · markdown" && files[5].subtitle == "Vera · markdown")
        #expect(files.allSatisfy { $0.version == 1 })
        #expect(files[0].content.contains("\"dispatchStatus\" : \"completed\""))
        #expect(MissionFiles.files(for: nil, agents: agents).isEmpty)
    }

    @Test("workflow recommendation follows recommendWorkflow")
    func recommendation() {
        let growth = WorkflowRecommendation.recommend(task: "Create a waitlist flow with email captur...")
        #expect(growth?.name == "Landing page that converts")
        #expect(growth?.reason == "This is a marketing page — brief → build → QA → launch fits better.")
        #expect(WorkflowRecommendation.recommend(task: "Research competitor pricing")?.id == "wf-research")
        #expect(WorkflowRecommendation.recommend(task: "Add a settings page") == nil)
        #expect(WorkflowRecommendation.recommend(task: "abc") == nil)
    }

    @Test("workflow view cards list seats and gates from the template")
    func stageCards() throws {
        let (timeline, agents) = try load()
        let workflow = try #require(timeline.frames[0].turn.workflow)
        let cards = WorkflowStageCard.cards(for: workflow, agents: agents)
        #expect(cards.map(\.name) == ["Intake", "Clarify", "Plan", "Build", "Review", "Repair", "Delivery"])
        #expect(cards.map(\.index) == Array(1...7))
        #expect(cards[0].seats.map(\.label) == ["You"] && cards[0].gateLabel == nil && cards[0].fixed)
        #expect(cards[2].seats.map(\.label) == ["Planning", "Nova"] && cards[2].gateLabel == "Plan approval")
        #expect(cards[3].seats.map(\.label) == ["Atlas", "Beam"])
        #expect(cards[6].gateLabel == "Delivery acceptance")
    }
}
