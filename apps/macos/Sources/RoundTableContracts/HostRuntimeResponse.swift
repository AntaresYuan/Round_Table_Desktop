import Foundation

struct HostRuntimeResponseEnvelope: Equatable, Sendable {
    let protocolVersion: Int
    let requestID: String
    let operation: HostRuntimeOperation
    let ok: Bool
    let payload: StrictJSONValue
    let error: String?

    init(protocolVersion: Int = MacOSHostRuntimeV1Generated.version,
                requestID: String, operation: HostRuntimeOperation, ok: Bool,
                payload: StrictJSONValue = .object([:]), error: String? = nil) {
        self.protocolVersion = protocolVersion
        self.requestID = requestID
        self.operation = operation
        self.ok = ok
        self.payload = payload
        self.error = error
    }

    func encodedData() -> Data {
        var object: [String: StrictJSONValue] = [
            "protocolVersion": .number(String(protocolVersion)),
            "requestId": .string(requestID),
            "operation": .string(operation.rawValue),
            "ok": .boolean(ok),
            "payload": payload,
            "error": error.map(StrictJSONValue.string) ?? .null,
        ]
        if !ok { object["payload"] = .object([:]) }
        return StrictJSONValue.object(object).encodedData()
    }

    static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= MacOSHostRuntimeV1Generated.maxResponseBytes else { throw ContractValidationError.valueMismatch("$") }
        let root = try parse(data)
        guard case .object(let object) = root,
              Set(object.keys) == Set(MacOSHostRuntimeV1Generated.commonResponseKeys) else {
            throw ContractValidationError.schemaMismatch("$")
        }
        guard case .number(let versionToken) = object["protocolVersion"],
              let version = Int(versionToken), version == MacOSHostRuntimeV1Generated.version else {
            throw ContractValidationError.valueMismatch("$.protocolVersion")
        }
        let requestID = try opaqueID(object["requestId"], path: "$.requestId", prefix: "request_")
        guard case .string(let operationText) = object["operation"],
              let operation = HostRuntimeOperation(rawValue: operationText) else {
            throw ContractValidationError.valueMismatch("$.operation")
        }
        guard case .boolean(let ok) = object["ok"] else { throw ContractValidationError.schemaMismatch("$.ok") }
        let payload: StrictJSONValue
        if ok {
            payload = try exactObject(object["payload"], path: "$.payload", keys: Set(MacOSHostRuntimeV1Generated.responsePayloadKeySets[operation.rawValue] ?? []))
            guard case .null = object["error"] else { throw ContractValidationError.schemaMismatch("$.error") }
        } else {
            guard case .object(let errorObject) = object["payload"], errorObject.isEmpty else { throw ContractValidationError.schemaMismatch("$.payload") }
            guard case .string(let error) = object["error"], error.range(of: #"^[a-z][a-z0-9_]{0,79}$"#, options: .regularExpression) != nil else { throw ContractValidationError.valueMismatch("$.error") }
            payload = .object([:])
        }
        if ok { try validateOperationPayload(operation, payload) }
        try rejectForbiddenKeys(payload, path: "$.payload")
        return Self(protocolVersion: version, requestID: requestID, operation: operation, ok: ok, payload: payload, error: ok ? nil : (object["error"].flatMap { if case .string(let s) = $0 { return s }; return nil }))
    }
}

struct HostRuntimeEventEnvelope: Equatable, Sendable {
    let protocolVersion: Int
    let sessionNonce: String
    let event: String
    let sequence: Int
    let payload: StrictJSONValue

