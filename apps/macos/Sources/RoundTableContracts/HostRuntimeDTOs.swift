import Foundation

struct WorkspaceSummaryDTO: Codable, Equatable { let id: String; let name: String }
struct RuntimeAvailabilityDTO: Codable, Equatable {
    let state: String; let reason: String; let admission: String; let supportedStateVersion: Int
}
struct HostRuntimeSystemStatusDTO: Codable, Equatable {
    let product: String; let applicationVersion: String; let platform: String
    let architecture: String; let capabilities: [String]; let runtimeAvailability: RuntimeAvailabilityDTO
}
struct WorkspaceEntryDTO: Codable, Equatable { let name: String; let relativePath: String; let kind: String }
struct WorkspaceEntriesDTO: Codable, Equatable { let workspace: WorkspaceSummaryDTO; let relativePath: String; let entries: [WorkspaceEntryDTO]; let truncated: Bool }
struct RuntimePolicyDTO: Codable, Equatable {
    let adapterVersion: String; let sandbox: String; let workspaceWrite: Bool
    let externalFileAccess: String; let projectCustomizations: String; let network: String
    let secrets: String; let timeoutMs: Int
}
struct RuntimeCatalogEntryDTO: Codable, Equatable {
    let provider: String; let label: String; let available: Bool; let version: String?
    let installHint: String; let policy: RuntimePolicyDTO; let warnings: [String]
}
struct RuntimeCatalogDTO: Codable, Equatable { let providers: [RuntimeCatalogEntryDTO] }
struct MissionApprovalPreviewDTO: Codable, Equatable {
    let approvalId: String; let missionId: String; let workspace: WorkspaceSummaryDTO
    let provider: String; let prompt: String; let policy: RuntimePolicyDTO
    let warnings: [String]; let expiresAt: String
}
struct RuntimeLogEntryDTO: Codable, Equatable { let sequence: Int; let occurredAt: String; let stream: String; let text: String }
struct RuntimeArtifactDTO: Codable, Equatable {
    let relativePath: String; let change: String; let size: Int; let sha256: String?
    let scanStatus: String; let provenance: String
}
struct ExecutionSnapshotDTO: Codable, Equatable {
    let missionId: String; let executionId: String; let workspace: WorkspaceSummaryDTO
    let provider: String; let state: String; let sequence: Int; let startedAt: String?
    let finishedAt: String?; let error: String?; let summary: String
    let treeTermination: String; let logs: [RuntimeLogEntryDTO]; let artifacts: [RuntimeArtifactDTO]
}
struct WorkspaceIdentityDTO: Codable, Equatable { let root: String; let device: String; let inode: String }
struct ReviewEntryDTO: Codable, Equatable { let kind: String; let mode: Int; let size: Int?; let sha256: String? }
struct ReviewChangeDTO: Codable, Equatable {
    let relativePath: String; let change: String; let before: ReviewEntryDTO?; let after: ReviewEntryDTO?
}
struct ReviewBundleDTO: Codable, Equatable {
    let version: Int; let bundleId: String; let executionId: String; let workspaceId: String
    let workspace: WorkspaceIdentityDTO; let staging: WorkspaceIdentityDTO
    let protectedDirectoryNames: [String]; let protectedPaths: [String]
    let baselineHash: String; let resultHash: String; let changes: [ReviewChangeDTO]; let contentHash: String
}
struct ApplyChallengeDTO: Codable, Equatable {
    let applyId: String; let bundleId: String; let executionId: String; let workspaceId: String
    let baselineHash: String; let contentHash: String; let expiresAt: String
}

extension HostRuntimeResponseEnvelope {
    func decodePayload<T: Decodable>(_ type: T.Type) throws -> T {
        try validateOperationPayload(operation, payload)
        try validateNestedPayload(payload)
        return try JSONDecoder().decode(T.self, from: payload.encodedData())
    }
}

