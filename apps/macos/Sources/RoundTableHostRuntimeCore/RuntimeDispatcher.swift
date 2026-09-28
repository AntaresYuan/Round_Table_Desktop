import Foundation
#if SWIFT_PACKAGE
import RoundTableContracts
#endif

public struct RuntimeSystemConfiguration: Equatable, Sendable {
    public var applicationVersion: String
    public var availabilityState: String
    public var availabilityReason: String

    public init(applicationVersion: String = "0.1.0",
                availabilityState: String = "ready", availabilityReason: String = "ready") {
        self.applicationVersion = applicationVersion
        self.availabilityState = availabilityState
        self.availabilityReason = availabilityReason
    }
}

public struct WorkspaceBookmarkAttachment: Equatable, Sendable {
    public let transferId: String
    public let data: Data
    public init(transferId: String, data: Data) {
        self.transferId = transferId
        self.data = data
    }
}

/// Exhaustive v1 dispatcher. Only status and the closed provider catalogue are
/// enabled in this S3 slice. Every other canonical operation reaches a stable
/// unavailable response until its authority is wired; no generic fallback can
/// invoke a command, file operation or broker selector.
public actor RuntimeDispatcher {
    private let sessions: RuntimeSessionRegistry
    private let admission: RuntimeAdmission
    private let workspaces: WorkspaceGrantRegistry
    private let providers: ProviderRegistry
    private let system: RuntimeSystemConfiguration

    public init(sessions: RuntimeSessionRegistry, admission: RuntimeAdmission,
                workspaces: WorkspaceGrantRegistry = WorkspaceGrantRegistry(),
                providers: ProviderRegistry = ProviderRegistry(),
                system: RuntimeSystemConfiguration = .init()) {
        self.sessions = sessions
        self.admission = admission
        self.workspaces = workspaces
        self.providers = providers
        self.system = system
    }

    public func dispatch(_ data: Data, on connection: RuntimeConnection,
                         attachment: WorkspaceBookmarkAttachment? = nil,
                         at now: Date = Date()) async throws -> Data {
        let request = try HostRuntimeRequestEnvelope.decodeStrict(data)
        let owner = try await sessions.admit(request, on: connection, at: now)
        if attachment != nil, request.operation != .workspaceRegister {
            return try HostRuntimeResponseCodec.failure(
                requestID: request.requestID, operation: request.operation,
                error: "request_attachment_invalid")
        }
        switch request.operation {
        case .systemStatus:
            let admissionStatus = await admission.admissionStatus().rawValue
            return try HostRuntimeResponseCodec.success(
                requestID: request.requestID, operation: request.operation,
                payload: SystemStatusPayload(
                    product: "roundtable", applicationVersion: system.applicationVersion,
                    platform: "darwin", architecture: Self.architecture,
                    capabilities: ["runtime.catalog", "runtime.status", "workspace.list", "workspace.register"],
                    runtimeAvailability: .init(
                        state: system.availabilityState, reason: system.availabilityReason,
                        admission: system.availabilityState == "ready" ? admissionStatus : "closed",
                        supportedStateVersion: MacOSHostRuntimeV1Generated.hostRuntimeStateSchemaVersion)))
        case .runtimeCatalog:
            let catalog = await providers.refresh()
            return try HostRuntimeResponseCodec.success(
                requestID: request.requestID, operation: request.operation,
                payload: RuntimeCatalogPayload(providers: catalog.map {
                    ProviderPayload(provider: $0.provider.rawValue, label: $0.label,
                                    available: $0.available, version: $0.version,
                                    installHint: $0.installHint,
                                    policy: .init(
                                        adapterVersion: $0.adapterVersion,
                                        sandbox: "workspace-os-sandbox", workspaceWrite: true,
                                        externalFileAccess: "os-denied",
                                        projectCustomizations: "disabled",
                                        network: "provider-required", secrets: "provider-scoped",
                                        timeoutMs: 1_000), warnings: $0.warnings)
                }))
        case .workspaceRegister:
            guard system.availabilityState == "ready",
                  case .workspaceRegister(let transferId, let displayName) = request.payload,
                  let attachment, attachment.transferId == transferId else {
                return try HostRuntimeResponseCodec.failure(
                    requestID: request.requestID, operation: request.operation,
                    error: "workspace_transfer_invalid")
            }
            do {
                let grant = try await workspaces.registerBookmark(
                    transferId: transferId, data: attachment.data,
                    displayName: displayName, owner: owner)
                return try HostRuntimeResponseCodec.success(
                    requestID: request.requestID, operation: request.operation,
                    payload: WorkspaceRegisterPayload(
                        workspace: .init(id: grant.workspaceId, name: grant.displayName)))
            } catch let error as WorkspaceGrantError {
                return try HostRuntimeResponseCodec.failure(
                    requestID: request.requestID, operation: request.operation,
                    error: error.rawValue)
            }
        case .workspaceList:
            guard case .workspaceList(let workspaceId, let relativePath) = request.payload else {
                return try HostRuntimeResponseCodec.failure(
                    requestID: request.requestID, operation: request.operation,
                    error: "workspace_relative_path_invalid")
            }
            do {
                let listing = try await workspaces.list(
                    workspaceId, relativePath: relativePath, owner: owner)
                return try HostRuntimeResponseCodec.success(
                    requestID: request.requestID, operation: request.operation,
                    payload: WorkspaceListPayload(
                        workspace: .init(id: listing.grant.workspaceId,
                                         name: listing.grant.displayName),
                        relativePath: listing.relativePath,
                        entries: listing.entries.map {
                            .init(name: $0.name, relativePath: $0.relativePath, kind: $0.kind)
                        }, truncated: listing.truncated))
            } catch let error as WorkspaceGrantError {
                return try HostRuntimeResponseCodec.failure(
                    requestID: request.requestID, operation: request.operation,
                    error: error.rawValue)
            }
        case .missionPrepare:
            guard system.availabilityState == "ready",
                  case .missionPrepare(let workspaceId, let providerValue, let prompt) = request.payload,
                  let provider = RuntimeProvider(rawValue: providerValue.rawValue) else {
                return try failure(request, "runtime_unavailable")
            }
            do {
                let workspace = try await workspaces.resolve(workspaceId, owner: owner)
                _ = await providers.refresh()
                _ = try await providers.requireUnchanged(provider)
                let approval = try await admission.prepare(
                    .init(workspaceId: workspaceId, provider: provider, prompt: prompt),
                    owner: owner, at: now)
                return try HostRuntimeResponseCodec.success(
                    requestID: request.requestID, operation: request.operation,
                    payload: MissionPreparePayload(
                        approvalId: approval.approvalId.rawValue,
                        missionId: approval.missionId.rawValue,
                        workspace: .init(id: workspace.workspaceId, name: workspace.displayName),
                        provider: provider.rawValue, prompt: approval.prompt,
                        policy: .provider(provider), warnings: [],
                        expiresAt: Self.timestamp(approval.expiresAt)))
            } catch { return try failure(request, Self.stableError(error)) }
        case .missionApprove:
            guard case .approval(let approvalId) = request.payload else {
                return try failure(request, "mission_approval_invalid")
            }
            do {
                let pending = try await admission.pendingApproval(
                    ApprovalID(rawValue: approvalId), owner: owner, at: now)
                _ = try await workspaces.resolve(pending.workspaceId, owner: owner)
                _ = try await providers.requireUnchanged(pending.provider)
                let execution = try await admission.approve(
                    ApprovalID(rawValue: approvalId), owner: owner, at: now)
                return try HostRuntimeResponseCodec.success(
                    requestID: request.requestID, operation: request.operation,
                    payload: MissionApprovePayload(
                        missionId: execution.missionId.rawValue,
                        executionId: execution.executionId.rawValue,
                        state: execution.state.rawValue))
            } catch { return try failure(request, Self.stableError(error)) }
        case .executionGet, .executionStop:
            guard case .execution(let executionId) = request.payload else {
                return try failure(request, "execution_not_found")
            }
            do {
                let id = ExecutionID(rawValue: executionId)
                let snapshot = request.operation == .executionStop
                    ? try await admission.requestStop(id, owner: owner, at: now)
                    : try await admission.snapshot(id, owner: owner)
                let workspace = try await workspaces.resolve(snapshot.workspaceId, owner: owner)
                return try HostRuntimeResponseCodec.success(
                    requestID: request.requestID, operation: request.operation,
                    payload: ExecutionPayload(snapshot: snapshot, workspace: workspace))
            } catch { return try failure(request, Self.stableError(error)) }
        case .reviewBegin, .reviewInspect, .reviewPrepare, .applyAuthorize, .applyReject:
            return try HostRuntimeResponseCodec.failure(
                requestID: request.requestID, operation: request.operation,
                error: "operation_unavailable")
        }
    }

    private func failure(_ request: HostRuntimeRequestEnvelope, _ error: String) throws -> Data {
        try HostRuntimeResponseCodec.failure(requestID: request.requestID,
                                             operation: request.operation, error: error)
    }

    private static func stableError(_ error: Error) -> String {
        if let error = error as? WorkspaceGrantError { return error.rawValue }
        if let error = error as? ProviderRegistryError { return error.rawValue }
        if let error = error as? RuntimeAdmissionError { return error.rawValue }
        return "internal_failure"
    }

    fileprivate static func timestamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static var architecture: String {
        #if arch(arm64)
        "arm64"
        #elseif arch(x86_64)
        "x64"
        #else
        "x64"
        #endif
    }

}

