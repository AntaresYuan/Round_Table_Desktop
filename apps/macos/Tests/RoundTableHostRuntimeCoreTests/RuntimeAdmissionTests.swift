import Foundation
import Testing
@testable import RoundTableHostRuntimeCore

@Suite("Host Runtime admission and execution FSM")
struct RuntimeAdmissionTests {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func owner(_ generation: UInt64 = 1, digit: Character = "a") throws -> RuntimeSessionOwner {
        try RuntimeSessionOwner(connectionGeneration: generation,
                                sessionNonce: "session_" + String(repeating: String(digit), count: 32))
    }

    private func request(_ suffix: String = "one") -> MissionPreparationRequest {
        MissionPreparationRequest(workspaceId: "workspace_\(suffix)", provider: .codex,
                                  prompt: "Build \(suffix)")
    }

    @Test("approval freezes the request, is owner-bound, single-use and expires")
    func approvalBoundary() async throws {
        let authority = RuntimeAdmission(configuration: .init(approvalTTL: 30))
        let firstOwner = try owner()
        let otherOwner = try owner(2, digit: "b")
        let approval = try await authority.prepare(request(), owner: firstOwner, at: start)
        #expect(approval.prompt == "Build one")
        #expect(approval.promptDigest.count == 64)

        await #expect(throws: RuntimeAdmissionError.approvalInvalid) {
            try await authority.approve(approval.approvalId, owner: otherOwner, at: start)
        }
        let execution = try await authority.approve(approval.approvalId, owner: firstOwner, at: start)
        #expect(execution.prompt == approval.prompt && execution.promptDigest == approval.promptDigest)
        await #expect(throws: RuntimeAdmissionError.approvalInvalid) {
            try await authority.approve(approval.approvalId, owner: firstOwner, at: start)
        }

        let next = RuntimeAdmission(configuration: .init(approvalTTL: 30))
        let expired = try await next.prepare(request("expired"), owner: firstOwner, at: start)
        await #expect(throws: RuntimeAdmissionError.approvalInvalid) {
            try await next.approve(expired.approvalId, owner: firstOwner,
                                   at: start.addingTimeInterval(30))
        }
        #expect(await next.pendingApprovalCount(at: start.addingTimeInterval(30)) == 0)
    }

    @Test("Phase 4 rejects a second execution while one is queued or active")
    func singleExecutionAdmission() async throws {
        let authority = RuntimeAdmission()
        let session = try owner()
        let first = try await authority.prepare(request(), owner: session, at: start)
        let second = try await authority.prepare(request("two"), owner: session, at: start)
        _ = try await authority.approve(first.approvalId, owner: session, at: start)
        await #expect(throws: RuntimeAdmissionError.executionAlreadyActive) {
            try await authority.approve(second.approvalId, owner: session, at: start)
        }
        await #expect(throws: RuntimeAdmissionError.executionAlreadyActive) {
            try await authority.prepare(self.request("three"), owner: session, at: self.start)
        }
    }

    @Test("the optional queue is bounded and only one execution can be claimed")
    func boundedQueue() async throws {
        let authority = RuntimeAdmission(configuration: .init(maxQueuedExecutions: 2,
                                                               allowQueueingBehindActive: true))
        let session = try owner()
        let approvals = try await (1...3).asyncMap { index in
            try await authority.prepare(request("q\(index)"), owner: session, at: start)
        }
        _ = try await authority.approve(approvals[0].approvalId, owner: session, at: start)
        _ = try await authority.approve(approvals[1].approvalId, owner: session, at: start)
        await #expect(throws: RuntimeAdmissionError.queueFull) {
            try await authority.approve(approvals[2].approvalId, owner: session, at: start)
        }
        let active = try #require(try await authority.claimNext(at: start))
        #expect(active.state == .starting)
        #expect(try await authority.claimNext(at: start) == nil)
        #expect(await authority.queuedExecutionCount() == 1)
    }

    @Test("state events require exact sequence and legal transitions")
    func orderedTransitions() async throws {
        let authority = RuntimeAdmission(configuration: .init(maxEventHistory: 2))
        let session = try owner()
        let approval = try await authority.prepare(request(), owner: session, at: start)
        let queued = try await authority.approve(approval.approvalId, owner: session, at: start)
        let starting = try #require(try await authority.claimNext(at: start))
        #expect(starting.sequence == 1)

        let running = RuntimeStateEvent(missionId: queued.missionId, executionId: queued.executionId,
                                        sequence: 2, occurredAt: start, state: .running)
        _ = try await authority.apply(running)
        await #expect(throws: RuntimeAdmissionError.invalidEventSequence) {
            try await authority.apply(RuntimeStateEvent(
                missionId: queued.missionId, executionId: queued.executionId, sequence: 4,
                occurredAt: self.start, state: .succeeded, treeTermination: .confirmed))
        }
        await #expect(throws: RuntimeAdmissionError.invalidTransition) {
            try await authority.apply(RuntimeStateEvent(
                missionId: queued.missionId, executionId: queued.executionId, sequence: 3,
                occurredAt: self.start, state: .queued))
        }
        _ = try await authority.apply(RuntimeStateEvent(
            missionId: queued.missionId, executionId: queued.executionId, sequence: 3,
            occurredAt: start, state: .succeeded, treeTermination: .confirmed))
        await #expect(throws: RuntimeAdmissionError.eventReplayUnavailable) {
            try await authority.events(for: queued.executionId, owner: session, after: 0)
        }
        #expect(try await authority.events(for: queued.executionId, owner: session, after: 1).map(\.sequence) == [2, 3])
    }

    @Test("output shares event ordering and applies bounded log backpressure")
    func boundedOutput() async throws {
        let authority = RuntimeAdmission(configuration: .init(
            maxEventHistory: 3, maxLogEntries: 2, maxLogBytes: 8, maxOutputEventBytes: 6))
        let session = try owner()
        let approval = try await authority.prepare(request(), owner: session, at: start)
        let queued = try await authority.approve(approval.approvalId, owner: session, at: start)
        _ = try await authority.claimNext(at: start)

        let first = try await authority.appendOutput(
            missionId: queued.missionId, executionId: queued.executionId, sequence: 2,
            occurredAt: start, stream: .stdout, text: "éééé")
        #expect(first.text == "ééé")
        #expect(first.truncated)
        _ = try await authority.appendOutput(
            missionId: queued.missionId, executionId: queued.executionId, sequence: 3,
            occurredAt: start, stream: .stderr, text: "abc")
        _ = try await authority.appendOutput(
            missionId: queued.missionId, executionId: queued.executionId, sequence: 4,
            occurredAt: start, stream: .status, text: "wxyz")

        let snapshot = try await authority.snapshot(queued.executionId, owner: session)
        #expect(snapshot.sequence == 4)
        #expect(snapshot.logs.map(\.text) == ["abc", "wxyz"])
        #expect(snapshot.droppedLogEntries == 1)
        #expect(try await authority.events(for: queued.executionId, owner: session, after: 1)
            .map(\.sequence) == [2, 3, 4])
        await #expect(throws: RuntimeAdmissionError.outputNotAccepted) {
            try await authority.appendOutput(
                missionId: queued.missionId, executionId: queued.executionId, sequence: 5,
                occurredAt: self.start, stream: .stdout, text: "bad\0text")
        }

        _ = try await authority.apply(RuntimeStateEvent(
            missionId: queued.missionId, executionId: queued.executionId, sequence: 5,
            occurredAt: start, state: .running))
        #expect(try await authority.events(for: queued.executionId, owner: session, after: 2)
            .map(\.sequence) == [3, 4, 5])
    }

    @Test("shutdown closes admission and requires confirmed active-tree termination")
    func shutdownBarrier() async throws {
        let authority = RuntimeAdmission()
        let session = try owner()
        let approval = try await authority.prepare(request(), owner: session, at: start)
        let queued = try await authority.approve(approval.approvalId, owner: session, at: start)
        _ = try await authority.claimNext(at: start)
        _ = try await authority.apply(RuntimeStateEvent(
            missionId: queued.missionId, executionId: queued.executionId, sequence: 2,
            occurredAt: start, state: .running))

        try await authority.shutdown(at: start) { snapshot in
            RuntimeStateEvent(missionId: snapshot.missionId, executionId: snapshot.executionId,
                              sequence: snapshot.sequence + 1, occurredAt: self.start,
                              state: .stopped, treeTermination: .confirmed)
        }
        #expect(await authority.phase == .closed)
        #expect(try await authority.snapshot(queued.executionId, owner: session).state == .stopped)
        await #expect(throws: RuntimeAdmissionError.admissionClosed) {
            try await authority.prepare(self.request("late"), owner: session, at: self.start)
        }
    }

    @Test("a starting execution can enter the stopping barrier")
    func stopWhileStarting() async throws {
        let authority = RuntimeAdmission()
        let session = try owner()
        let approval = try await authority.prepare(request(), owner: session, at: start)
        let queued = try await authority.approve(approval.approvalId, owner: session, at: start)
        _ = try await authority.claimNext(at: start)

        let stopping = try await authority.requestStop(queued.executionId, owner: session, at: start)
        #expect(stopping.state == .stopping)
        #expect(stopping.treeTermination == .pending)
        #expect(stopping.sequence == 2)
    }

    @Test("an unconfirmed shutdown fails closed in closing state")
    func failedShutdown() async throws {
        let authority = RuntimeAdmission()
        let session = try owner()
        let approval = try await authority.prepare(request(), owner: session, at: start)
        _ = try await authority.approve(approval.approvalId, owner: session, at: start)
        _ = try await authority.claimNext(at: start)
        await #expect(throws: RuntimeAdmissionError.shutdownUnconfirmed) {
            try await authority.shutdown(at: self.start) { _ in
                throw RuntimeAdmissionError.shutdownUnconfirmed
            }
        }
        #expect(await authority.phase == .closing)
    }
}

private extension ClosedRange<Int> {
    func asyncMap<T>(_ transform: (Int) async throws -> T) async rethrows -> [T] {
        var result: [T] = []
        for value in self { result.append(try await transform(value)) }
        return result
    }
}