func validateOperationPayload(_ operation: HostRuntimeOperation, _ value: StrictJSONValue) throws {
    guard case .object(let root) = value else { throw ContractValidationError.schemaMismatch("$.payload") }
    switch operation {
    case .systemStatus:
        guard case .string("roundtable") = root["product"] else { throw ContractValidationError.valueMismatch("$.payload.product") }
        try requireString(root["applicationVersion"], "$.payload.applicationVersion", 1, 80)
        guard case .string(let platform) = root["platform"], ["darwin", "linux", "win32"].contains(platform),
              case .string(let architecture) = root["architecture"], ["arm64", "ia32", "x64"].contains(architecture),
              case .array(let capabilities) = root["capabilities"], capabilities.count <= 100 else {
            throw ContractValidationError.valueMismatch("$.payload")
        }
        for capability in capabilities {
            guard case .string(let name) = capability,
                  name.range(of: "^[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)+$", options: .regularExpression) != nil,
                  name.utf8.count <= 128 else { throw ContractValidationError.valueMismatch("$.payload.capabilities") }
        }
        try validateRuntimeAvailability(root["runtimeAvailability"])
    case .workspaceRegister:
        let workspace = try exact(root["workspace"], ["id", "name"], "$.payload.workspace")
        try requireID(workspace["id"], "workspace_", "$.payload.workspace.id")
        try requireString(workspace["name"], "$.payload.workspace.name", 1, 255)
    case .missionApprove:
        try requireID(root["missionId"], "mission_", "$.payload.missionId")
        try requireID(root["executionId"], "execution_", "$.payload.executionId")
        guard case .string(let state) = root["state"], MacOSHostRuntimeV1Generated.executionStates.contains(state) else { throw ContractValidationError.valueMismatch("$.payload.state") }
    case .reviewBegin:
        guard case .boolean = root["started"] else { throw ContractValidationError.valueMismatch("$.payload.started") }
    case .applyAuthorize:
        guard case .boolean = root["applied"] else { throw ContractValidationError.valueMismatch("$.payload.applied") }
    case .applyReject:
        guard case .boolean = root["rejected"] else { throw ContractValidationError.valueMismatch("$.payload.rejected") }
    case .runtimeCatalog:
        guard case .array(let providers) = root["providers"], providers.count == 3 else { throw ContractValidationError.valueMismatch("$.payload.providers") }
        var seen = Set<String>()
        for provider in providers {
            let entry = try exact(provider, ["provider", "label", "available", "version", "installHint", "policy", "warnings"], "$.payload.providers[]")
            guard case .string(let name) = entry["provider"], ["codex", "claude-code", "opencode"].contains(name), seen.insert(name).inserted else { throw ContractValidationError.valueMismatch("$.payload.providers[].provider") }
            try requireString(entry["label"], "$.payload.providers[].label", 1, 80)
            if case .null = entry["version"] { } else { try requireString(entry["version"], "$.payload.providers[].version", 1, 160) }
            try requireString(entry["installHint"], "$.payload.providers[].installHint", 1, 500)
            guard case .array(let warnings) = entry["warnings"], warnings.count <= 10 else { throw ContractValidationError.valueMismatch("$.payload.providers[].warnings") }
            for warning in warnings { try requireString(warning, "$.payload.providers[].warnings[]", 1, 500) }
            let policy = try exact(entry["policy"], ["adapterVersion", "sandbox", "workspaceWrite", "externalFileAccess", "projectCustomizations", "network", "secrets", "timeoutMs"], "$.payload.providers[].policy")
            try validatePolicy(.object(policy), path: "$.payload.providers[].policy")
        }
    case .missionPrepare:
        let mission = try exact(.object(root), ["approvalId", "missionId", "workspace", "provider", "prompt", "policy", "warnings", "expiresAt"], "$.payload")
        try requireID(mission["approvalId"], "approval_", "$.payload.approvalId")
        try requireID(mission["missionId"], "mission_", "$.payload.missionId")
        let workspace = try exact(mission["workspace"], ["id", "name"], "$.payload.workspace")
        try requireID(workspace["id"], "workspace_", "$.payload.workspace.id")
        try requireString(workspace["name"], "$.payload.workspace.name", 1, 255)
        guard case .string(let provider) = mission["provider"], ["codex", "claude-code", "opencode"].contains(provider) else { throw ContractValidationError.valueMismatch("$.payload.provider") }
        try requireString(mission["prompt"], "$.payload.prompt", 1, 12_000)
        try validatePolicy(mission["policy"], path: "$.payload.policy")
        guard case .array(let warnings) = mission["warnings"], warnings.count <= 10 else { throw ContractValidationError.valueMismatch("$.payload.warnings") }
        for warning in warnings { try requireString(warning, "$.payload.warnings[]", 1, 500) }
        guard case .string(let expiresAt) = mission["expiresAt"], parseTimestamp(expiresAt) else { throw ContractValidationError.valueMismatch("$.payload.expiresAt") }
    case .workspaceList:
        let workspace = try exact(root["workspace"], ["id", "name"], "$.payload.workspace")
        try requireID(workspace["id"], "workspace_", "$.payload.workspace.id")
        try requireString(workspace["name"], "$.payload.workspace.name", 1, 255)
        try requirePath(root["relativePath"], "$.payload.relativePath", allowEmpty: true)
        let listingPath: String
        if case .string(let path) = root["relativePath"] { listingPath = path } else { throw ContractValidationError.schemaMismatch("$.payload.relativePath") }
        guard case .array(let entries) = root["entries"], entries.count <= 500 else { throw ContractValidationError.valueMismatch("$.payload.entries") }
        for entry in entries {
            let item = try object(entry, "$.payload.entries[]")
            _ = try exact(.object(item), ["name", "relativePath", "kind"], "$.payload.entries[]")
            try requireString(item["name"], "$.payload.entries[].name", 1, 255)
            try validatePortableComponent(item["name"], path: "$.payload.entries[].name")
            try requireString(item["relativePath"], "$.payload.entries[].relativePath", 1, 512)
            guard case .string(let name) = item["name"], case .string(let relativePath) = item["relativePath"],
                  relativePath == (listingPath.isEmpty ? name : "\(listingPath)/\(name)"),
                  relativePath.split(separator: "/").last.map(String.init) == name else { throw ContractValidationError.valueMismatch("$.payload.entries[].relativePath") }
            guard case .string(let kind) = item["kind"], ["directory", "file", "symlink", "other"].contains(kind) else { throw ContractValidationError.valueMismatch("$.payload.entries[].kind") }
        }
    case .executionGet, .executionStop:
        let keys = ["missionId", "executionId", "workspace", "provider", "state", "sequence", "startedAt", "finishedAt", "error", "summary", "treeTermination", "logs", "artifacts"]
        let snapshot = try exact(.object(root), keys, "$.payload")
        try requireID(snapshot["missionId"], "mission_", "$.payload.missionId")
        try requireID(snapshot["executionId"], "execution_", "$.payload.executionId")
        guard case .string(let provider) = snapshot["provider"], MacOSHostRuntimeV1Generated.providers.contains(provider), case .string(let state) = snapshot["state"], MacOSHostRuntimeV1Generated.executionStates.contains(state), case .number(let sequence) = snapshot["sequence"], Int(sequence) != nil else { throw ContractValidationError.valueMismatch("$.payload") }
        guard case .string(let termination) = snapshot["treeTermination"], MacOSHostRuntimeV1Generated.treeTerminationStates.contains(termination),
              case .number(let snapshotSequenceToken) = snapshot["sequence"], let snapshotSequence = Int(snapshotSequenceToken), snapshotSequence >= 0 else { throw ContractValidationError.valueMismatch("$.payload.treeTermination") }
        if state == "stopping" && termination != "pending" { throw ContractValidationError.valueMismatch("$.payload.treeTermination") }
        if state == "stopped" && termination != "confirmed" && termination != "failed" { throw ContractValidationError.valueMismatch("$.payload.treeTermination") }
        let workspace = try exact(snapshot["workspace"], ["id", "name"], "$.payload.workspace"); try requireID(workspace["id"], "workspace_", "$.payload.workspace.id"); try requireString(workspace["name"], "$.payload.workspace.name", 1, 255)
        try validateNullableTimestamp(snapshot["startedAt"], path: "$.payload.startedAt")
        try validateNullableTimestamp(snapshot["finishedAt"], path: "$.payload.finishedAt")
        try validateOptionalExecutionError(snapshot["error"])
        try requireString(snapshot["summary"], "$.payload.summary", 0, 16_000)
        guard case .array(let logs) = snapshot["logs"], logs.count <= 256, case .array(let artifacts) = snapshot["artifacts"], artifacts.count <= 200 else { throw ContractValidationError.valueMismatch("$.payload") }
        var previous = 0
        for log in logs { let item = try exact(log, ["sequence", "occurredAt", "stream", "text"], "$.payload.logs[]"); guard case .number(let token) = item["sequence"], let logSequence = Int(token), logSequence > previous, logSequence <= snapshotSequence, case .string(let stream) = item["stream"], ["status", "stdout", "stderr"].contains(stream) else { throw ContractValidationError.valueMismatch("$.payload.logs[]") }; guard case .string(let logTimestamp) = item["occurredAt"], parseTimestamp(logTimestamp) else { throw ContractValidationError.valueMismatch("$.payload.logs[].occurredAt") }; guard case .string(let text) = item["text"], (1...8_192).contains(text.utf8.count), !text.unicodeScalars.contains(where: { $0.value == 0 }) else { throw ContractValidationError.valueMismatch("$.payload.logs[].text") }; previous = logSequence }
        for artifact in artifacts { let item = try exact(artifact, ["relativePath", "change", "size", "sha256", "scanStatus", "provenance"], "$.payload.artifacts[]"); try requirePath(item["relativePath"], "$.payload.artifacts[].relativePath", allowEmpty: false); guard case .string(let change) = item["change"], ["created", "modified", "deleted"].contains(change), case .number(let sizeToken) = item["size"], let size = Int(sizeToken), (0...1_000_000_000).contains(size), case .string("scanned") = item["scanStatus"], case .string("runtime-workspace-scan") = item["provenance"] else { throw ContractValidationError.valueMismatch("$.payload.artifacts[]") }; if change == "deleted" { guard size == 0, case .null = item["sha256"] else { throw ContractValidationError.valueMismatch("$.payload.artifacts[].sha256") } } else { try requireHash(item["sha256"], "$.payload.artifacts[].sha256") } }
        let terminal = ["succeeded", "failed", "stopped", "timed_out"].contains(state); if terminal { guard snapshot["finishedAt"] != .null else { throw ContractValidationError.valueMismatch("$.payload.finishedAt") } } else { guard case .null = snapshot["finishedAt"] else { throw ContractValidationError.valueMismatch("$.payload.finishedAt") } }
    case .reviewInspect:
        let bundle = try exact(.object(root), ["version", "bundleId", "executionId", "workspaceId", "workspace", "staging", "protectedDirectoryNames", "protectedPaths", "baselineHash", "resultHash", "changes", "contentHash"], "$.payload")
        guard case .number(let version) = bundle["version"], version == "1" else { throw ContractValidationError.valueMismatch("$.payload.version") }
        guard case .string(let bundleID) = bundle["bundleId"], bundleID.range(of: "^review_[a-f0-9]{32}$", options: .regularExpression) != nil else { throw ContractValidationError.valueMismatch("$.payload.bundleId") }
        try requireID(bundle["executionId"], "execution_", "$.payload.executionId"); try requireID(bundle["workspaceId"], "workspace_", "$.payload.workspaceId")
        try validateIdentity(bundle["workspace"], "$.payload.workspace"); try validateIdentity(bundle["staging"], "$.payload.staging")
        try requireHash(bundle["baselineHash"], "$.payload.baselineHash"); try requireHash(bundle["resultHash"], "$.payload.resultHash"); try requireHash(bundle["contentHash"], "$.payload.contentHash")
        guard case .array(let names) = bundle["protectedDirectoryNames"], names.count <= 32, case .array(let paths) = bundle["protectedPaths"], paths.count <= 512, case .array(let changes) = bundle["changes"], changes.count <= 5_000 else { throw ContractValidationError.valueMismatch("$.payload") }
        for name in names { try requireString(name, "$.payload.protectedDirectoryNames[]", 1, 255); try validatePortableComponent(name, path: "$.payload.protectedDirectoryNames[]") }
        for path in paths { try requirePath(path, "$.payload.protectedPaths[]", allowEmpty: true) }
        for change in changes { try validateChange(change) }
    case .reviewPrepare:
        let challenge = try exact(.object(root), ["applyId", "bundleId", "executionId", "workspaceId", "baselineHash", "contentHash", "expiresAt"], "$.payload")
        try requireID(challenge["applyId"], "apply_", "$.payload.applyId"); guard case .string(let challengeBundleID) = challenge["bundleId"], challengeBundleID.range(of: "^review_[a-f0-9]{32}$", options: .regularExpression) != nil else { throw ContractValidationError.valueMismatch("$.payload.bundleId") }; try requireID(challenge["executionId"], "execution_", "$.payload.executionId"); try requireID(challenge["workspaceId"], "workspace_", "$.payload.workspaceId")
        try requireHash(challenge["baselineHash"], "$.payload.baselineHash"); try requireHash(challenge["contentHash"], "$.payload.contentHash")
        guard case .string(let expiresAt) = challenge["expiresAt"], parseTimestamp(expiresAt) else { throw ContractValidationError.valueMismatch("$.payload.expiresAt") }
    }
}

