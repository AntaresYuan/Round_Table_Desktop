import Foundation
import Testing
@testable import RoundTableContracts

@Suite("Host Runtime session handshake")
struct HostRuntimeSessionTests {
    @Test("strictly decodes canonical request and response")
    func canonicalHandshake() throws {
        let request = try HostRuntimeSessionOpenRequest.decodeStrict(Data(
            "{\"protocolVersion\":1,\"clientNonce\":\"client_0123456789abcdef0123456789abcdef\"}".utf8
        ))
        #expect(request.protocolVersion == 1)
        #expect(request.clientNonce.hasPrefix("client_"))

        let response = try HostRuntimeSessionOpenResponse.decodeStrict(Data(
            "{\"protocolVersion\":1,\"sessionNonce\":\"session_0123456789abcdef0123456789abcdef\"}".utf8
        ))
        #expect(response.protocolVersion == 1)
        #expect(response.sessionNonce.hasPrefix("session_"))

        let failure = try HostRuntimeSessionOpenFailure.decodeStrict(Data(
            "{\"error\":\"unsupported_protocol_version\"}".utf8
        ))
        #expect(failure.error == MacOSHostRuntimeV1Generated.handshakeVersionMismatchError)
    }

    @Test("rejects version mismatch, malformed nonce, and unknown keys")
    func handshakeFailsClosed() {
        #expect(throws: ContractValidationError.valueMismatch("$.protocolVersion")) {
            try HostRuntimeSessionOpenRequest.decodeStrict(Data(
                "{\"protocolVersion\":2,\"clientNonce\":\"client_0123456789abcdef0123456789abcdef\"}".utf8
            ))
        }
        #expect(throws: ContractValidationError.valueMismatch("$.clientNonce")) {
            try HostRuntimeSessionOpenRequest.decodeStrict(Data(
                "{\"protocolVersion\":1,\"clientNonce\":\"client_predictable\"}".utf8
            ))
        }
        #expect(throws: ContractValidationError.schemaMismatch("$")) {
            try HostRuntimeSessionOpenResponse.decodeStrict(Data(
                "{\"protocolVersion\":1,\"sessionNonce\":\"session_0123456789abcdef0123456789abcdef\",\"extra\":true}".utf8
            ))
        }
        #expect(throws: ContractValidationError.valueMismatch("$")) {
            try HostRuntimeSessionOpenRequest.decodeStrict(
                Data(repeating: 0x20, count: MacOSHostRuntimeV1Generated.sessionOpenMaxRequestBytes + 1)
            )
        }
        #expect(throws: ContractValidationError.valueMismatch("$")) {
            try HostRuntimeSessionOpenResponse.decodeStrict(
                Data(repeating: 0x20, count: MacOSHostRuntimeV1Generated.sessionOpenMaxResponseBytes + 1)
            )
        }
        #expect(throws: ContractValidationError.valueMismatch("$.sessionNonce")) {
            try HostRuntimeSessionOpenResponse.decodeStrict(Data(
                "{\"protocolVersion\":1,\"sessionNonce\":\"session_predictable\"}".utf8
            ))
        }
        #expect(throws: ContractValidationError.valueMismatch("$.error")) {
            try HostRuntimeSessionOpenFailure.decodeStrict(Data("{\"error\":\"unknown\"}".utf8))
        }
        #expect(throws: ContractValidationError.schemaMismatch("$")) {
            try HostRuntimeSessionOpenFailure.decodeStrict(Data(
                "{\"error\":\"invalid_handshake\",\"extra\":true}".utf8
            ))
        }
    }

    @Test("rejects duplicate handshake fields")
    func duplicateHandshakeField() {
        #expect(throws: ContractValidationError.duplicateKey("clientNonce")) {
            try HostRuntimeSessionOpenRequest.decodeStrict(Data(
                "{\"protocolVersion\":1,\"clientNonce\":\"client_0123456789abcdef0123456789abcdef\",\"clientNonce\":\"client_fedcba9876543210fedcba9876543210\"}".utf8
            ))
        }
    }

    @Test("only an otherwise strict request reports a version mismatch")
    func handshakeFailureClassification() {
        let nonce = "client_0123456789abcdef0123456789abcdef"
        #expect(HostRuntimeSessionOpenRequest.failureCode(for: Data(
            "{\"protocolVersion\":0,\"clientNonce\":\"\(nonce)\"}".utf8
        )) == MacOSHostRuntimeV1Generated.handshakeVersionMismatchError)
        #expect(HostRuntimeSessionOpenRequest.failureCode(for: Data(
            "{\"protocolVersion\":0,\"protocolVersion\":1,\"clientNonce\":\"\(nonce)\"}".utf8
        )) == MacOSHostRuntimeV1Generated.handshakeMalformedRequestError)
        #expect(HostRuntimeSessionOpenRequest.failureCode(for: Data(
            "{\"protocolVersion\":0,\"clientNonce\":\"bad\"}".utf8
        )) == MacOSHostRuntimeV1Generated.handshakeMalformedRequestError)
    }
}