private struct RuntimeAvailabilityPayload: Encodable {
    let state: String
    let reason: String
    let admission: String
    let supportedStateVersion: Int
}

private struct SystemStatusPayload: Encodable {
    let product: String
    let applicationVersion: String
    let platform: String
    let architecture: String
    let capabilities: [String]
    let runtimeAvailability: RuntimeAvailabilityPayload
}

private struct RuntimePolicyPayload: Encodable {
    let adapterVersion: String
    let sandbox: String
    let workspaceWrite: Bool
    let externalFileAccess: String
    let projectCustomizations: String
    let network: String
    let secrets: String
    let timeoutMs: Int

}

private extension RuntimePolicyPayload {
    static func provider(_ provider: RuntimeProvider) -> Self {
        .init(adapterVersion: "\(provider.rawValue)-v1", sandbox: "workspace-os-sandbox",
              workspaceWrite: true, externalFileAccess: "os-denied",
              projectCustomizations: "disabled", network: "provider-required",
              secrets: "provider-scoped", timeoutMs: 1_000)
    }
}

private struct ProviderPayload: Encodable {
    let provider: String
    let label: String
    let available: Bool
    let version: String?
    let installHint: String
    let policy: RuntimePolicyPayload
    let warnings: [String]

    private enum CodingKeys: String, CodingKey {
        case provider, label, available, version, installHint, policy, warnings
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(provider, forKey: .provider)
        try container.encode(label, forKey: .label)
        try container.encode(available, forKey: .available)
        if let version { try container.encode(version, forKey: .version) }
        else { try container.encodeNil(forKey: .version) }
        try container.encode(installHint, forKey: .installHint)
        try container.encode(policy, forKey: .policy)
        try container.encode(warnings, forKey: .warnings)
    }
}

