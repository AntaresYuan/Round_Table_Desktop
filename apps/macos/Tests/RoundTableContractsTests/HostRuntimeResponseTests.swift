import Foundation
import Testing
@testable import RoundTableContracts

@Suite("Host Runtime response and event envelopes")
struct HostRuntimeResponseTests {
    @Test("strictly decodes a success response and canonical encodes it")
    func responseRoundTrip() throws {
        let data = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"system.status\",\"ok\":true,\"payload\":{\"product\":\"roundtable\",\"applicationVersion\":\"1.0\",\"platform\":\"darwin\",\"architecture\":\"arm64\",\"capabilities\":[],\"runtimeAvailability\":{\"state\":\"ready\",\"reason\":\"ready\",\"admission\":\"open\",\"supportedStateVersion\":1}},\"error\":null}".utf8)
        let decoded = try HostRuntimeResponseEnvelope.decodeStrict(data)
        #expect(decoded.ok)
        #expect(decoded.error == nil)
        #expect(String(decoding: decoded.encodedData(), as: UTF8.self).contains("\"requestId\":\"request_1\""))
    }

    @Test("nested workspace and execution payloads decode into closed DTOs")
    func nestedDTOsDecode() throws {
        let workspace = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"workspace.list\",\"ok\":true,\"payload\":{\"workspace\":{\"id\":\"workspace_1\",\"name\":\"Repo\"},\"relativePath\":\"\",\"entries\":[],\"truncated\":false},\"error\":null}".utf8)
        let decoded = try HostRuntimeResponseEnvelope.decodeStrict(workspace).decodePayload(WorkspaceEntriesDTO.self)
        #expect(decoded.workspace.id == "workspace_1")
        let invalid = Data(String(decoding: workspace, as: UTF8.self).replacingOccurrences(of: "\"entries\":[]", with: "\"entries\":[{\"name\":\"App.swift\",\"relativePath\":\"Other.swift\",\"kind\":\"file\"}]").utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.entries[].relativePath")) {
            try HostRuntimeResponseEnvelope.decodeStrict(invalid).decodePayload(WorkspaceEntriesDTO.self)
        }
    }

    @Test("failure responses require an error and empty payload")
    func failureIsBounded() {
        let valid = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"execution.get\",\"ok\":false,\"payload\":{},\"error\":\"not_found\"}".utf8)
        #expect(throws: Never.self) { try HostRuntimeResponseEnvelope.decodeStrict(valid) }
        let invalid = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"execution.get\",\"ok\":false,\"payload\":{\"executionId\":\"execution_1\"},\"error\":\"not_found\"}".utf8)
        #expect(throws: ContractValidationError.schemaMismatch("$.payload")) { try HostRuntimeResponseEnvelope.decodeStrict(invalid) }
    }

    @Test("events enforce session, sequence, event name and payload keys")
    func eventValidation() throws {
        let data = Data("{\"protocolVersion\":1,\"sessionNonce\":\"session_1\",\"event\":\"execution.event\",\"sequence\":1,\"payload\":{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"type\":\"state\",\"sequence\":1,\"occurredAt\":\"2026-09-16T00:00:00Z\",\"state\":\"running\",\"error\":null,\"treeTermination\":\"not-required\"}}".utf8)
        let event = try HostRuntimeEventEnvelope.decodeStrict(data)
        #expect(event.sequence == 1)
        #expect(throws: ContractValidationError.valueMismatch("$.sequence")) {
            try HostRuntimeEventEnvelope.decodeStrict(Data(data.replacingOccurrences(of: "\"sequence\":1", with: "\"sequence\":0").utf8))
        }
        let artifact = Data("{\"protocolVersion\":1,\"sessionNonce\":\"session_1\",\"event\":\"execution.event\",\"sequence\":1,\"payload\":{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"type\":\"artifact\",\"sequence\":1,\"occurredAt\":\"2026-09-16T00:00:00Z\",\"artifact\":{\"relativePath\":\"x\",\"change\":\"deleted\",\"size\":1,\"sha256\":null,\"scanStatus\":\"scanned\",\"provenance\":\"runtime-workspace-scan\"}}}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.artifact.sha256")) { try HostRuntimeEventEnvelope.decodeStrict(artifact) }
    }

    @Test("size, identifier, timestamp and error limits fail closed")
    func boundedInputs() {
        let oversized = Data(repeating: 0x20, count: MacOSHostRuntimeV1Generated.maxResponseBytes + 1)
        #expect(throws: ContractValidationError.valueMismatch("$")) { try HostRuntimeResponseEnvelope.decodeStrict(oversized) }
        #expect(throws: ContractValidationError.valueMismatch("$.requestId")) {
            try HostRuntimeResponseEnvelope.decodeStrict(Data("{\"protocolVersion\":1,\"requestId\":\"request_\",\"operation\":\"system.status\",\"ok\":false,\"payload\":{},\"error\":\"bad_code\"}".utf8))
        }
        #expect(throws: ContractValidationError.valueMismatch("$.error")) {
            try HostRuntimeResponseEnvelope.decodeStrict(Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"system.status\",\"ok\":false,\"payload\":{},\"error\":\"Bad Code\"}".utf8))
        }
        let longError = String(repeating: "a", count: 81)
        #expect(throws: ContractValidationError.valueMismatch("$.error")) {
            try HostRuntimeResponseEnvelope.decodeStrict(Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"system.status\",\"ok\":false,\"payload\":{},\"error\":\"\(longError)\"}".utf8))
        }
        let badTimestamp = Data("{\"protocolVersion\":1,\"sessionNonce\":\"session_1\",\"event\":\"execution.event\",\"sequence\":1,\"payload\":{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"type\":\"state\",\"sequence\":1,\"occurredAt\":\"yesterday\",\"state\":\"running\",\"error\":null,\"treeTermination\":\"not-required\"}}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload")) { try HostRuntimeEventEnvelope.decodeStrict(badTimestamp) }
    }

    @Test("runtime catalog rejects duplicate providers and policy bounds")
    func catalogNegativeCases() {
        let base = "{\"provider\":\"codex\",\"label\":\"Codex\",\"available\":true,\"version\":null,\"installHint\":\"install\",\"policy\":{\"adapterVersion\":\"v1\",\"sandbox\":\"workspace-os-sandbox\",\"workspaceWrite\":true,\"externalFileAccess\":\"os-denied\",\"projectCustomizations\":\"disabled\",\"network\":\"provider-required\",\"secrets\":\"provider-scoped\",\"timeoutMs\":1000},\"warnings\":[]}";
        let duplicate = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"runtime.catalog\",\"ok\":true,\"payload\":{\"providers\":[\(base),\(base),\(base)]},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.providers[].provider")) { try HostRuntimeResponseEnvelope.decodeStrict(duplicate).decodePayload(RuntimeCatalogDTO.self) }
        let base2 = base.replacingOccurrences(of: "codex", with: "claude-code").replacingOccurrences(of: "1000", with: "999")
        let base3 = base.replacingOccurrences(of: "codex", with: "opencode")
        let badPolicy = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"runtime.catalog\",\"ok\":true,\"payload\":{\"providers\":[\(base),\(base2),\(base3)]},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.providers[].policy")) { try HostRuntimeResponseEnvelope.decodeStrict(badPolicy).decodePayload(RuntimeCatalogDTO.self) }
    }

    @Test("event artifact and execution invariants reject unsafe shapes")
    func executionNegativeCases() {
        let event = Data("{\"protocolVersion\":1,\"sessionNonce\":\"session_1\",\"event\":\"execution.event\",\"sequence\":1,\"payload\":{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"type\":\"artifact\",\"sequence\":1,\"occurredAt\":\"2026-09-16T00:00:00Z\",\"artifact\":{\"relativePath\":\"x\",\"change\":\"deleted\",\"size\":1,\"sha256\":null,\"scanStatus\":\"scanned\",\"provenance\":\"runtime-workspace-scan\"}}}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.artifact.sha256")) { try HostRuntimeEventEnvelope.decodeStrict(event) }
        let hash = String(repeating: "a", count: 64)
        let review = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"review.inspect\",\"ok\":true,\"payload\":{\"version\":1,\"bundleId\":\"review_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"executionId\":\"execution_1\",\"workspaceId\":\"workspace_1\",\"workspace\":{\"root\":\"/tmp\",\"device\":\"1\",\"inode\":\"1\"},\"staging\":{\"root\":\"/tmp\",\"device\":\"1\",\"inode\":\"2\"},\"protectedDirectoryNames\":[],\"protectedPaths\":[],\"baselineHash\":\"\(hash)\",\"resultHash\":\"\(hash)\",\"changes\":[{\"relativePath\":\"x\",\"change\":\"created\",\"before\":{\"kind\":\"file\",\"mode\":1,\"size\":1,\"sha256\":\"\(hash)\"},\"after\":null}],\"contentHash\":\"\(hash)\"},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.changes[]")) { try HostRuntimeResponseEnvelope.decodeStrict(review).decodePayload(ReviewBundleDTO.self) }
    }

    @Test("shared TS payload corpus decodes through Swift strict envelopes")
    func sharedPayloadCorpus() throws {
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: repo.appendingPathComponent("packages/protocol/tests/fixtures/macos-host-runtime-v1-payloads.json"))
        var parser = try StrictJSONParser(data: data)
        guard case .object(let fixtures) = try parser.parse() else { throw ContractValidationError.schemaMismatch("$") }
        for operation in ["system.status", "workspace.list", "runtime.catalog", "mission.prepare", "review.prepare", "execution.get", "review.inspect"] {
            let payload = fixtures[operation]!.encodedData()
            let envelope = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"\(operation)\",\"ok\":true,\"payload\":\(String(decoding: payload, as: UTF8.self)),\"error\":null}".utf8)
            let response = try HostRuntimeResponseEnvelope.decodeStrict(envelope)
            switch operation {
            case "system.status": _ = try response.decodePayload(HostRuntimeSystemStatusDTO.self)
            case "workspace.list": _ = try response.decodePayload(WorkspaceEntriesDTO.self)
            case "runtime.catalog": _ = try response.decodePayload(RuntimeCatalogDTO.self)
            case "mission.prepare": _ = try response.decodePayload(MissionApprovalPreviewDTO.self)
            case "execution.get": _ = try response.decodePayload(ExecutionSnapshotDTO.self)
            case "review.inspect": _ = try response.decodePayload(ReviewBundleDTO.self)
            default: _ = try response.decodePayload(ApplyChallengeDTO.self)
            }
        }
        let eventPayload = fixtures["execution.event"]!.encodedData()
        let event = Data("{\"protocolVersion\":1,\"sessionNonce\":\"session_1\",\"event\":\"execution.event\",\"sequence\":1,\"payload\":\(String(decoding: eventPayload, as: UTF8.self))}".utf8)
        _ = try HostRuntimeEventEnvelope.decodeStrict(event)
        for key in ["execution.event.output", "execution.event.artifact"] {
            let payload = fixtures[key]!.encodedData()
            let sequence = key.hasSuffix("output") ? 2 : 3
            let data = Data("{\"protocolVersion\":1,\"sessionNonce\":\"session_1\",\"event\":\"execution.event\",\"sequence\":\(sequence),\"payload\":\(String(decoding: payload, as: UTF8.self))}".utf8)
            _ = try HostRuntimeEventEnvelope.decodeStrict(data)
        }
    }

    @Test("every frozen operation has a valid operation-bound response payload")
    func operationCoverageIsStrict() throws {
        let hashA = String(repeating: "a", count: 64)
        let hashB = String(repeating: "b", count: 64)
        let catalogEntry = "{\"provider\":\"codex\",\"label\":\"Codex\",\"available\":true,\"version\":null,\"installHint\":\"Install\",\"policy\":{\"adapterVersion\":\"v1\",\"sandbox\":\"workspace-os-sandbox\",\"workspaceWrite\":true,\"externalFileAccess\":\"os-denied\",\"projectCustomizations\":\"disabled\",\"network\":\"provider-required\",\"secrets\":\"provider-scoped\",\"timeoutMs\":1000},\"warnings\":[]}"
        let snapshot = "{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"workspace\":{\"id\":\"workspace_1\",\"name\":\"Repo\"},\"provider\":\"codex\",\"state\":\"running\",\"sequence\":1,\"startedAt\":\"2026-09-17T00:00:00Z\",\"finishedAt\":null,\"error\":null,\"summary\":\"\",\"treeTermination\":\"not-required\",\"logs\":[],\"artifacts\":[]}"
        let review = "{\"version\":1,\"bundleId\":\"review_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"executionId\":\"execution_1\",\"workspaceId\":\"workspace_1\",\"workspace\":{\"root\":\"/tmp/repo\",\"device\":\"1\",\"inode\":\"1\"},\"staging\":{\"root\":\"/tmp/staging\",\"device\":\"1\",\"inode\":\"2\"},\"protectedDirectoryNames\":[],\"protectedPaths\":[],\"baselineHash\":\"\(hashA)\",\"resultHash\":\"\(hashB)\",\"changes\":[],\"contentHash\":\"\(hashB)\"}"
        let payloads: [String: String] = [
            "system.status": "{\"product\":\"roundtable\",\"applicationVersion\":\"1.0\",\"platform\":\"darwin\",\"architecture\":\"arm64\",\"capabilities\":[],\"runtimeAvailability\":{\"state\":\"ready\",\"reason\":\"ready\",\"admission\":\"open\",\"supportedStateVersion\":1}}",
            "workspace.register": "{\"workspace\":{\"id\":\"workspace_1\",\"name\":\"Repo\"}}",
            "workspace.list": "{\"workspace\":{\"id\":\"workspace_1\",\"name\":\"Repo\"},\"relativePath\":\"\",\"entries\":[],\"truncated\":false}",
            "runtime.catalog": "{\"providers\":[\(catalogEntry),\(catalogEntry.replacingOccurrences(of: "codex", with: "claude-code")),\(catalogEntry.replacingOccurrences(of: "codex", with: "opencode"))]}",
            "mission.prepare": "{\"approvalId\":\"approval_1\",\"missionId\":\"mission_1\",\"workspace\":{\"id\":\"workspace_1\",\"name\":\"Repo\"},\"provider\":\"codex\",\"prompt\":\"Fix\",\"policy\":{\"adapterVersion\":\"v1\",\"sandbox\":\"workspace-os-sandbox\",\"workspaceWrite\":true,\"externalFileAccess\":\"os-denied\",\"projectCustomizations\":\"disabled\",\"network\":\"provider-required\",\"secrets\":\"provider-scoped\",\"timeoutMs\":1000},\"warnings\":[],\"expiresAt\":\"2026-09-17T00:00:00Z\"}",
            "mission.approve": "{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"state\":\"queued\"}",
            "execution.get": snapshot,
            "execution.stop": snapshot,
            "review.begin": "{\"started\":true}",
            "review.inspect": review,
            "review.prepare": "{\"applyId\":\"apply_1\",\"bundleId\":\"review_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"executionId\":\"execution_1\",\"workspaceId\":\"workspace_1\",\"baselineHash\":\"\(hashA)\",\"contentHash\":\"\(hashB)\",\"expiresAt\":\"2026-09-17T00:00:00Z\"}",
            "apply.authorize": "{\"applied\":true}",
            "apply.reject": "{\"rejected\":true}",
        ]
        #expect(Set(payloads.keys) == Set(MacOSHostRuntimeV1Generated.operations))
        for operation in MacOSHostRuntimeV1Generated.operations {
            #expect(MacOSHostRuntimeV1Generated.responsePayloadKeySets[operation] != nil)
            let success = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"\(operation)\",\"ok\":true,\"payload\":\(payloads[operation]!),\"error\":null}".utf8)
            _ = try HostRuntimeResponseEnvelope.decodeStrict(success)
            let failure = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"\(operation)\",\"ok\":false,\"payload\":{},\"error\":\"internal_failure\"}".utf8)
            let decoded = try HostRuntimeResponseEnvelope.decodeStrict(failure)
            #expect(decoded.ok == false)
        }
    }

    @Test("simple response operations validate their nested schema during strict decode")
    func simpleOperationPayloadsFailClosed() {
        let cases: [(String, String, ContractValidationError)] = [
            ("workspace.register", "{\"workspace\":{\"id\":\"wrong_1\",\"name\":\"Repo\"}}", .valueMismatch("$.payload.workspace.id")),
            ("mission.approve", "{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"state\":\"unknown\"}", .valueMismatch("$.payload.state")),
            ("review.begin", "{\"started\":\"yes\"}", .valueMismatch("$.payload.started")),
            ("apply.authorize", "{\"applied\":1}", .valueMismatch("$.payload.applied")),
            ("apply.reject", "{\"rejected\":null}", .valueMismatch("$.payload.rejected")),
        ]
        for (operation, payload, expected) in cases {
            let data = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"\(operation)\",\"ok\":true,\"payload\":\(payload),\"error\":null}".utf8)
            #expect(throws: expected) { try HostRuntimeResponseEnvelope.decodeStrict(data) }
        }
    }

    @Test("system status requires a canonical runtime availability tuple")
    func runtimeAvailabilityFailsClosed() {
        let prefix = "{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"system.status\",\"ok\":true,\"payload\":{\"product\":\"roundtable\",\"applicationVersion\":\"1\",\"platform\":\"darwin\",\"architecture\":\"arm64\",\"capabilities\":[],\"runtimeAvailability\":"
        let suffix = "},\"error\":null}"
        for tuple in MacOSHostRuntimeV1Generated.runtimeAvailabilityTupleKeys {
            let fields = tuple.split(separator: "|", omittingEmptySubsequences: false)
            #expect(fields.count == 3)
            let availability = "{\"state\":\"\(fields[0])\",\"reason\":\"\(fields[1])\",\"admission\":\"\(fields[2])\",\"supportedStateVersion\":1}"
            #expect(throws: Never.self) {
                try HostRuntimeResponseEnvelope.decodeStrict(Data("\(prefix)\(availability)\(suffix)".utf8))
            }
        }
        let invalid = [
            "{\"state\":\"ready\",\"reason\":\"broker_unavailable\",\"admission\":\"open\",\"supportedStateVersion\":1}",
            "{\"state\":\"quarantined\",\"reason\":\"state_quarantined\",\"admission\":\"open\",\"supportedStateVersion\":1}",
            "{\"state\":\"ready\",\"reason\":\"ready\",\"admission\":\"open\",\"supportedStateVersion\":2}",
        ]
        for availability in invalid {
            #expect(throws: ContractValidationError.valueMismatch("$.payload.runtimeAvailability")) {
                try HostRuntimeResponseEnvelope.decodeStrict(Data("\(prefix)\(availability)\(suffix)".utf8))
            }
        }
    }

    @Test("catalog, mission, workspace, review and execution nested bounds are strict")
    func nestedValidatorNegativeCases() {
        let policy = "\"policy\":{\"adapterVersion\":\"Bad Version\",\"sandbox\":\"workspace-os-sandbox\",\"workspaceWrite\":true,\"externalFileAccess\":\"os-denied\",\"projectCustomizations\":\"disabled\",\"network\":\"provider-required\",\"secrets\":\"provider-scoped\",\"timeoutMs\":1000}"
        let provider = "{\"provider\":\"codex\",\"label\":\"Codex\",\"available\":true,\"version\":null,\"installHint\":\"Install\",\(policy),\"warnings\":[]}"
        let provider2 = provider.replacingOccurrences(of: "codex", with: "claude-code").replacingOccurrences(of: "Bad Version", with: "v1")
        let provider3 = provider.replacingOccurrences(of: "codex", with: "opencode").replacingOccurrences(of: "Bad Version", with: "v1")
        let catalog = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"runtime.catalog\",\"ok\":true,\"payload\":{\"providers\":[\(provider),\(provider2),\(provider3)]},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.providers[].policy")) { try HostRuntimeResponseEnvelope.decodeStrict(catalog) }

        let goodPolicy = policy.replacingOccurrences(of: "Bad Version", with: "v1")
        let mission = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"mission.prepare\",\"ok\":true,\"payload\":{\"approvalId\":\"approval_1\",\"missionId\":\"mission_1\",\"workspace\":{\"name\":\"Repo\"},\"provider\":\"codex\",\"prompt\":\"Fix\",\(goodPolicy),\"warnings\":[],\"expiresAt\":\"2026-09-17T00:00:00Z\"},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.schemaMismatch("$.payload.workspace")) { try HostRuntimeResponseEnvelope.decodeStrict(mission) }

        let workspace = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"workspace.list\",\"ok\":true,\"payload\":{\"workspace\":{\"id\":\"workspace_1\",\"name\":\"Repo\"},\"relativePath\":\"\",\"entries\":[{\"name\":\"bad:name\",\"relativePath\":\"bad:name\",\"kind\":\"file\"}],\"truncated\":false},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.entries[].name")) { try HostRuntimeResponseEnvelope.decodeStrict(workspace) }

        let escapingListing = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"workspace.list\",\"ok\":true,\"payload\":{\"workspace\":{\"id\":\"workspace_1\",\"name\":\"Repo\"},\"relativePath\":\"../outside\",\"entries\":[],\"truncated\":false},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.relativePath")) { try HostRuntimeResponseEnvelope.decodeStrict(escapingListing) }

        let hash = String(repeating: "a", count: 64)
        let review = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"review.inspect\",\"ok\":true,\"payload\":{\"version\":1,\"bundleId\":\"review_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"executionId\":\"execution_1\",\"workspaceId\":\"workspace_1\",\"workspace\":{\"root\":\"/tmp\",\"device\":\"1\",\"inode\":\"1\"},\"staging\":{\"root\":\"/tmp\",\"device\":\"1\",\"inode\":\"2\"},\"protectedDirectoryNames\":[\"../escape\"],\"protectedPaths\":[],\"baselineHash\":\"\(hash)\",\"resultHash\":\"\(hash)\",\"changes\":[],\"contentHash\":\"\(hash)\"},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.protectedDirectoryNames[]")) { try HostRuntimeResponseEnvelope.decodeStrict(review) }

        let controlPathReview = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"review.inspect\",\"ok\":true,\"payload\":{\"version\":1,\"bundleId\":\"review_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"executionId\":\"execution_1\",\"workspaceId\":\"workspace_1\",\"workspace\":{\"root\":\"/tmp\",\"device\":\"1\",\"inode\":\"1\"},\"staging\":{\"root\":\"/tmp\",\"device\":\"1\",\"inode\":\"2\"},\"protectedDirectoryNames\":[],\"protectedPaths\":[\"bad\\u0001path\"],\"baselineHash\":\"\(hash)\",\"resultHash\":\"\(hash)\",\"changes\":[],\"contentHash\":\"\(hash)\"},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.protectedPaths[]")) { try HostRuntimeResponseEnvelope.decodeStrict(controlPathReview) }

        let snapshot = "{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"workspace\":{\"id\":\"workspace_1\",\"name\":\"Repo\"},\"provider\":\"codex\",\"state\":\"running\",\"sequence\":1,\"startedAt\":\"yesterday\",\"finishedAt\":null,\"error\":null,\"summary\":\"\",\"treeTermination\":\"not-required\",\"logs\":[],\"artifacts\":[]}"
        let execution = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"execution.get\",\"ok\":true,\"payload\":\(snapshot),\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.startedAt")) { try HostRuntimeResponseEnvelope.decodeStrict(execution) }
        let validTimestampSnapshot = snapshot.replacingOccurrences(of: "yesterday", with: "2026-09-17T00:00:00Z")
        let newlineErrorSnapshot = validTimestampSnapshot.replacingOccurrences(of: "\"error\":null", with: "\"error\":\"bad\\nerror\"")
        let badError = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"execution.get\",\"ok\":true,\"payload\":\(newlineErrorSnapshot),\"error\":null}".utf8)
        #expect(throws: ContractValidationError.valueMismatch("$.payload.error")) { try HostRuntimeResponseEnvelope.decodeStrict(badError) }
    }

    @Test("request response and event reject unsupported protocol versions")
    func protocolVersionMismatchFailsClosed() {
        for version in [0, 2] {
            let request = Data("{\"protocolVersion\":\(version),\"requestId\":\"request_1\",\"sessionNonce\":\"session_1\",\"operation\":\"system.status\",\"payload\":{}}".utf8)
            #expect(throws: ContractValidationError.valueMismatch("$.protocolVersion")) { try HostRuntimeRequestEnvelope.decodeStrict(request) }
            let response = Data("{\"protocolVersion\":\(version),\"requestId\":\"request_1\",\"operation\":\"system.status\",\"ok\":false,\"payload\":{},\"error\":\"internal_failure\"}".utf8)
            #expect(throws: ContractValidationError.valueMismatch("$.protocolVersion")) { try HostRuntimeResponseEnvelope.decodeStrict(response) }
            let event = Data("{\"protocolVersion\":\(version),\"sessionNonce\":\"session_1\",\"event\":\"execution.event\",\"sequence\":1,\"payload\":{}}".utf8)
            #expect(throws: ContractValidationError.valueMismatch("$.protocolVersion")) { try HostRuntimeEventEnvelope.decodeStrict(event) }
        }
    }

    @Test("forbidden payload keys are rejected recursively")
    func forbiddenPayloadKeysFailClosed() {
        let response = Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"operation\":\"system.status\",\"ok\":true,\"payload\":{\"product\":\"roundtable\",\"applicationVersion\":\"1\",\"platform\":\"darwin\",\"architecture\":\"arm64\",\"capabilities\":[],\"runtimeAvailability\":{\"state\":\"ready\",\"reason\":\"ready\",\"admission\":\"open\",\"supportedStateVersion\":1,\"credential\":\"x\"}},\"error\":null}".utf8)
        #expect(throws: ContractValidationError.schemaMismatch("$.payload.runtimeAvailability")) { try HostRuntimeResponseEnvelope.decodeStrict(response) }
        let event = Data("{\"protocolVersion\":1,\"sessionNonce\":\"session_1\",\"event\":\"execution.event\",\"sequence\":1,\"payload\":{\"missionId\":\"mission_1\",\"executionId\":\"execution_1\",\"type\":\"state\",\"sequence\":1,\"occurredAt\":\"2026-09-17T00:00:00Z\",\"state\":\"running\",\"error\":null,\"treeTermination\":\"not-required\",\"credential\":null}}".utf8)
        #expect(throws: ContractValidationError.schemaMismatch("$.payload")) { try HostRuntimeEventEnvelope.decodeStrict(event) }
    }
}

private extension Data {
    func replacingOccurrences(of old: String, with new: String) -> String {
        String(decoding: self, as: UTF8.self).replacingOccurrences(of: old, with: new)
    }
}
