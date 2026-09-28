import Foundation
import Testing
@testable import RoundTableScene

/// Expectations come from the Web's rendering of the same recorded run
/// (text captured from the Web chat pane during the side-by-side comparison).
@Suite("Mission chat thread")
struct MissionThreadTests {
    static let goal = "Create a waitlist flow with email capture, validation, persistence, and a reviewed confirmation state."

    private func thread(frame: Int, meetingComplete: Bool = true, decision: String? = nil) throws -> MissionThread {
        let (timeline, golden) = try TurnFixtures.load("feature-builder-local-dispatch")
        return MissionThread.build(turn: LiveTurn(stored: timeline.frames[frame].turn), meetingComplete: meetingComplete,
                                   agents: AgentRoster(golden.agents), deliveryDecision: decision)
    }

    @Test("only the message shows while pending or while the meeting plays")
    func planningOnly() throws {
        let (timeline, golden) = try TurnFixtures.load("feature-builder-local-dispatch")
        let first = timeline.frames[0].turn
        let pending = MissionThread.build(turn: .pending(id: first.id, chatId: nil, message: first.message, createdAt: nil),
                                          meetingComplete: true, agents: AgentRoster(golden.agents))
        #expect(!pending.showsRun && pending.message == Self.goal)
        let playing = try thread(frame: 0, meetingComplete: false)
        #expect(!playing.showsRun && playing.plan == nil && playing.header == nil)
    }

    @Test("plan card awaits approval with the Web's rows")
    func planCard() throws {
        let thread = try thread(frame: 0)
        #expect(thread.showsRun && thread.chain == nil && thread.result == nil)
        let header = try #require(thread.header)
        #expect(header.statusLabel == "awaiting approval" && header.tone == .warn)
        #expect(header.templateName == "Feature Builder")
        #expect(header.stageLine == "Current stage: Plan · Approve the plan to start agent execution.")
        let plan = try #require(thread.plan)
        #expect(plan.doneCount == 0 && plan.total == 4 && !plan.approved)
        #expect(plan.intakeLine == "intent=review · risk=medium · clarity=high")
        #expect(plan.summary.hasPrefix("All right, that is the direction. I have arranged 4 execution tasks"))
        #expect(plan.rows.map(\.title) == ["Architecture direction", "Build · Atlas", "Review the build", "Architecture check"])
        #expect(plan.rows.map(\.metaLine) == [
            "@nova · ready after approval",
            "@atlas · starts after Architecture direction",
            "@vera · parallel · starts after Build · Atlas",
            "@nova · parallel · starts after Build · Atlas",
        ])
        #expect(plan.rows[0].objective.hasPrefix("Inspect the real entrypoint and reusable code"))
        #expect(plan.rows[1].objective == "Build the core pages and interactions in the existing project for: \(Self.goal), with a runnable result and mobile verification.")
        #expect(plan.rows.allSatisfy { $0.status == "pending" })
        #expect(plan.rows.map(\.cliNumber) == [1, 2, 3, 4])
    }

    @Test("running shows the chain, the active stage and delivery in progress")
    func running() throws {
        let thread = try thread(frame: 1)
        #expect(thread.plan == nil)
        let chain = try #require(thread.chain)
        #expect(chain.statusText == "running" && chain.adapter == "local-dispatch")
        #expect(chain.records.isEmpty && chain.waitingText == "Waiting for the first agent output.")
        #expect(thread.stages.map(\.id) == ["clarify", "plan"])
        #expect(thread.stages.map(\.statusLabel) == ["done", "running"])
        #expect(thread.result?.title == "Delivery in progress")
        #expect(thread.result?.awaitingDecision == false)
    }

    @Test("completed run lists every agent and waits for the delivery decision")
    func completed() throws {
        let thread = try thread(frame: 2)
        #expect(thread.header?.statusLabel == "ready")
        #expect(thread.header?.stageLine == "Current stage: Delivery · Accept final delivery or request repair.")
        let chain = try #require(thread.chain)
        #expect(chain.statusText == "run complete" && chain.tone == .ok)
        #expect(chain.records.map(\.ownerName) == ["Nova", "Atlas", "Vera", "Nova"])
        #expect(chain.records.map(\.mention) == ["nova", "atlas", "vera", "nova"])
        #expect(chain.records.allSatisfy { $0.status == "completed" && $0.artifacts.count == 1 })
        #expect(thread.stages.map(\.name) == ["Clarify", "Plan", "Build", "Review", "Delivery"])
        let result = try #require(thread.result)
        #expect(result.title == "Delivery ready" && result.completed && result.awaitingDecision)
        #expect(result.metaLine == "8 artifacts · 1 code · 0 review · confidence=pass · tests=observed · risks=0 · delivery=accept · adapter=local-dispatch · next=done")
        #expect(result.artifacts.count == 8 && result.decisionBanner == nil)
    }

    @Test("a local delivery decision replaces the decision bar with a banner")
    func deliveryDecision() throws {
        let accepted = try thread(frame: 2, decision: "accept")
        #expect(accepted.result?.awaitingDecision == false)
        #expect(accepted.result?.decisionBanner == "Final delivery accepted.")
        let repair = try thread(frame: 2, decision: "repair")
        #expect(repair.result?.decisionBanner == "Repair requested for final delivery.")
    }

    @Test("plan presentation helpers follow the Web rules")
    func presentationHelpers() {
        #expect(MissionThread.planSummaryForDisplay(TurnPlan(summary: "Meeting closed with 3 tasks", tasks: [])).hasPrefix("0 CLI tasks"))
        #expect(MissionThread.compactGoal("  a   b  ") == "a b")
        #expect(MissionThread.compactGoal(String(repeating: "x", count: 80)) == String(repeating: "x", count: 76) + "…")
        #expect(MissionThread.briefSection("User request: ship it\n\nPlanning meeting objective: Do the thing\n\nAcceptance criteria: x",
                                           label: "Planning meeting objective") == "Do the thing")
        #expect(MissionThread.todoStatus(record: nil, approved: true, dispatchStatus: "running") == "running")
        #expect(MissionThread.todoStatus(record: nil, approved: false, dispatchStatus: "running") == "pending")
    }
}

