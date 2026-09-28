import Foundation

public enum HostRuntimeOperation: String, CaseIterable, Sendable {
    case systemStatus = "system.status"
    case workspaceRegister = "workspace.register"
    case workspaceList = "workspace.list"
    case runtimeCatalog = "runtime.catalog"
    case missionPrepare = "mission.prepare"
    case missionApprove = "mission.approve"
    case executionGet = "execution.get"
    case executionStop = "execution.stop"
    case reviewBegin = "review.begin"
    case reviewInspect = "review.inspect"
    case reviewPrepare = "review.prepare"
    case applyAuthorize = "apply.authorize"
    case applyReject = "apply.reject"
}

public enum HostRuntimeProvider: String, CaseIterable, Sendable {
    case codex
    case claudeCode = "claude-code"
    case opencode
}

public enum HostRuntimeRequestPayload: Equatable, Sendable {
    case empty
    case workspaceRegister(bookmarkTransferID: String, displayName: String)
    case workspaceList(workspaceID: String, relativePath: String)
    case missionPrepare(workspaceID: String, provider: HostRuntimeProvider, prompt: String)
    case approval(approvalID: String)
    case execution(executionID: String)
    case review(executionID: String, workspaceID: String)
    case reviewPrepare(bundleID: String)
    case apply(applyID: String)
}

public struct HostRuntimeRequestEnvelope: Equatable, Sendable {
    public let protocolVersion: Int
    public let requestID: String
    public let sessionNonce: String
    public let operation: HostRuntimeOperation
    public let payload: HostRuntimeRequestPayload

    public static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= MacOSHostRuntimeV1Generated.maxRequestBytes else {
            throw ContractValidationError.valueMismatch("$")
        }
        let root: StrictJSONValue
        do {
            var parser = try StrictJSONParser(data: data)
            root = try parser.parse()
        } catch StrictJSONError.duplicateKey(let key) {
            throw ContractValidationError.duplicateKey(key)
        } catch {
            throw ContractValidationError.malformedJSON
        }

        let envelope = try hostObject(
            root,
            path: "$",
            keys: Set(MacOSHostRuntimeV1Generated.commonRequestKeys)
        )
        let version = try hostInteger(envelope["protocolVersion"], path: "$.protocolVersion")
        guard version == MacOSHostRuntimeV1Generated.version else {
            throw ContractValidationError.valueMismatch("$.protocolVersion")
        }
        let requestID = try hostOpaqueID(
            envelope["requestId"],
            path: "$.requestId",
            prefix: "request_"
        )
        let sessionNonce = try hostOpaqueID(
            envelope["sessionNonce"],
            path: "$.sessionNonce",
            prefix: "session_"
        )
        let operationText = try hostString(envelope["operation"], path: "$.operation")
        guard let operation = HostRuntimeOperation(rawValue: operationText) else {
            throw ContractValidationError.valueMismatch("$.operation")
        }
        let payload = try decodePayload(envelope["payload"], operation: operation)
        return Self(
            protocolVersion: version,
            requestID: requestID,
            sessionNonce: sessionNonce,
            operation: operation,
            payload: payload
        )
    }
}