private func object(_ value: StrictJSONValue?, _ path: String) throws -> [String: StrictJSONValue] { guard case .object(let object) = value else { throw ContractValidationError.schemaMismatch(path) }; return object }
private func exact(_ value: StrictJSONValue?, _ keys: [String], _ path: String) throws -> [String: StrictJSONValue] { let object = try object(value, path); guard Set(object.keys) == Set(keys) else { throw ContractValidationError.schemaMismatch(path) }; return object }
private func requireID(_ value: StrictJSONValue?, _ prefix: String, _ path: String) throws { guard case .string(let string) = value, validID(string, prefix) else { throw ContractValidationError.valueMismatch(path) } }
private func validID(_ string: String, _ prefix: String) -> Bool { string.hasPrefix(prefix) && string.count > prefix.count && string.utf8.count <= 128 && string.last.map({ $0.isLetter || $0.isNumber }) == true && string.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-").contains($0) }) }
private func requireString(_ value: StrictJSONValue?, _ path: String, _ minimum: Int, _ maximum: Int) throws { guard case .string(let string) = value, (minimum...maximum).contains(string.utf8.count), !string.unicodeScalars.contains(where: { $0.value == 0 }) else { throw ContractValidationError.valueMismatch(path) } }
private func validatePortableComponent(_ value: StrictJSONValue?, path: String) throws {
    guard case .string(let string) = value,
          string != ".", string != "..",
          !string.contains("/"), !string.contains("\\"), !string.contains(":"),
          !string.unicodeScalars.contains(where: { $0.value <= 0x1f || $0.value == 0x7f }) else {
        throw ContractValidationError.valueMismatch(path)
    }
}
private func validatePolicy(_ value: StrictJSONValue?, path: String) throws {
    let policy = try exact(value, ["adapterVersion", "sandbox", "workspaceWrite", "externalFileAccess", "projectCustomizations", "network", "secrets", "timeoutMs"], path)
    guard case .string(let version) = policy["adapterVersion"], version.range(of: "^[a-z0-9][a-z0-9.-]{0,39}$", options: .regularExpression) != nil,
          case .string(let sandbox) = policy["sandbox"], ["workspace-os-sandbox", "provider-permissions"].contains(sandbox),
          case .boolean(true) = policy["workspaceWrite"],
          case .string(let external) = policy["externalFileAccess"], ["os-denied", "provider-denied", "not-guaranteed"].contains(external),
          case .string(let customizations) = policy["projectCustomizations"], ["enabled", "disabled"].contains(customizations),
          case .string(let network) = policy["network"], ["provider-required", "provider-and-tools"].contains(network),
          case .string("provider-scoped") = policy["secrets"],
          case .number(let timeoutToken) = policy["timeoutMs"], let timeout = Int(timeoutToken), (1_000...7_200_000).contains(timeout) else {
        throw ContractValidationError.valueMismatch(path)
    }
}
private func validateRuntimeAvailability(_ value: StrictJSONValue?) throws {
    let availability = try exact(value, ["state", "reason", "admission", "supportedStateVersion"], "$.payload.runtimeAvailability")
    guard case .string(let state) = availability["state"], MacOSHostRuntimeV1Generated.runtimeAvailabilityStates.contains(state),
          case .string(let reason) = availability["reason"], MacOSHostRuntimeV1Generated.runtimeAvailabilityReasons.contains(reason),
          case .string(let admission) = availability["admission"], MacOSHostRuntimeV1Generated.runtimeAdmissionStates.contains(admission),
          case .number(let versionToken) = availability["supportedStateVersion"],
          Int(versionToken) == MacOSHostRuntimeV1Generated.hostRuntimeStateSchemaVersion else {
        throw ContractValidationError.valueMismatch("$.payload.runtimeAvailability")
    }
    let tupleKey = "\(state)|\(reason)|\(admission)"
    guard MacOSHostRuntimeV1Generated.runtimeAvailabilityTupleKeys.contains(tupleKey) else {
        throw ContractValidationError.valueMismatch("$.payload.runtimeAvailability")
    }
}
private func validateNullableTimestamp(_ value: StrictJSONValue?, path: String) throws {
    if case .null = value { return }
    guard case .string(let timestamp) = value, parseTimestamp(timestamp) else { throw ContractValidationError.valueMismatch(path) }
}
private func validateOptionalExecutionError(_ value: StrictJSONValue?) throws {
    if case .null = value { return }
    guard case .string(let message) = value, (1...500).contains(message.utf8.count),
          !message.unicodeScalars.contains(where: { [0, 10, 13].contains($0.value) }) else {
        throw ContractValidationError.valueMismatch("$.payload.error")
    }
}
private func requireHash(_ value: StrictJSONValue?, _ path: String) throws { guard case .string(let hash) = value, hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ContractValidationError.valueMismatch(path) } }
private func requirePath(_ value: StrictJSONValue?, _ path: String, allowEmpty: Bool) throws { guard case .string(let string) = value, string.utf8.count <= 512, (allowEmpty || !string.isEmpty), !string.hasPrefix("/"), !string.contains("\\"), !string.contains(":"), !string.unicodeScalars.contains(where: { $0.value <= 0x1f || $0.value == 0x7f }), (string.isEmpty && allowEmpty || !string.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." })) else { throw ContractValidationError.valueMismatch(path) } }
private func validateIdentity(_ value: StrictJSONValue?, _ path: String) throws { let identity = try exact(value, ["root", "device", "inode"], path); try requireString(identity["root"], "\(path).root", 1, 4096); guard case .string(let device) = identity["device"], device.range(of: "^[0-9]+$", options: .regularExpression) != nil, case .string(let inode) = identity["inode"], inode.range(of: "^[0-9]+$", options: .regularExpression) != nil else { throw ContractValidationError.valueMismatch(path) } }
private func validateChange(_ value: StrictJSONValue) throws { let change = try exact(.object(try object(value, "$.payload.changes[]")), ["relativePath", "change", "before", "after"], "$.payload.changes[]"); try requirePath(change["relativePath"], "$.payload.changes[].relativePath", allowEmpty: false); guard case .string(let kind) = change["change"], ["created", "modified", "deleted"].contains(kind) else { throw ContractValidationError.valueMismatch("$.payload.changes[].change") }; let beforeNull = { if case .null = change["before"] { return true }; return false }(); let afterNull = { if case .null = change["after"] { return true }; return false }(); if kind == "created" && (!beforeNull || afterNull) || kind == "deleted" && (beforeNull || !afterNull) || kind == "modified" && (beforeNull || afterNull) { throw ContractValidationError.valueMismatch("$.payload.changes[]") }; if !beforeNull { try validateReviewEntry(change["before"]) }; if !afterNull { try validateReviewEntry(change["after"]) } }
private func validateReviewEntry(_ value: StrictJSONValue?) throws { let entry = try object(value, "$.payload.changes[].entry"); guard case .string(let kind) = entry["kind"] else { throw ContractValidationError.valueMismatch("$.payload.changes[].entry.kind") }; if kind == "directory" { let exactEntry = try exact(.object(entry), ["kind", "mode"], "$.payload.changes[].entry"); try requireMode(exactEntry["mode"]) } else if kind == "file" { let exactEntry = try exact(.object(entry), ["kind", "mode", "size", "sha256"], "$.payload.changes[].entry"); try requireMode(exactEntry["mode"]); guard case .number(let size) = exactEntry["size"], let n = Int(size), (0...2_097_152).contains(n) else { throw ContractValidationError.valueMismatch("$.payload.changes[].entry.size") }; try requireHash(exactEntry["sha256"], "$.payload.changes[].entry.sha256") } else { throw ContractValidationError.valueMismatch("$.payload.changes[].entry.kind") } }
private func requireMode(_ value: StrictJSONValue?) throws { guard case .number(let mode) = value, let n = Int(mode), (0...0o7777).contains(n) else { throw ContractValidationError.valueMismatch("$.payload.changes[].entry.mode") } }
private func parseTimestamp(_ value: String) -> Bool { let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; if formatter.date(from: value) != nil { return true }; formatter.formatOptions.remove(.withFractionalSeconds); return formatter.date(from: value) != nil }

private func validateNestedPayload(_ value: StrictJSONValue) throws {
    guard case .object(let object) = value else { throw ContractValidationError.schemaMismatch("$.payload") }
    for (key, value) in object {
        if ["workspaceId", "missionId", "executionId", "approvalId", "applyId", "bundleId"].contains(key) {
            guard case .string(let id) = value, id.count <= 128, id.last.map({ $0.isLetter || $0.isNumber }) == true,
                  id.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-").contains($0) }) else { throw ContractValidationError.valueMismatch("$.payload.\(key)") }
        }
        if ["baselineHash", "resultHash", "contentHash", "sha256"].contains(key), case .string(let hash) = value {
            guard hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ContractValidationError.valueMismatch("$.payload.\(key)") }
        }
        if ["occurredAt", "startedAt", "finishedAt", "expiresAt"].contains(key), case .string(let timestamp) = value {
            guard ISO8601DateFormatter().date(from: timestamp) != nil else { throw ContractValidationError.valueMismatch("$.payload.\(key)") }
        }
        switch value {
        case .object: try validateNestedPayload(value)
        case .array(let values): for item in values { if case .object = item { try validateNestedPayload(item) } }
        default: break
        }
    }
}

extension HostRuntimeEventEnvelope {
    func decodePayload<T: Decodable>(_ type: T.Type) throws -> T {
        try validateNestedPayload(payload)
        return try JSONDecoder().decode(T.self, from: payload.encodedData())
    }
}
