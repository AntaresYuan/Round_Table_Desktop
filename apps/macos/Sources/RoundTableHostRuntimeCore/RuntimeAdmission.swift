import CryptoKit
import Foundation

public struct MissionID: Hashable, Sendable, Codable, RawRepresentable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
}

public struct ApprovalID: Hashable, Sendable, Codable, RawRepresentable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
}

public struct ExecutionID: Hashable, Sendable, Codable, RawRepresentable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
}

/// Authorization is connection-scoped. A PID, path, UID from a request body,
/// or any other caller-supplied identity is deliberately absent here.
public struct RuntimeSessionOwner: Hashable, Sendable {
    public let connectionGeneration: UInt64
    public let sessionNonce: String

    public init(connectionGeneration: UInt64, sessionNonce: String) throws {
        guard connectionGeneration > 0,
              sessionNonce.range(of: "^session_[a-f0-9]{32}$", options: .regularExpression) != nil else {
            throw RuntimeAdmissionError.notAuthorized
        }
        self.connectionGeneration = connectionGeneration
        self.sessionNonce = sessionNonce
    }
}

public enum RuntimeProvider: String, Codable, Sendable, CaseIterable {
    case codex
    case claudeCode = "claude-code"
    case opencode
}

public enum RuntimeExecutionState: String, Codable, Sendable, CaseIterable {
    case queued, starting, running, stopping, succeeded, failed, stopped
    case timedOut = "timed_out"

    public var isTerminal: Bool {
        switch self {
        case .succeeded, .failed, .stopped, .timedOut: true
        default: false
        }
    }
}

public enum RuntimeTreeTermination: String, Codable, Sendable {
    case notRequired = "not-required"
    case pending, confirmed, failed
}

public enum RuntimeOutputStream: String, Codable, Sendable {
    case status, stdout, stderr
}

public enum RuntimeAdmissionPhase: String, Sendable {
    case open, closing, closed
}

public enum RuntimeAdmissionError: String, Error, Equatable, Sendable {
    case notAuthorized = "execution_not_authorized"
    case admissionClosed = "runtime_admission_closed"
    case approvalLimit = "mission_approval_limit"
    case approvalInvalid = "mission_approval_invalid"
    case executionAlreadyActive = "execution_already_active"
    case queueFull = "execution_queue_full"
    case executionNotFound = "execution_not_found"
    case executionNotQueued = "execution_not_queued"
    case invalidTransition = "execution_transition_invalid"
    case invalidEventSequence = "execution_event_sequence_invalid"
    case eventReplayUnavailable = "execution_event_replay_unavailable"
    case shutdownInProgress = "runtime_shutdown_in_progress"
    case shutdownUnconfirmed = "runtime_shutdown_unconfirmed"
    case invalidRequest = "mission_request_invalid"
    case outputNotAccepted = "execution_output_not_accepted"
}

public struct MissionPreparationRequest: Equatable, Sendable {
    public var workspaceId: String
    public var provider: RuntimeProvider
    public var prompt: String

    public init(workspaceId: String, provider: RuntimeProvider, prompt: String) {
        self.workspaceId = workspaceId
        self.provider = provider
        self.prompt = prompt
    }
}

public struct MissionApproval: Equatable, Sendable {
    public let approvalId: ApprovalID
    public let missionId: MissionID
    public let owner: RuntimeSessionOwner
    public let workspaceId: String
    public let provider: RuntimeProvider
    public let prompt: String
    public let promptDigest: String
    public let expiresAt: Date
}

public struct RuntimeStateEvent: Equatable, Sendable {
    public let missionId: MissionID
    public let executionId: ExecutionID
    public let sequence: Int
    public let occurredAt: Date
    public let state: RuntimeExecutionState
    public let error: String?
    public let treeTermination: RuntimeTreeTermination

    public init(missionId: MissionID, executionId: ExecutionID, sequence: Int, occurredAt: Date,
                state: RuntimeExecutionState, error: String? = nil,
                treeTermination: RuntimeTreeTermination = .notRequired) {
        self.missionId = missionId
        self.executionId = executionId
        self.sequence = sequence
        self.occurredAt = occurredAt
        self.state = state
        self.error = error
        self.treeTermination = treeTermination
    }
}

