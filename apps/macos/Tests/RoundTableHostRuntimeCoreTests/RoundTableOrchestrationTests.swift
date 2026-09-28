import Foundation
import Testing
@testable import RoundTableHostRuntimeCore

@Suite("Host Runtime deterministic orchestration")
struct RoundTableOrchestrationTests {
    private func oracle() throws -> Data {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Fixtures/TurnTimelines")
            .appendingPathComponent("feature-builder-local-dispatch.timeline.json")
        return try Data(contentsOf: url)
    }

    private func owner(_ generation: UInt64 = 1) throws -> RuntimeSessionOwner {
        try RuntimeSessionOwner(connectionGeneration: generation,
            sessionNonce: "session_0123456789abcdef0123456789abcdef")
    }

    @Test("oracle produces the exact bounded gate sequence")
    func oracleSequence() async throws {
        let data = try oracle()
        let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let sourceFrames = try #require(root["frames"] as? [[String: Any]])
        let goal = try #require((sourceFrames[0]["turn"] as? [String: Any])?["message"] as? String)
        let runtime = try RoundTableOrchestration(oracleData: data)

        let planned = try await runtime.start(
            goal: goal, workflowTemplateId: "wf-feature-builder", owner: owner())
        #expect(planned.frames.map(\.sequence) == [1])
        #expect(planned.awaiting == .planApproval)

        let built = try await runtime.resolve(
            streamId: planned.streamId, gate: .planApproval, owner: owner())
        #expect(built.frames.map(\.sequence) == [1, 2, 3])
        #expect(built.awaiting == .deliveryDecision)
        for (actual, expected) in zip(built.frames, sourceFrames) {
            let actualObject = try #require(JSONSerialization.jsonObject(with: actual.turn) as? NSDictionary)
            let expectedObject = try #require(expected["turn"] as? NSDictionary)
            #expect(actualObject == expectedObject)
        }

        let replay = try await runtime.poll(
            streamId: planned.streamId, afterSequence: 1, owner: owner())
        #expect(replay.frames.map(\.sequence) == [2, 3])
        let delivered = try await runtime.resolve(
            streamId: planned.streamId, gate: .deliveryDecision, owner: owner())
        #expect(delivered.terminal)
        #expect(delivered.awaiting == nil)
    }

    @Test("owner mismatch replay and invalid gates fail closed")
    func failClosed() async throws {
        let data = try oracle()
        let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let frames = try #require(root["frames"] as? [[String: Any]])
        let goal = try #require((frames[0]["turn"] as? [String: Any])?["message"] as? String)
        let runtime = try RoundTableOrchestration(oracleData: data)
        let firstOwner = try owner()
        let started = try await runtime.start(
            goal: goal, workflowTemplateId: "wf-feature-builder", owner: firstOwner)

        await #expect(throws: OrchestrationError.streamOwnerMismatch) {
            _ = try await runtime.poll(
                streamId: started.streamId, afterSequence: 0, owner: owner(2))
        }
        await #expect(throws: OrchestrationError.gateMismatch) {
            _ = try await runtime.resolve(
                streamId: started.streamId, gate: .deliveryDecision, owner: firstOwner)
        }
        await #expect(throws: OrchestrationError.replayUnavailable) {
            _ = try await runtime.poll(
                streamId: started.streamId, afterSequence: 2, owner: firstOwner)
        }
        await runtime.revokeOwned(by: firstOwner)
        await #expect(throws: OrchestrationError.streamNotFound) {
            _ = try await runtime.poll(
                streamId: started.streamId, afterSequence: 0, owner: firstOwner)
        }
    }

    @Test("malformed and oversized oracle data is rejected")
    func maliciousOracle() throws {
        #expect(throws: OrchestrationError.oracleInvalid) {
            _ = try RoundTableOrchestration(oracleData: Data("{\"format\":\"roundtable.turn-timeline\",\"format\":\"x\"}".utf8))
        }
        #expect(throws: OrchestrationError.oracleInvalid) {
            _ = try RoundTableOrchestration(oracleData: Data(repeating: 0x20,
                count: RoundTableOrchestration.maximumFrames
                    * RoundTableOrchestration.maximumTurnBytes + 1))
        }
    }
}