private func decodePayload(
    _ value: StrictJSONValue?,
    operation: HostRuntimeOperation
) throws -> HostRuntimeRequestPayload {
    guard let expectedKeys = MacOSHostRuntimeV1Generated.requestPayloadKeySets[operation.rawValue] else {
        throw ContractValidationError.valueMismatch("$.operation")
    }
    let object = try hostObject(value, path: "$.payload", keys: Set(expectedKeys))
    switch operation {
    case .systemStatus, .runtimeCatalog:
        return .empty
    case .workspaceRegister:
        let transferID = try hostOpaqueID(
            object["bookmarkTransferId"],
            path: "$.payload.bookmarkTransferId",
            prefix: "bookmark_"
        )
        let displayName = try hostBoundedString(
            object["displayName"],
            path: "$.payload.displayName",
            minimum: 1,
            maximum: 255
        )
        return .workspaceRegister(bookmarkTransferID: transferID, displayName: displayName)
    case .workspaceList:
        return .workspaceList(
            workspaceID: try hostOpaqueID(
                object["workspaceId"], path: "$.payload.workspaceId", prefix: "workspace_"
            ),
            relativePath: try hostRelativePath(
                object["relativePath"], path: "$.payload.relativePath"
            )
        )
    case .missionPrepare:
        let providerText = try hostString(object["provider"], path: "$.payload.provider")
        guard let provider = HostRuntimeProvider(rawValue: providerText) else {
            throw ContractValidationError.valueMismatch("$.payload.provider")
        }
        let prompt = try hostBoundedString(
            object["prompt"], path: "$.payload.prompt", minimum: 1, maximum: 12_000
        )
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ContractValidationError.valueMismatch("$.payload.prompt")
        }
        return .missionPrepare(
            workspaceID: try hostOpaqueID(
                object["workspaceId"], path: "$.payload.workspaceId", prefix: "workspace_"
            ),
            provider: provider,
            prompt: prompt
        )
    case .missionApprove:
        return .approval(approvalID: try hostOpaqueID(
            object["approvalId"], path: "$.payload.approvalId", prefix: "approval_"
        ))
    case .executionGet, .executionStop:
        return .execution(executionID: try hostOpaqueID(
            object["executionId"], path: "$.payload.executionId", prefix: "execution_"
        ))
    case .reviewBegin, .reviewInspect:
        return .review(
            executionID: try hostOpaqueID(
                object["executionId"], path: "$.payload.executionId", prefix: "execution_"
            ),
            workspaceID: try hostOpaqueID(
                object["workspaceId"], path: "$.payload.workspaceId", prefix: "workspace_"
            )
        )
    case .reviewPrepare:
        return .reviewPrepare(bundleID: try hostOpaqueID(
            object["bundleId"], path: "$.payload.bundleId", prefix: "review_"
        ))
    case .applyAuthorize, .applyReject:
        return .apply(applyID: try hostOpaqueID(
            object["applyId"], path: "$.payload.applyId", prefix: "apply_"
        ))
    }
}

private func hostObject(
    _ value: StrictJSONValue?,
    path: String,
    keys: Set<String>
) throws -> [String: StrictJSONValue] {
    guard case .object(let object) = value, Set(object.keys) == keys else {
        throw ContractValidationError.schemaMismatch(path)
    }
    return object
}

private func hostString(_ value: StrictJSONValue?, path: String) throws -> String {
    guard case .string(let string) = value else {
        throw ContractValidationError.schemaMismatch(path)
    }
    return string
}

private func hostBoundedString(
    _ value: StrictJSONValue?,
    path: String,
    minimum: Int,
    maximum: Int
) throws -> String {
    let string = try hostString(value, path: path)
    guard string.utf8.count >= minimum,
          string.utf8.count <= maximum,
          !string.utf8.contains(0),
          !string.contains("\r"),
          !string.contains("\n") || path == "$.payload.prompt"
    else {
        throw ContractValidationError.valueMismatch(path)
    }
    return string
}

private func hostInteger(_ value: StrictJSONValue?, path: String) throws -> Int {
    guard case .number(let token) = value,
          !token.contains("."), !token.contains("e"), !token.contains("E"),
          let integer = Int(token)
    else {
        throw ContractValidationError.schemaMismatch(path)
    }
    return integer
}

private func hostOpaqueID(
    _ value: StrictJSONValue?,
    path: String,
    prefix: String
) throws -> String {
    let string = try hostString(value, path: path)
    guard string.hasPrefix(prefix), string.utf8.count <= 128,
          string.count > prefix.count,
          string.last.map({ $0.isLetter || $0.isNumber }) == true else {
        throw ContractValidationError.valueMismatch(path)
    }
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-")
    guard !string.isEmpty, string.unicodeScalars.allSatisfy(allowed.contains) else {
        throw ContractValidationError.valueMismatch(path)
    }
    return string
}

private func hostRelativePath(_ value: StrictJSONValue?, path: String) throws -> String {
    let string = try hostString(value, path: path)
    guard string.utf8.count <= 512,
          !string.hasPrefix("/"),
          !string.contains("\\"),
          !string.contains(":"),
          !string.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    else {
        throw ContractValidationError.valueMismatch(path)
    }
    if string.isEmpty { return string }
    let segments = string.split(separator: "/", omittingEmptySubsequences: false)
    guard segments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
        throw ContractValidationError.valueMismatch(path)
    }
    return string
}
