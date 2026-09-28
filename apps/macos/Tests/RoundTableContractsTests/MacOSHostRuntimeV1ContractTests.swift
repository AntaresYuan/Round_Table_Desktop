import Foundation
import Testing
@testable import RoundTableContracts

@Suite("macOS App to Host Runtime v1 canonical contract")
struct MacOSHostRuntimeV1ContractTests {
    @Test("disk corpus matches generated Swift mirror")
    func canonicalCorpusMatchesGeneratedMirror() throws {
        let bytes = try Data(contentsOf: contractURL)
        try CanonicalContractVerifier.verify(
            data: bytes,
            expectedSHA256: MacOSHostRuntimeV1Generated.corpusSHA256
        )
        #expect(String(decoding: bytes, as: UTF8.self) == MacOSHostRuntimeV1Generated.canonicalJSON)
        #expect(MacOSHostRuntimeV1Generated.contract == "macos-host-runtime-v1")
        #expect(MacOSHostRuntimeV1Generated.transport == "authenticated-xpc")
    }

    @Test("contract has no generic privileged operation")
    func genericPrivilegedOperationsAreAbsent() {
        #expect(!MacOSHostRuntimeV1Generated.operations.contains("shell.execute"))
        #expect(!MacOSHostRuntimeV1Generated.operations.contains("filesystem.write"))
        #expect(!MacOSHostRuntimeV1Generated.operations.contains("broker.request"))
        #expect(MacOSHostRuntimeV1Generated.forbiddenPayloadKeys.contains("credential"))
        #expect(MacOSHostRuntimeV1Generated.forbiddenPayloadKeys.contains("rootCommand"))
    }

    @Test("modified bytes cannot claim the canonical contract")
    func modifiedBytesRejected() throws {
        let modified = try Data(contentsOf: contractURL) + Data("\n".utf8)
        #expect(throws: ContractValidationError.digestMismatch) {
            try CanonicalContractVerifier.verify(
                data: modified,
                expectedSHA256: MacOSHostRuntimeV1Generated.corpusSHA256
            )
        }
    }

    private var contractURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/protocol/contracts/macos-host-runtime-v1/contract.json")
    }
}
