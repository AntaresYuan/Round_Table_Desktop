import Foundation
import Security
#if SWIFT_PACKAGE
import RoundTableContracts
#endif

public enum OrchestrationGate: String, Sendable, Codable {
    case planApproval = "plan_approval"
    case deliveryDecision = "delivery_decision"
}

public enum OrchestrationError: String, Error, Equatable, Sendable {
    case oracleInvalid = "orchestration_oracle_invalid"
    case requestInvalid = "orchestration_request_invalid"
    case streamNotFound = "orchestration_stream_not_found"
    case streamOwnerMismatch = "orchestration_stream_owner_mismatch"
    case gateMismatch = "orchestration_gate_mismatch"
    case replayUnavailable = "orchestration_replay_unavailable"
    case streamTerminal = "orchestration_stream_terminal"
}

public struct OrchestrationFrame: Equatable, Sendable {
    public let sequence: Int
    public let gate: OrchestrationGate?
    public let turn: Data

    public init(sequence: Int, gate: OrchestrationGate?, turn: Data) {
        self.sequence = sequence
        self.gate = gate
        self.turn = turn
    }
}

public struct OrchestrationBatch: Equatable, Sendable {
    public let streamId: String
    public let frames: [OrchestrationFrame]
    public let awaiting: OrchestrationGate?
    public let terminal: Bool
}

