import Foundation
import Testing
@testable import RoundTableContracts

@Suite("macOS service UID v1 canonical contract")
struct MacOSServiceUIDV1ContractTests {
    @Test("disk corpus matches the generated Swift mirror")
    func canonicalCorpusMatchesGeneratedMirror() throws {
        let bytes = try Data(contentsOf: contractURL)
        let contract = try MacOSServiceUIDV1Contract.verifyCanonicalBytes(bytes)

        #expect(contract.contract == "macos-service-uid-v1")
        #expect(contract.version == 1)
        #expect(contract.maxConcurrency == 1)
        #expect(contract.requests == ["prepare", "start", "stop", "status", "cleanup"])
        #expect(String(decoding: bytes, as: UTF8.self) == MacOSServiceUIDV1Generated.canonicalJSON)
    }

    @Test("unknown top-level keys fail closed")
    func unknownTopLevelKeyRejected() throws {
        let source = try canonicalText.replacingOccurrences(
            of: "\"contract\": \"macos-service-uid-v1\"",
            with: "\"contract\": \"macos-service-uid-v1\", \"unexpected\": true"
        )
        #expect(throws: ContractValidationError.schemaMismatch("$")) {
            try MacOSServiceUIDV1Contract.decodeStrict(Data(source.utf8))
        }
    }

    @Test("duplicate keys fail closed")
    func duplicateKeyRejected() throws {
        let source = try canonicalText.replacingOccurrences(
            of: "\"contract\": \"macos-service-uid-v1\"",
            with: "\"contract\": \"macos-service-uid-v1\", \"contract\": \"forged\""
        )
        #expect(throws: ContractValidationError.duplicateKey("contract")) {
            try MacOSServiceUIDV1Contract.decodeStrict(Data(source.utf8))
        }
    }

    @Test("unknown nested keys fail closed")
    func unknownNestedKeyRejected() throws {
        let source = try canonicalText.replacingOccurrences(
            of: "\"fdKey\": \"secretChannelFd\"",
            with: "\"fdKey\": \"secretChannelFd\", \"unexpected\": 1"
        )
        #expect(throws: ContractValidationError.schemaMismatch("$.transportRules")) {
            try MacOSServiceUIDV1Contract.decodeStrict(Data(source.utf8))
        }
    }

    @Test("known fields cannot change value")
    func knownValueMismatchRejected() throws {
        let source = try canonicalText.replacingOccurrences(
            of: "\"maxConcurrency\": 1",
            with: "\"maxConcurrency\": 2"
        )
        #expect(throws: ContractValidationError.valueMismatch("$.maxConcurrency")) {
            try MacOSServiceUIDV1Contract.decodeStrict(Data(source.utf8))
        }
    }

    @Test("canonical verification binds exact bytes")
    func exactBytesAreDigestBound() throws {
        let source = try canonicalText + "\n"
        #expect(throws: ContractValidationError.digestMismatch) {
            try MacOSServiceUIDV1Contract.verifyCanonicalBytes(Data(source.utf8))
        }
    }

    private var canonicalText: String {
        get throws {
            try String(contentsOf: contractURL, encoding: .utf8)
        }
    }

    private var contractURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/runtime/contracts/macos-service-uid-v1/contract.json")
    }
}