    static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= MacOSHostRuntimeV1Generated.maxEventBytes else { throw ContractValidationError.valueMismatch("$") }
        let root = try parse(data)
        guard case .object(let object) = root,
              Set(object.keys) == Set(MacOSHostRuntimeV1Generated.eventKeys) else { throw ContractValidationError.schemaMismatch("$") }
        guard case .number(let token) = object["protocolVersion"], let version = Int(token), version == MacOSHostRuntimeV1Generated.version else { throw ContractValidationError.valueMismatch("$.protocolVersion") }
        let nonce = try opaqueID(object["sessionNonce"], path: "$.sessionNonce", prefix: "session_")
        guard case .string(let event) = object["event"], MacOSHostRuntimeV1Generated.events.contains(event) else { throw ContractValidationError.valueMismatch("$.event") }
        guard case .number(let sequenceToken) = object["sequence"], let sequence = Int(sequenceToken), sequence > 0 else { throw ContractValidationError.valueMismatch("$.sequence") }
        guard case .object(let payloadObject) = object["payload"],
              case .string(let type) = payloadObject["type"],
              ["state", "output", "artifact"].contains(type),
              let payloadKeys = MacOSHostRuntimeV1Generated.eventPayloadKeySets["\(event).\(type)"] else {
            throw ContractValidationError.schemaMismatch("$.payload")
        }
        guard case .number(let payloadSequenceToken) = payloadObject["sequence"],
              Int(payloadSequenceToken) == sequence else {
            throw ContractValidationError.valueMismatch("$.payload.sequence")
        }
        guard case .string(let missionID) = payloadObject["missionId"], validOpaqueID(missionID, prefix: "mission_"),
              case .string(let executionID) = payloadObject["executionId"], validOpaqueID(executionID, prefix: "execution_"),
              case .string(let occurredAt) = payloadObject["occurredAt"], parseTimestamp(occurredAt) else {
            throw ContractValidationError.valueMismatch("$.payload")
        }
        if type == "state" {
            guard case .string(let state) = payloadObject["state"], MacOSHostRuntimeV1Generated.executionStates.contains(state),
                  case .string(let termination) = payloadObject["treeTermination"], MacOSHostRuntimeV1Generated.treeTerminationStates.contains(termination),
                  validOptionalError(payloadObject["error"]) else { throw ContractValidationError.valueMismatch("$.payload.state") }
            if state == "stopping" { guard termination == "pending" else { throw ContractValidationError.valueMismatch("$.payload.treeTermination") } }
            if state == "stopped" { guard termination == "confirmed" || termination == "failed" else { throw ContractValidationError.valueMismatch("$.payload.treeTermination") } }
        } else if type == "output" {
            guard case .string(let stream) = payloadObject["stream"], ["status", "stdout", "stderr"].contains(stream),
                  case .string(let text) = payloadObject["text"], !text.isEmpty, text.utf8.count <= 8_192, !text.unicodeScalars.contains(where: { $0.value == 0 }),
                  case .boolean = payloadObject["truncated"] else { throw ContractValidationError.valueMismatch("$.payload.output") }
        } else {
            guard case .object(let artifact) = payloadObject["artifact"],
                  Set(artifact.keys) == Set(["relativePath", "change", "size", "sha256", "scanStatus", "provenance"]),
                  case .string(let relativePath) = artifact["relativePath"], validPortableRelativePath(relativePath),
                  case .string(let change) = artifact["change"], ["created", "modified", "deleted"].contains(change),
                  case .number(let sizeToken) = artifact["size"], let size = Int(sizeToken), (0...1_000_000_000).contains(size),
                  case .string("scanned") = artifact["scanStatus"], case .string("runtime-workspace-scan") = artifact["provenance"] else { throw ContractValidationError.valueMismatch("$.payload.artifact") }
            if change == "deleted" { guard size == 0, case .null = artifact["sha256"] else { throw ContractValidationError.valueMismatch("$.payload.artifact.sha256") } }
            else { guard case .string(let hash) = artifact["sha256"], hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ContractValidationError.valueMismatch("$.payload.artifact.sha256") } }
        }
        let payload = try exactObject(.object(payloadObject), path: "$.payload", keys: Set(payloadKeys))
        try rejectForbiddenKeys(payload, path: "$.payload")
        return Self(protocolVersion: version, sessionNonce: nonce, event: event, sequence: sequence, payload: payload)
    }
}

private func parse(_ data: Data) throws -> StrictJSONValue {
    do { var parser = try StrictJSONParser(data: data); return try parser.parse() }
    catch StrictJSONError.duplicateKey(let key) { throw ContractValidationError.duplicateKey(key) }
    catch { throw ContractValidationError.malformedJSON }
}

private func exactObject(_ value: StrictJSONValue?, path: String, keys: Set<String>) throws -> StrictJSONValue {
    guard case .object(let object) = value, Set(object.keys) == keys else { throw ContractValidationError.schemaMismatch(path) }
    return .object(object)
}

private func opaqueID(_ value: StrictJSONValue?, path: String, prefix: String) throws -> String {
    guard case .string(let string) = value, validOpaqueID(string, prefix: prefix) else { throw ContractValidationError.valueMismatch(path) }
    return string
}

private func validOpaqueID(_ string: String, prefix: String) -> Bool {
    guard string.hasPrefix(prefix), string.utf8.count <= 128, string.count > prefix.count,
          string.last.map({ $0.isLetter || $0.isNumber }) == true else { return false }
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")
    return string.unicodeScalars.allSatisfy(allowed.contains)
}

private func parseTimestamp(_ value: String) -> Bool {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withDashSeparatorInDate, .withColonSeparatorInTime]
    if formatter.date(from: value) != nil { return true }
    formatter.formatOptions.insert(.withFractionalSeconds)
    return formatter.date(from: value) != nil
}

private func validOptionalError(_ value: StrictJSONValue?) -> Bool {
    if case .null = value { return true }
    guard case .string(let error) = value, (1...500).contains(error.utf8.count),
          !error.unicodeScalars.contains(where: { $0.value == 0 || $0.value == 0x0a || $0.value == 0x0d }) else { return false }
    return true
}

private func rejectForbiddenKeys(_ value: StrictJSONValue, path: String) throws {
    guard case .object(let object) = value else { return }
    for (key, child) in object {
        if MacOSHostRuntimeV1Generated.forbiddenPayloadKeys.contains(key) { throw ContractValidationError.schemaMismatch("\(path).\(key)") }
        switch child {
        case .object: try rejectForbiddenKeys(child, path: "\(path).\(key)")
        case .array(let values): for (index, item) in values.enumerated() { try rejectForbiddenKeys(item, path: "\(path).\(key)[\(index)]") }
        default: break
        }
    }
}

private func validPortableRelativePath(_ value: String) -> Bool {
    guard !value.isEmpty, value.utf8.count <= 512, !value.hasPrefix("/"), !value.contains("\\"), !value.contains(":"),
          !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else { return false }
    return value.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
}