/// Host-owned deterministic orchestration used by S3.
///
/// The adapter consumes a bounded TS `local-dispatch` oracle.  It does not
/// launch a provider or touch a workspace.  A stream belongs to the verified
/// XPC session, pauses at the same approval gates as the Web, and retains a
/// bounded replay window for disconnect-safe polling.
public actor RoundTableOrchestration {
    public static let maximumFrames = MacOSHostRuntimeV1Generated.turnStreamMaxFrames
    public static let maximumTurnBytes = MacOSHostRuntimeV1Generated.turnStreamMaxTurnBytes
    public static let maximumGoalBytes = 12_000

    private struct Stream {
        let id: String
        let owner: RuntimeSessionOwner
        var visibleCount: Int
        var awaiting: OrchestrationGate?
        var terminal: Bool
    }

    private let oracle: [OrchestrationFrame]
    private let oracleGoal: String
    private let workflowTemplateId: String
    private var streams: [String: Stream] = [:]

    public init(oracleData: Data) throws {
        guard oracleData.count <= Self.maximumFrames * Self.maximumTurnBytes else {
            throw OrchestrationError.oracleInvalid
        }
        let parsed: StrictJSONValue
        do {
            var parser = try StrictJSONParser(data: oracleData)
            parsed = try parser.parse()
        } catch {
            throw OrchestrationError.oracleInvalid
        }
        guard case .object(let root) = parsed,
              Set(root.keys) == ["format", "version", "source", "frames"],
              root["format"] == .string("roundtable.turn-timeline"),
              root["version"] == .number("1"),
              case .object(let source) = root["source"],
              Set(source.keys) == ["adapter", "workflowTemplateId", "provider", "model", "capturedAt", "capturedWith"],
              source["adapter"] == .string("local-dispatch"),
              case .string(let workflow) = source["workflowTemplateId"],
              workflow.range(of: "^[A-Za-z0-9._:-]{1,128}$", options: .regularExpression) != nil,
              case .array(let rawFrames) = root["frames"],
              !rawFrames.isEmpty, rawFrames.count <= Self.maximumFrames else {
            throw OrchestrationError.oracleInvalid
        }

        var decoded: [OrchestrationFrame] = []
        var turnObjects: [[String: StrictJSONValue]] = []
        var goal: String?
        for (index, raw) in rawFrames.enumerated() {
            guard case .object(let frame) = raw,
                  Set(frame.keys) == (frame["gate"] == nil
                    ? ["atMs", "turn"] : ["atMs", "gate", "turn"]),
                  case .number(let atMs) = frame["atMs"],
                  let milliseconds = Int(atMs), milliseconds >= 0,
                  case .object(let turnObject) = frame["turn"],
                  case .string(let message) = turnObject["message"],
                  !message.isEmpty, message.utf8.count <= Self.maximumGoalBytes else {
                throw OrchestrationError.oracleInvalid
            }
            if let goal, goal != message { throw OrchestrationError.oracleInvalid }
            goal = message
            let gate: OrchestrationGate?
            if let value = frame["gate"] {
                guard case .string(let token) = value,
                      let parsed = OrchestrationGate(rawValue: token) else {
                    throw OrchestrationError.oracleInvalid
                }
                gate = parsed
            } else { gate = nil }
            let turn = StrictJSONValue.object(turnObject).encodedData()
            guard turn.count <= Self.maximumTurnBytes else {
                throw OrchestrationError.oracleInvalid
            }
            decoded.append(.init(sequence: index + 1, gate: gate, turn: turn))
            turnObjects.append(turnObject)
        }
        guard decoded.first?.gate == .planApproval,
              decoded.last?.gate == .deliveryDecision,
              decoded.dropFirst().dropLast().allSatisfy({ $0.gate == nil }),
              let goal else {
            throw OrchestrationError.oracleInvalid
        }
        guard Self.validDeterministicDispatch(turnObjects) else {
            throw OrchestrationError.oracleInvalid
        }
        oracle = decoded
        oracleGoal = goal
        workflowTemplateId = workflow
    }

    public func start(goal: String, workflowTemplateId: String,
                      owner: RuntimeSessionOwner) throws -> OrchestrationBatch {
        guard goal == oracleGoal, workflowTemplateId == self.workflowTemplateId,
              goal.utf8.count <= Self.maximumGoalBytes else {
            throw OrchestrationError.requestInvalid
        }
        let id = "turnstream_" + (try Self.randomHex(bytes: 16))
        let stream = Stream(id: id, owner: owner, visibleCount: 1,
                            awaiting: oracle[0].gate, terminal: false)
        streams[id] = stream
        return batch(stream, afterSequence: 0)
    }

    public func poll(streamId: String, afterSequence: Int,
                     owner: RuntimeSessionOwner) throws -> OrchestrationBatch {
        let stream = try requireStream(streamId, owner: owner)
        guard afterSequence >= 0, afterSequence <= stream.visibleCount else {
            throw OrchestrationError.replayUnavailable
        }
        return batch(stream, afterSequence: afterSequence)
    }

    public func resolve(streamId: String, gate: OrchestrationGate,
                        owner: RuntimeSessionOwner) throws -> OrchestrationBatch {
        var stream = try requireStream(streamId, owner: owner)
        guard !stream.terminal else { throw OrchestrationError.streamTerminal }
        guard stream.awaiting == gate else { throw OrchestrationError.gateMismatch }
        switch gate {
        case .planApproval:
            stream.visibleCount = oracle.count
            stream.awaiting = oracle.last?.gate
        case .deliveryDecision:
            stream.awaiting = nil
            stream.terminal = true
        }
        streams[streamId] = stream
        return batch(stream, afterSequence: 0)
    }

    public func stop(streamId: String, owner: RuntimeSessionOwner) throws {
        _ = try requireStream(streamId, owner: owner)
        streams.removeValue(forKey: streamId)
    }

    public func revokeOwned(by owner: RuntimeSessionOwner) {
        streams = streams.filter { $0.value.owner != owner }
    }

    private func requireStream(_ id: String, owner: RuntimeSessionOwner) throws -> Stream {
        guard let stream = streams[id] else { throw OrchestrationError.streamNotFound }
        guard stream.owner == owner else { throw OrchestrationError.streamOwnerMismatch }
        return stream
    }

    private func batch(_ stream: Stream, afterSequence: Int) -> OrchestrationBatch {
        let frames = oracle.prefix(stream.visibleCount).filter { $0.sequence > afterSequence }
        return .init(streamId: stream.id, frames: Array(frames),
                     awaiting: stream.awaiting, terminal: stream.terminal)
    }

    private static func randomHex(bytes: Int) throws -> String {
        var data = [UInt8](repeating: 0, count: bytes)
        let count = data.count
        let status = data.withUnsafeMutableBytes {
            SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!)
        }
        guard status == errSecSuccess else {
            throw OrchestrationError.requestInvalid
        }
        return data.map { String(format: "%02x", $0) }.joined()
    }

    private static func validDeterministicDispatch(
        _ turns: [[String: StrictJSONValue]]
    ) -> Bool {
        guard let first = turns.first, let final = turns.last,
              case .object(let meeting) = first["planningMeeting"],
              case .array(let messages) = meeting["messages"], !messages.isEmpty,
              first["approvalStatus"] == .string("pending"),
              final["approvalStatus"] == .string("approved"),
              final["dispatchStatus"] == .string("completed"),
              case .object(let plan) = final["plan"],
              case .array(let rawTasks) = plan["tasks"], !rawTasks.isEmpty,
              case .array(let dispatch) = final["dispatch"], dispatch.count == rawTasks.count,
              case .object(let mission) = final["mission"],
              case .object(let delivery) = mission["finalDelivery"],
              delivery["status"] == .string("ready") else { return false }

        var tasks: [String: [String]] = [:]
        for raw in rawTasks {
            guard case .object(let task) = raw,
                  case .string(let id) = task["id"], tasks[id] == nil,
                  case .array(let rawDependencies) = task["deps"] else { return false }
            var dependencies: [String] = []
            for dependency in rawDependencies {
                guard case .string(let value) = dependency else { return false }
                dependencies.append(value)
            }
            tasks[id] = dependencies
        }
        var completed = Set<String>()
        for raw in dispatch {
            guard case .object(let record) = raw,
                  case .string(let taskId) = record["taskId"],
                  record["status"] == .string("completed"),
                  let dependencies = tasks[taskId],
                  dependencies.allSatisfy(completed.contains),
                  completed.insert(taskId).inserted else { return false }
        }
        return completed == Set(tasks.keys)
    }
}

public enum TurnStreamWireCodec {
    public static func success(requestId: String, batch: OrchestrationBatch) -> Data {
        let frames = batch.frames.map { frame in
            let gate = frame.gate.map { quoted($0.rawValue) } ?? "null"
            return "{\"gate\":\(gate),\"sequence\":\(frame.sequence),\"turn\":"
                + String(decoding: frame.turn, as: UTF8.self) + "}"
        }.joined(separator: ",")
        let awaiting = batch.awaiting.map { quoted($0.rawValue) } ?? "null"
        return Data(("{\"awaiting\":\(awaiting),\"frames\":[\(frames)],\"ok\":true,"
            + "\"protocolVersion\":1,\"requestId\":\(quoted(requestId)),"
            + "\"streamId\":\(quoted(batch.streamId)),\"terminal\":\(batch.terminal)}").utf8)
    }

    public static func failure(requestId: String, error: String) -> Data {
        Data(("{\"error\":\(quoted(error)),\"ok\":false,\"protocolVersion\":1,"
            + "\"requestId\":\(quoted(requestId))}").utf8)
    }

    private static func quoted(_ value: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [value])
        let array = String(decoding: data, as: UTF8.self)
        return String(array.dropFirst().dropLast())
    }
}