public struct RuntimeOutputEvent: Equatable, Sendable {
    public let missionId: MissionID
    public let executionId: ExecutionID
    public let sequence: Int
    public let occurredAt: Date
    public let stream: RuntimeOutputStream
    public let text: String
    public let truncated: Bool
}

public enum RuntimeExecutionEvent: Equatable, Sendable {
    case state(RuntimeStateEvent)
    case output(RuntimeOutputEvent)

    public var sequence: Int {
        switch self {
        case .state(let event): event.sequence
        case .output(let event): event.sequence
        }
    }
}

public struct RuntimeLogEntry: Equatable, Sendable {
    public let sequence: Int
    public let occurredAt: Date
    public let stream: RuntimeOutputStream
    public let text: String
    public let truncated: Bool
}

public struct RuntimeExecutionSnapshot: Equatable, Sendable {
    public let missionId: MissionID
    public let executionId: ExecutionID
    public let owner: RuntimeSessionOwner
    public let workspaceId: String
    public let provider: RuntimeProvider
    public let prompt: String
    public let promptDigest: String
    public var state: RuntimeExecutionState
    public var sequence: Int
    public var startedAt: Date?
    public var finishedAt: Date?
    public var error: String?
    public var treeTermination: RuntimeTreeTermination
    public var logs: [RuntimeLogEntry]
    public var droppedLogEntries: Int
}

public struct RuntimeAdmissionConfiguration: Equatable, Sendable {
    public var approvalTTL: TimeInterval
    public var maxApprovals: Int
    public var maxQueuedExecutions: Int
    public var maxEventHistory: Int
    public var maxLogEntries: Int
    public var maxLogBytes: Int
    public var maxOutputEventBytes: Int
    /// Phase 4 leaves this false: busy means a second execution is rejected.
    /// Tests and later seat pools may exercise the bounded queue explicitly.
    public var allowQueueingBehindActive: Bool

    public init(approvalTTL: TimeInterval = 300, maxApprovals: Int = 8,
                maxQueuedExecutions: Int = 1, maxEventHistory: Int = 256,
                maxLogEntries: Int = 2_000, maxLogBytes: Int = 1_048_576,
                maxOutputEventBytes: Int = 8_192,
                allowQueueingBehindActive: Bool = false) {
        self.approvalTTL = max(1, approvalTTL)
        self.maxApprovals = max(1, maxApprovals)
        self.maxQueuedExecutions = max(1, maxQueuedExecutions)
        self.maxEventHistory = max(1, maxEventHistory)
        self.maxLogEntries = max(1, maxLogEntries)
        self.maxLogBytes = max(1, maxLogBytes)
        self.maxOutputEventBytes = min(8_192, max(1, maxOutputEventBytes))
        self.allowQueueingBehindActive = allowQueueingBehindActive
    }
}

