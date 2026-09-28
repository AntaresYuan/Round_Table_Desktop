import Foundation
import Testing
@testable import RoundTableContracts

@Suite("Host Runtime request envelope")
struct HostRuntimeRequestTests {
    @Test("all fixed request operations decode")
    func allOperationsDecode() throws {
        let payloads: [String: String] = [
            "system.status": "{}",
            "workspace.register": "{\"bookmarkTransferId\":\"bookmark_1\",\"displayName\":\"Repo\"}",
            "workspace.list": "{\"workspaceId\":\"workspace_1\",\"relativePath\":\"Sources/App\"}",
            "runtime.catalog": "{}",
            "mission.prepare": "{\"workspaceId\":\"workspace_1\",\"provider\":\"codex\",\"prompt\":\"Fix it\"}",
            "mission.approve": "{\"approvalId\":\"approval_1\"}",
            "execution.get": "{\"executionId\":\"execution_1\"}",
            "execution.stop": "{\"executionId\":\"execution_1\"}",
            "review.begin": "{\"executionId\":\"execution_1\",\"workspaceId\":\"workspace_1\"}",
            "review.inspect": "{\"executionId\":\"execution_1\",\"workspaceId\":\"workspace_1\"}",
            "review.prepare": "{\"bundleId\":\"review_1\"}",
            "apply.authorize": "{\"applyId\":\"apply_1\"}",
            "apply.reject": "{\"applyId\":\"apply_1\"}",
        ]
        #expect(Set(payloads.keys) == Set(MacOSHostRuntimeV1Generated.operations))
        for operation in MacOSHostRuntimeV1Generated.operations {
            let decoded = try HostRuntimeRequestEnvelope.decodeStrict(
                envelope(operation: operation, payload: payloads[operation]!)
            )
            #expect(decoded.operation.rawValue == operation)
        }
    }

    @Test("unknown envelope and payload fields fail closed")
    func unknownFieldsRejected() {
        #expect(throws: ContractValidationError.schemaMismatch("$")) {
            try HostRuntimeRequestEnvelope.decodeStrict(Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"sessionNonce\":\"session_1\",\"operation\":\"system.status\",\"payload\":{},\"extra\":true}".utf8))
        }
        #expect(throws: ContractValidationError.schemaMismatch("$.payload")) {
            try HostRuntimeRequestEnvelope.decodeStrict(
                envelope(operation: "execution.stop", payload: "{\"executionId\":\"execution_1\",\"signalTarget\":1}")
            )
        }
    }

    @Test("forbidden credential and command fields cannot extend valid request payloads")
    func forbiddenRequestPayloadKeysFailClosed() {
        #expect(throws: ContractValidationError.schemaMismatch("$.payload")) {
            try HostRuntimeRequestEnvelope.decodeStrict(
                envelope(operation: "mission.prepare", payload: "{\"workspaceId\":\"workspace_1\",\"provider\":\"codex\",\"prompt\":\"Fix it\",\"credential\":\"secret\"}")
            )
        }
        #expect(throws: ContractValidationError.schemaMismatch("$.payload")) {
            try HostRuntimeRequestEnvelope.decodeStrict(
                envelope(operation: "execution.stop", payload: "{\"executionId\":\"execution_1\",\"rootCommand\":\"sh\"}")
            )
        }
    }

    @Test("canonical request key sets never contain a forbidden key")
    func requestContractExcludesForbiddenKeys() {
        let forbidden = Set(MacOSHostRuntimeV1Generated.forbiddenPayloadKeys)
        #expect(Set(MacOSHostRuntimeV1Generated.commonRequestKeys) == Set([
            "protocolVersion", "requestId", "sessionNonce", "operation", "payload",
        ]))
        #expect(Set(HostRuntimeProvider.allCases.map(\.rawValue)) == Set(MacOSHostRuntimeV1Generated.providers))
        #expect(Set(MacOSHostRuntimeV1Generated.requestPayloadKeySets.keys) == Set(MacOSHostRuntimeV1Generated.operations))
        for (operation, keys) in MacOSHostRuntimeV1Generated.requestPayloadKeySets {
            #expect(Set(keys).isDisjoint(with: forbidden), "\(operation) contains a forbidden payload key")
        }
    }

    @Test("path traversal and wrong ID domains fail closed")
    func capabilitiesRemainBound() {
        #expect(throws: ContractValidationError.valueMismatch("$.payload.relativePath")) {
            try HostRuntimeRequestEnvelope.decodeStrict(
                envelope(operation: "workspace.list", payload: "{\"workspaceId\":\"workspace_1\",\"relativePath\":\"../secret\"}")
            )
        }
        #expect(throws: ContractValidationError.valueMismatch("$.payload.executionId")) {
            try HostRuntimeRequestEnvelope.decodeStrict(
                envelope(operation: "execution.stop", payload: "{\"executionId\":\"workspace_1\"}")
            )
        }
    }

    @Test("duplicate fields fail closed")
    func duplicateFieldsRejected() {
        #expect(throws: ContractValidationError.duplicateKey("executionId")) {
            try HostRuntimeRequestEnvelope.decodeStrict(
                envelope(operation: "execution.stop", payload: "{\"executionId\":\"execution_1\",\"executionId\":\"execution_2\"}")
            )
        }
    }

    private func envelope(operation: String, payload: String) -> Data {
        Data("{\"protocolVersion\":1,\"requestId\":\"request_1\",\"sessionNonce\":\"session_1\",\"operation\":\"\(operation)\",\"payload\":\(payload)}".utf8)
    }
}
