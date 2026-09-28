import Foundation
import Testing
@testable import RoundTableScene

actor RecordedSleeps {
    private(set) var values: [Duration] = []
    func record(_ duration: Duration) { values.append(duration) }
}

@Suite("Timeline replay")
struct ReplayTurnSourceTests {
    @Test("replays pending, each frame, and pauses at every gate")
    func replaySequence() async throws {
        let (timeline, _) = try TurnFixtures.load("feature-builder-local-dispatch")
        let sleeps = RecordedSleeps()
        let source = ReplayTurnSource(timeline: timeline, speed: 2) { await sleeps.record($0) }

        let player = Task { await source.startMission() }
        var statuses: [String] = []
        var gates: [TurnGate] = []
        for await event in source.events {
            switch event {
            case .turns(let turns):
                let turn = try #require(turns.last)
                statuses.append(turn.result.map { "\($0.approvalStatus ?? "-")/\($0.dispatchStatus ?? "-")" } ?? turn.status)
            case .awaiting(let gate):
                gates.append(gate)
                await source.resolve(gate)
            case .failed(let error):
                Issue.record("unexpected source failure: \(error)")
            case .finished:
                break
            }
        }
        await player.value

        #expect(statuses == ["pending", "pending/not_started", "approved/running", "approved/completed"])
        #expect(gates == [.planApproval, .deliveryDecision])
        let expected = zip(timeline.frames.map(\.atMs), [0] + timeline.frames.map(\.atMs)).map { current, previous in
            Duration.milliseconds(Int((Double(current - previous) / 2).rounded()))
        }
        #expect(await sleeps.values == expected)
    }

    @Test("a gate resolved before it is reached does not block")
    func earlyResolution() async throws {
        let (timeline, _) = try TurnFixtures.load("feature-builder-local-dispatch")
        let source = ReplayTurnSource(timeline: timeline) { _ in }
        await source.resolve(.planApproval)
        await source.resolve(.deliveryDecision)
        await source.startMission()
        var last: TurnSourceEvent?
        for await event in source.events { last = event }
        #expect(last == .finished)
    }

    @Test("cancelling at a gate releases the player without reporting completion")
    func cancellationAtGate() async throws {
        let (timeline, _) = try TurnFixtures.load("feature-builder-local-dispatch")
        let source = ReplayTurnSource(timeline: timeline) { _ in }
        let player = Task { await source.startMission() }
        var iterator = source.events.makeAsyncIterator()

        _ = await iterator.next() // client-created pending turn
        _ = await iterator.next() // first recorded frame
        #expect(await iterator.next() == .awaiting(.planApproval))

        await source.cancel()
        await player.value

        var sawFinished = false
        while let event = await iterator.next() {
            if event == .finished { sawFinished = true }
        }
        #expect(!sawFinished)
    }

    @Test("unsupported timelines are rejected")
    func rejectsUnknownFormat() {
        let data = Data(#"{"format":"other","version":1,"frames":[]}"#.utf8)
        #expect(throws: TurnTimelineError.unsupported(format: "other", version: 1)) {
            try TurnTimeline.decode(data)
        }
    }
}