/// Ephemeral S3 authority. Persistence and crash recovery belong to S8; this
/// actor establishes the state and ordering rules that the XPC dispatcher and
/// later persistent store must preserve.
public actor RuntimeAdmission {
    public typealias Stopper = @Sendable (RuntimeExecutionSnapshot) async throws -> RuntimeStateEvent

    private struct StoredExecution: Sendable {
        var snapshot: RuntimeExecutionSnapshot
        var events: [RuntimeExecutionEvent] = []
        var firstRetainedSequence = 1
        var logBytes = 0
    }

    private let configuration: RuntimeAdmissionConfiguration
    private var approvals: [ApprovalID: MissionApproval] = [:]
    private var executions: [ExecutionID: StoredExecution] = [:]
    private var queue: [ExecutionID] = []
    private var activeExecutionId: ExecutionID?
    private(set) public var phase: RuntimeAdmissionPhase = .open

    public init(configuration: RuntimeAdmissionConfiguration = .init()) {
        self.configuration = configuration
    }

    public func prepare(_ request: MissionPreparationRequest, owner: RuntimeSessionOwner,
                        at now: Date = Date()) throws -> MissionApproval {
        guard phase == .open else { throw RuntimeAdmissionError.admissionClosed }
        pruneApprovals(at: now)
        guard approvals.count < configuration.maxApprovals else { throw RuntimeAdmissionError.approvalLimit }
        guard !hasBlockingExecution else { throw RuntimeAdmissionError.executionAlreadyActive }
        let prompt = request.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard request.workspaceId.range(of: "^workspace_[A-Za-z0-9_-]{1,119}$", options: .regularExpression) != nil,
              !prompt.isEmpty, prompt.utf8.count <= 12_000 else {
            throw RuntimeAdmissionError.invalidRequest
        }
        let approval = MissionApproval(
            approvalId: ApprovalID(rawValue: "approval_\(UUID().uuidString.lowercased())"),
            missionId: MissionID(rawValue: "mission_\(UUID().uuidString.lowercased())"),
            owner: owner,
            workspaceId: request.workspaceId,
            provider: request.provider,
            prompt: prompt,
            promptDigest: Self.digest(prompt),
            expiresAt: now.addingTimeInterval(configuration.approvalTTL)
        )
        approvals[approval.approvalId] = approval
        return approval
    }

    public func approve(_ approvalId: ApprovalID, owner: RuntimeSessionOwner,
                        at now: Date = Date()) throws -> RuntimeExecutionSnapshot {
        guard phase == .open else { throw RuntimeAdmissionError.admissionClosed }
        pruneApprovals(at: now)
        guard let approval = approvals[approvalId], approval.owner == owner,
              approval.expiresAt > now else { throw RuntimeAdmissionError.approvalInvalid }
        if hasBlockingExecution && !configuration.allowQueueingBehindActive {
            throw RuntimeAdmissionError.executionAlreadyActive
        }
        guard queue.count < configuration.maxQueuedExecutions else { throw RuntimeAdmissionError.queueFull }
        approvals.removeValue(forKey: approvalId)
        let executionId = ExecutionID(rawValue: "execution_\(UUID().uuidString.lowercased())")
        let snapshot = RuntimeExecutionSnapshot(
            missionId: approval.missionId, executionId: executionId, owner: owner,
            workspaceId: approval.workspaceId, provider: approval.provider,
            prompt: approval.prompt, promptDigest: approval.promptDigest,
            state: .queued, sequence: 0, startedAt: nil, finishedAt: nil,
            error: nil, treeTermination: .notRequired, logs: [], droppedLogEntries: 0
        )
        executions[executionId] = StoredExecution(snapshot: snapshot)
        queue.append(executionId)
        return snapshot
    }

    public func pendingApproval(_ approvalId: ApprovalID, owner: RuntimeSessionOwner,
                                at now: Date = Date()) throws -> MissionApproval {
        guard phase == .open else { throw RuntimeAdmissionError.admissionClosed }
        pruneApprovals(at: now)
        guard let approval = approvals[approvalId], approval.owner == owner,
              approval.expiresAt > now else { throw RuntimeAdmissionError.approvalInvalid }
        return approval
    }

    /// Claims the oldest queued execution. Only one claim can be active.
    public func claimNext(at now: Date = Date()) throws -> RuntimeExecutionSnapshot? {
        guard phase == .open else { throw RuntimeAdmissionError.admissionClosed }
        guard activeExecutionId == nil else { return nil }
        guard let executionId = queue.first else { return nil }
        queue.removeFirst()
        activeExecutionId = executionId
        guard var stored = executions[executionId] else { throw RuntimeAdmissionError.executionNotFound }
        let event = RuntimeStateEvent(missionId: stored.snapshot.missionId, executionId: executionId,
                                      sequence: stored.snapshot.sequence + 1, occurredAt: now,
                                      state: .starting)
        try apply(event, to: &stored)
        executions[executionId] = stored
        return stored.snapshot
    }

    public func apply(_ event: RuntimeStateEvent) throws -> RuntimeExecutionSnapshot {
        guard var stored = executions[event.executionId], stored.snapshot.missionId == event.missionId else {
            throw RuntimeAdmissionError.executionNotFound
        }
        try apply(event, to: &stored)
        executions[event.executionId] = stored
        if stored.snapshot.state.isTerminal, stored.snapshot.treeTermination != .failed,
           activeExecutionId == event.executionId {
            activeExecutionId = nil
        }
        return stored.snapshot
    }

    public func requestStop(_ executionId: ExecutionID, owner: RuntimeSessionOwner,
                            at now: Date = Date()) throws -> RuntimeExecutionSnapshot {
        guard var stored = executions[executionId], stored.snapshot.owner == owner else {
            throw RuntimeAdmissionError.notAuthorized
        }
        if stored.snapshot.state.isTerminal, stored.snapshot.treeTermination != .failed { return stored.snapshot }
        if stored.snapshot.state == .queued {
            queue.removeAll { $0 == executionId }
            let event = RuntimeStateEvent(missionId: stored.snapshot.missionId, executionId: executionId,
                                          sequence: stored.snapshot.sequence + 1, occurredAt: now,
                                          state: .stopped, treeTermination: .confirmed)
            try apply(event, to: &stored)
        } else if stored.snapshot.state != .stopping {
            let event = RuntimeStateEvent(missionId: stored.snapshot.missionId, executionId: executionId,
                                          sequence: stored.snapshot.sequence + 1, occurredAt: now,
                                          state: .stopping, treeTermination: .pending)
            try apply(event, to: &stored)
        }
        executions[executionId] = stored
        return stored.snapshot
    }

    public func snapshot(_ executionId: ExecutionID, owner: RuntimeSessionOwner) throws -> RuntimeExecutionSnapshot {
        guard let stored = executions[executionId], stored.snapshot.owner == owner else {
            throw RuntimeAdmissionError.notAuthorized
        }
        return stored.snapshot
    }

    public func events(for executionId: ExecutionID, owner: RuntimeSessionOwner,
                       after sequence: Int) throws -> [RuntimeExecutionEvent] {
        guard let stored = executions[executionId], stored.snapshot.owner == owner else {
            throw RuntimeAdmissionError.notAuthorized
        }
        guard sequence >= 0, sequence >= stored.firstRetainedSequence - 1 else {
            throw RuntimeAdmissionError.eventReplayUnavailable
        }
        return stored.events.filter { $0.sequence > sequence }
    }

    /// Records bounded provider output in the same sequence domain as state
    /// changes. Oversized UTF-8 text is shortened at a scalar boundary and the
    /// truncation remains visible to the App.
    public func appendOutput(missionId: MissionID, executionId: ExecutionID,
                             sequence: Int, occurredAt: Date = Date(),
                             stream: RuntimeOutputStream, text: String) throws -> RuntimeOutputEvent {
        guard var stored = executions[executionId], stored.snapshot.missionId == missionId else {
            throw RuntimeAdmissionError.executionNotFound
        }
        guard !stored.snapshot.state.isTerminal,
              !text.isEmpty, !text.unicodeScalars.contains(where: { $0.value == 0 }) else {
            throw RuntimeAdmissionError.outputNotAccepted
        }
        guard sequence == stored.snapshot.sequence + 1 else {
            throw RuntimeAdmissionError.invalidEventSequence
        }
        let bounded = Self.boundedUTF8(text, maximumBytes: configuration.maxOutputEventBytes)
        let event = RuntimeOutputEvent(missionId: missionId, executionId: executionId,
                                       sequence: sequence, occurredAt: occurredAt,
                                       stream: stream, text: bounded.text,
                                       truncated: bounded.truncated)
        stored.snapshot.sequence = sequence
        let entry = RuntimeLogEntry(sequence: sequence, occurredAt: occurredAt,
                                    stream: stream, text: bounded.text,
                                    truncated: bounded.truncated)
        stored.snapshot.logs.append(entry)
        stored.logBytes += bounded.text.utf8.count
        while stored.snapshot.logs.count > configuration.maxLogEntries
                || stored.logBytes > configuration.maxLogBytes {
            let removed = stored.snapshot.logs.removeFirst()
            stored.logBytes -= removed.text.utf8.count
            stored.snapshot.droppedLogEntries += 1
        }
        appendEvent(.output(event), to: &stored)
        executions[executionId] = stored
        return event
    }

    public func pendingApprovalCount(at now: Date = Date()) -> Int {
        pruneApprovals(at: now)
        return approvals.count
    }

    public func queuedExecutionCount() -> Int { queue.count }

    public func admissionStatus() -> RuntimeAdmissionStatus {
        if phase != .open { return .closed }
        return hasBlockingExecution ? .busy : .open
    }

    /// Closes admission first, settles queued work, then waits for a confirmed
    /// stop proof for the active execution. Failure leaves the actor closing.
    public func shutdown(at now: Date = Date(), stop: Stopper) async throws {
        if phase == .closed { return }
        guard phase == .open else { throw RuntimeAdmissionError.shutdownInProgress }
        phase = .closing
        approvals.removeAll()

        for executionId in queue {
            guard var stored = executions[executionId] else { continue }
            let event = RuntimeStateEvent(missionId: stored.snapshot.missionId, executionId: executionId,
                                          sequence: stored.snapshot.sequence + 1, occurredAt: now,
                                          state: .stopped, treeTermination: .confirmed)
            try apply(event, to: &stored)
            executions[executionId] = stored
        }
        queue.removeAll()

        if let activeExecutionId, let active = executions[activeExecutionId]?.snapshot {
            do {
                let event = try await stop(active)
                _ = try apply(event)
            } catch {
                throw RuntimeAdmissionError.shutdownUnconfirmed
            }
        }
        guard activeExecutionId == nil, queue.isEmpty else {
            throw RuntimeAdmissionError.shutdownUnconfirmed
        }
        phase = .closed
    }

    private var hasBlockingExecution: Bool {
        executions.values.contains {
            !$0.snapshot.state.isTerminal || $0.snapshot.treeTermination == .failed
        }
    }

    private func pruneApprovals(at now: Date) {
        approvals = approvals.filter { $0.value.expiresAt > now }
    }

    private func apply(_ event: RuntimeStateEvent, to stored: inout StoredExecution) throws {
        let current = stored.snapshot
        guard event.sequence == current.sequence + 1 else {
            throw RuntimeAdmissionError.invalidEventSequence
        }
        guard Self.transitionAllowed(from: current.state, to: event.state,
                                     currentTermination: current.treeTermination,
                                     nextTermination: event.treeTermination) else {
            throw RuntimeAdmissionError.invalidTransition
        }
        stored.snapshot.state = event.state
        stored.snapshot.sequence = event.sequence
        stored.snapshot.error = event.error
        stored.snapshot.treeTermination = event.treeTermination
        if event.state == .running, stored.snapshot.startedAt == nil { stored.snapshot.startedAt = event.occurredAt }
        if event.state.isTerminal { stored.snapshot.finishedAt = event.occurredAt }
        appendEvent(.state(event), to: &stored)
    }

    private func appendEvent(_ event: RuntimeExecutionEvent, to stored: inout StoredExecution) {
        stored.events.append(event)
        if stored.events.count > configuration.maxEventHistory {
            stored.events.removeFirst(stored.events.count - configuration.maxEventHistory)
            stored.firstRetainedSequence = stored.events.first?.sequence ?? event.sequence + 1
        }
    }

    private static func transitionAllowed(from: RuntimeExecutionState, to: RuntimeExecutionState,
                                          currentTermination: RuntimeTreeTermination,
                                          nextTermination: RuntimeTreeTermination) -> Bool {
        if from.isTerminal {
            return currentTermination == .failed && to.isTerminal && nextTermination == .confirmed
        }
        switch (from, to) {
        case (.queued, .starting), (.queued, .stopped),
             (.starting, .running), (.starting, .stopping), (.starting, .failed),
             (.starting, .stopped), (.starting, .timedOut),
             (.running, .stopping), (.running, .succeeded), (.running, .failed),
             (.running, .stopped), (.running, .timedOut),
             (.stopping, .stopped), (.stopping, .failed), (.stopping, .timedOut):
            break
        default:
            return false
        }
        if to == .stopping { return nextTermination == .pending }
        if to == .stopped { return nextTermination == .confirmed || nextTermination == .failed }
        if to == .succeeded { return nextTermination == .confirmed }
        return true
    }

    private static func digest(_ prompt: String) -> String {
        SHA256.hash(data: Data(prompt.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func boundedUTF8(_ text: String, maximumBytes: Int) -> (text: String, truncated: Bool) {
        guard text.utf8.count > maximumBytes else { return (text, false) }
        var result = ""
        var bytes = 0
        for scalar in text.unicodeScalars {
            let width = String(scalar).utf8.count
            guard bytes + width <= maximumBytes else { break }
            result.unicodeScalars.append(scalar)
            bytes += width
        }
        return (result, true)
    }
}

public enum RuntimeAdmissionStatus: String, Sendable {
    case closed, open, busy
}