@Suite("Live transcript feeds")
struct LiveFeedTests {
    @Test("running tasks stream their transcript in the chain and the active stage")
    func runningFeeds() throws {
        let (timeline, golden) = try TurnFixtures.load("feature-builder-synthetic-live")
        let agents = AgentRoster(golden.agents)
        func thread(_ frame: Int) -> MissionThread {
            MissionThread.build(turn: LiveTurn(stored: timeline.frames[frame].turn), meetingComplete: true, agents: agents)
        }
        // Frame 1: Nova is starting up; nothing has streamed yet.
        let starting = try #require(thread(1).chain)
        #expect(starting.liveFeeds.map(\.displayName) == ["Nova"] && starting.waitingText == nil)
        #expect(starting.liveFeeds[0].entries.isEmpty && starting.liveFeeds[0].emptyText == "Starting up — no output yet…")
        // Frame 3: thinking, then the tool call.
        let working = try #require(thread(3).chain?.liveFeeds.first)
        #expect(working.entries.map(\.kind) == ["thinking", "status"] && working.runtime == "claude")
        let planStage = try #require(thread(3).stages.first { $0.id == "plan" })
        #expect(planStage.status == "active" && planStage.liveFeeds.map(\.id) == ["task_nova"] && !planStage.showsWorking)
        // Frame 12: Vera and Nova run concurrently. Records only land when the whole run
        // finishes, so the Web still lists the finished tasks' transcripts too.
        let concurrent = try #require(thread(12).chain?.liveFeeds)
        #expect(concurrent.map(\.displayName) == ["Nova", "Atlas", "Vera", "Nova"])
        #expect(concurrent.map(\.status) == ["completed", "completed", "running", "running"])
        // Completed: the chain shows records, not feeds.
        let done = try #require(thread(timeline.frames.count - 1).chain)
        #expect(done.liveFeeds.isEmpty && done.records.count == 4)
    }
}