private struct RuntimeCatalogPayload: Encodable {
    let providers: [ProviderPayload]
}

private struct WorkspaceSummaryPayload: Encodable {
    let id: String
    let name: String
}

private struct WorkspaceRegisterPayload: Encodable {
    let workspace: WorkspaceSummaryPayload
}

private struct WorkspaceEntryPayload: Encodable {
    let name: String
    let relativePath: String
    let kind: String
}

private struct WorkspaceListPayload: Encodable {
    let workspace: WorkspaceSummaryPayload
    let relativePath: String
    let entries: [WorkspaceEntryPayload]
    let truncated: Bool
}

private struct MissionPreparePayload: Encodable {
    let approvalId: String
    let missionId: String
    let workspace: WorkspaceSummaryPayload
    let provider: String
    let prompt: String
    let policy: RuntimePolicyPayload
    let warnings: [String]
    let expiresAt: String
}

private struct MissionApprovePayload: Encodable {
    let missionId: String
    let executionId: String
    let state: String
}

private struct RuntimeLogPayload: Encodable {
    let sequence: Int
    let occurredAt: String
    let stream: String
    let text: String
}

private struct ExecutionPayload: Encodable {
    let missionId: String
    let executionId: String
    let workspace: WorkspaceSummaryPayload
    let provider: String
    let state: String
    let sequence: Int
    let startedAt: String?
    let finishedAt: String?
    let error: String?
    let summary: String
    let treeTermination: String
    let logs: [RuntimeLogPayload]
    let artifacts: [String]

    init(snapshot: RuntimeExecutionSnapshot, workspace: WorkspaceGrant) {
        missionId = snapshot.missionId.rawValue
        executionId = snapshot.executionId.rawValue
        self.workspace = .init(id: workspace.workspaceId, name: workspace.displayName)
        provider = snapshot.provider.rawValue
        state = snapshot.state.rawValue
        sequence = snapshot.sequence
        startedAt = snapshot.startedAt.map(RuntimeDispatcher.timestamp)
        finishedAt = snapshot.finishedAt.map(RuntimeDispatcher.timestamp)
        error = snapshot.error
        summary = ""
        treeTermination = snapshot.treeTermination.rawValue
        logs = snapshot.logs.map {
            .init(sequence: $0.sequence, occurredAt: RuntimeDispatcher.timestamp($0.occurredAt),
                  stream: $0.stream.rawValue, text: $0.text)
        }
        artifacts = []
    }

    private enum CodingKeys: String, CodingKey {
        case missionId, executionId, workspace, provider, state, sequence
        case startedAt, finishedAt, error, summary, treeTermination, logs, artifacts
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(missionId, forKey: .missionId); try c.encode(executionId, forKey: .executionId)
        try c.encode(workspace, forKey: .workspace); try c.encode(provider, forKey: .provider)
        try c.encode(state, forKey: .state); try c.encode(sequence, forKey: .sequence)
        if let startedAt { try c.encode(startedAt, forKey: .startedAt) } else { try c.encodeNil(forKey: .startedAt) }
        if let finishedAt { try c.encode(finishedAt, forKey: .finishedAt) } else { try c.encodeNil(forKey: .finishedAt) }
        if let error { try c.encode(error, forKey: .error) } else { try c.encodeNil(forKey: .error) }
        try c.encode(summary, forKey: .summary); try c.encode(treeTermination, forKey: .treeTermination)
        try c.encode(logs, forKey: .logs); try c.encode(artifacts, forKey: .artifacts)
    }
}
