import Foundation

public enum TurnStreamAction: String, Sendable { case start, poll, approve, accept, stop }

public struct TurnStreamRequest: Equatable, Sendable {
    public let requestId: String
    public let sessionNonce: String
    public let action: TurnStreamAction
    public let streamId: String?
    public let afterSequence: Int?
    public let goal: String?
    public let workflowTemplateId: String?

    public static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= MacOSHostRuntimeV1Generated.turnStreamMaxRequestBytes else {
            throw ContractValidationError.valueMismatch("$")
        }
        var parser = try StrictJSONParser(data: data)
        guard case .object(let root) = try parser.parse(),
              case .number(String(MacOSHostRuntimeV1Generated.version)) = root["protocolVersion"],
              case .string(let requestId) = root["requestId"], valid(requestId, prefix: "request_"),
              case .string(let nonce) = root["sessionNonce"], valid(nonce, prefix: "session_"),
              case .string(let actionValue) = root["action"],
              let action = TurnStreamAction(rawValue: actionValue) else {
            throw ContractValidationError.schemaMismatch("$")
        }
        let streamId: String?
        let after: Int?
        let goal: String?
        let workflow: String?
        switch action {
        case .start:
            guard Set(root.keys) == ["protocolVersion", "requestId", "sessionNonce", "action", "goal", "workflowTemplateId"],
                  case .string(let goalValue) = root["goal"], (1...12_000).contains(goalValue.utf8.count),
                  case .string(let workflowValue) = root["workflowTemplateId"], valid(workflowValue, prefix: "wf-") else {
                throw ContractValidationError.valueMismatch("$.start")
            }
            streamId = nil; after = nil; goal = goalValue; workflow = workflowValue
        case .poll:
            guard Set(root.keys) == ["protocolVersion", "requestId", "sessionNonce", "action", "streamId", "afterSequence"],
                  case .string(let id) = root["streamId"], valid(id, prefix: "turnstream_"),
                  case .number(let token) = root["afterSequence"], let value = Int(token), value >= 0 else {
                throw ContractValidationError.valueMismatch("$.poll")
            }
            streamId = id; after = value; goal = nil; workflow = nil
        case .approve, .accept, .stop:
            guard Set(root.keys) == ["protocolVersion", "requestId", "sessionNonce", "action", "streamId"],
                  case .string(let id) = root["streamId"], valid(id, prefix: "turnstream_") else {
                throw ContractValidationError.valueMismatch("$.streamId")
            }
            streamId = id; after = nil; goal = nil; workflow = nil
        }
        return .init(requestId: requestId, sessionNonce: nonce, action: action,
                     streamId: streamId, afterSequence: after, goal: goal,
                     workflowTemplateId: workflow)
    }

    private static func valid(_ value: String, prefix: String) -> Bool {
        value.hasPrefix(prefix) && value.utf8.count <= 128 && value.unicodeScalars.allSatisfy {
            CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-").contains($0)
        }
    }
}

public struct TurnStreamFramePayload: Equatable, Sendable {
    public let sequence: Int
    public let gate: String?
    public let turn: Data
}

public struct TurnStreamResponse: Equatable, Sendable {
    public let requestId: String
    public let ok: Bool
    public let error: String?
    public let streamId: String?
    public let awaiting: String?
    public let terminal: Bool?
    public let frames: [TurnStreamFramePayload]

    public static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= MacOSHostRuntimeV1Generated.turnStreamMaxResponseBytes else {
            throw ContractValidationError.valueMismatch("$")
        }
        var parser = try StrictJSONParser(data: data)
        guard case .object(let root) = try parser.parse(),
              case .number(String(MacOSHostRuntimeV1Generated.version)) = root["protocolVersion"],
              case .string(let requestId) = root["requestId"],
              case .boolean(let ok) = root["ok"] else {
            throw ContractValidationError.schemaMismatch("$")
        }
        if !ok {
            guard Set(root.keys) == ["protocolVersion", "requestId", "ok", "error"],
                  case .string(let error) = root["error"], (1...100).contains(error.utf8.count) else {
                throw ContractValidationError.schemaMismatch("$")
            }
            return .init(requestId: requestId, ok: false, error: error,
                         streamId: nil, awaiting: nil, terminal: nil, frames: [])
        }
        guard Set(root.keys) == ["protocolVersion", "requestId", "ok", "streamId", "awaiting", "terminal", "frames"],
              case .string(let streamId) = root["streamId"],
              case .boolean(let terminal) = root["terminal"],
              case .array(let rawFrames) = root["frames"],
              rawFrames.count <= MacOSHostRuntimeV1Generated.turnStreamMaxFrames else {
            throw ContractValidationError.schemaMismatch("$")
        }
        let awaiting: String?
        switch root["awaiting"] {
        case .null: awaiting = nil
        case .string(let value) where ["plan_approval", "delivery_decision"].contains(value): awaiting = value
        default: throw ContractValidationError.valueMismatch("$.awaiting")
        }
        var frames: [TurnStreamFramePayload] = []
        var previous = 0
        for raw in rawFrames {
            guard case .object(let item) = raw,
                  Set(item.keys) == ["sequence", "gate", "turn"],
                  case .number(let token) = item["sequence"], let sequence = Int(token), sequence > previous,
                  case .object(let turn) = item["turn"] else {
                throw ContractValidationError.valueMismatch("$.frames")
            }
            let gate: String?
            switch item["gate"] {
            case .null: gate = nil
            case .string(let value) where ["plan_approval", "delivery_decision"].contains(value): gate = value
            default: throw ContractValidationError.valueMismatch("$.frames.gate")
            }
            let encoded = StrictJSONValue.object(turn).encodedData()
            guard encoded.count <= MacOSHostRuntimeV1Generated.turnStreamMaxTurnBytes else {
                throw ContractValidationError.valueMismatch("$.frames.turn")
            }
            frames.append(.init(sequence: sequence, gate: gate, turn: encoded))
            previous = sequence
        }
        return .init(requestId: requestId, ok: true, error: nil, streamId: streamId,
                     awaiting: awaiting, terminal: terminal, frames: frames)
    }
}
