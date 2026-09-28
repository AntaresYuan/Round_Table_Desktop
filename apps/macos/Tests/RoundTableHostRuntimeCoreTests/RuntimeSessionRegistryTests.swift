import Foundation
import RoundTableContracts
import Testing
@testable import RoundTableHostRuntimeCore

@Suite("Host Runtime connection sessions")
struct RuntimeSessionRegistryTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func peer(_ digest: String = "verified-development-code") throws -> VerifiedAppPeer {
        try VerifiedAppPeer(effectiveUserID: 501, auditSessionID: 100_001,
                            buildProfile: .development, codeIdentityDigest: digest)
    }

    private func handshake(_ digit: Character = "a") throws -> HostRuntimeSessionOpenRequest {
        try HostRuntimeSessionOpenRequest.decodeStrict(Data(
            #"{"protocolVersion":1,"clientNonce":"client_\#(String(repeating: String(digit), count: 32))"}"#.utf8
        ))
    }

    private func request(sessionNonce: String, id: Int) throws -> HostRuntimeRequestEnvelope {
        try HostRuntimeRequestEnvelope.decodeStrict(Data(
            #"{"protocolVersion":1,"requestId":"request_\#(id)","sessionNonce":"\#(sessionNonce)","operation":"system.status","payload":{}}"#.utf8
        ))
    }

    @Test("handshake creates a connection-generation-bound owner")
    func opensBoundSession() async throws {
        let registry = RuntimeSessionRegistry(nonceSource: {
            "session_0123456789abcdef0123456789abcdef"
        })
        let connection = try await registry.registerVerifiedConnection(peer: peer())
        let session = try await registry.openSession(on: connection, request: handshake())
        #expect(session.owner.connectionGeneration == 1)
        #expect(session.owner.sessionNonce == "session_0123456789abcdef0123456789abcdef")
        let admitted = try await registry.admit(
            request(sessionNonce: session.owner.sessionNonce, id: 1), on: connection, at: now)
        #expect(admitted == session.owner)
    }

    @Test("only a replacement handshake retires the complete old generation")
    func replacementInvalidatesOldConnection() async throws {
        let registry = RuntimeSessionRegistry(nonceSource: {
            "session_0123456789abcdef0123456789abcdef"
        })
        let first = try await registry.registerVerifiedConnection(peer: peer("first"))
        _ = try await registry.openSession(on: first, request: handshake())
        let second = try await registry.registerVerifiedConnection(peer: peer("second"))
        #expect(await registry.isCurrent(first))
        #expect(await !registry.isCurrent(second))
        _ = try await registry.openSession(on: second, request: handshake("b"))
        #expect(await !registry.isCurrent(first))
        #expect(await registry.isCurrent(second))
        await #expect(throws: RuntimeSessionError.connectionReplaced) {
            try await registry.openSession(on: first, request: self.handshake("c"))
        }
    }

    @Test("an unhandshaken reconnect cannot evict the active session")
    func candidateCannotEvictActiveSession() async throws {
        let nonce = "session_0123456789abcdef0123456789abcdef"
        let registry = RuntimeSessionRegistry(nonceSource: { nonce })
        let active = try await registry.registerVerifiedConnection(peer: peer("active"))
        _ = try await registry.openSession(on: active, request: handshake())
        let reconnect = try await registry.registerVerifiedConnection(peer: peer("reconnect"))

        await #expect(throws: RuntimeSessionError.sessionInvalid) {
            try await registry.admit(
                self.request(sessionNonce: nonce, id: 1), on: reconnect, at: self.now)
        }
        #expect(await registry.isCurrent(active))
        _ = try await registry.admit(
            request(sessionNonce: nonce, id: 2), on: active, at: now)
    }

    @Test("a second handshake invalidates the connection")
    func handshakeIsSingleUse() async throws {
        let registry = RuntimeSessionRegistry(nonceSource: {
            "session_0123456789abcdef0123456789abcdef"
        })
        let connection = try await registry.registerVerifiedConnection(peer: peer())
        _ = try await registry.openSession(on: connection, request: handshake())
        await #expect(throws: RuntimeSessionError.handshakeAlreadyCompleted) {
            try await registry.openSession(on: connection, request: self.handshake("b"))
        }
        #expect(await !registry.isCurrent(connection))
    }

    @Test("wrong nonce and duplicate request both close the session")
    func nonceAndReplayFailClosed() async throws {
        let nonce = "session_0123456789abcdef0123456789abcdef"
        let registry = RuntimeSessionRegistry(nonceSource: { nonce })
        var connection = try await registry.registerVerifiedConnection(peer: peer())
        _ = try await registry.openSession(on: connection, request: handshake())
        await #expect(throws: RuntimeSessionError.sessionInvalid) {
            try await registry.admit(self.request(
                sessionNonce: "session_ffffffffffffffffffffffffffffffff", id: 1),
                on: connection, at: self.now)
        }
        #expect(await !registry.isCurrent(connection))

        connection = try await registry.registerVerifiedConnection(peer: peer())
        _ = try await registry.openSession(on: connection, request: handshake())
        let first = try request(sessionNonce: nonce, id: 1)
        _ = try await registry.admit(first, on: connection, at: now)
        await #expect(throws: RuntimeSessionError.replayDetected) {
            try await registry.admit(first, on: connection, at: self.now)
        }
        #expect(await !registry.isCurrent(connection))
    }

    @Test("replay window exhaustion requires a fresh connection")
    func replayWindowIsBounded() async throws {
        let nonce = "session_0123456789abcdef0123456789abcdef"
        let registry = RuntimeSessionRegistry(configuration: .init(maxReplayEntries: 2),
                                              nonceSource: { nonce })
        let connection = try await registry.registerVerifiedConnection(peer: peer())
        _ = try await registry.openSession(on: connection, request: handshake())
        _ = try await registry.admit(request(sessionNonce: nonce, id: 1), on: connection, at: now)
        _ = try await registry.admit(request(sessionNonce: nonce, id: 2), on: connection, at: now)
        await #expect(throws: RuntimeSessionError.replayWindowExhausted) {
            try await registry.admit(self.request(sessionNonce: nonce, id: 3),
                                     on: connection, at: self.now)
        }
        #expect(await !registry.isCurrent(connection))
    }

    @Test("rate overflow and clock rollback close the session")
    func rateAndClockFailClosed() async throws {
        let nonce = "session_0123456789abcdef0123456789abcdef"
        let registry = RuntimeSessionRegistry(
            configuration: .init(maxReplayEntries: 10, maxRequestsPerSecond: 2),
            nonceSource: { nonce })
        var connection = try await registry.registerVerifiedConnection(peer: peer())
        _ = try await registry.openSession(on: connection, request: handshake())
        _ = try await registry.admit(request(sessionNonce: nonce, id: 1), on: connection, at: now)
        _ = try await registry.admit(request(sessionNonce: nonce, id: 2), on: connection, at: now)
        await #expect(throws: RuntimeSessionError.rateLimitExceeded) {
            try await registry.admit(self.request(sessionNonce: nonce, id: 3),
                                     on: connection, at: self.now)
        }

        connection = try await registry.registerVerifiedConnection(peer: peer())
        _ = try await registry.openSession(on: connection, request: handshake())
        _ = try await registry.admit(request(sessionNonce: nonce, id: 4), on: connection, at: now)
        await #expect(throws: RuntimeSessionError.clockInvalid) {
            try await registry.admit(self.request(sessionNonce: nonce, id: 5),
                                     on: connection, at: self.now.addingTimeInterval(-1))
        }
        #expect(await !registry.isCurrent(connection))
    }

    @Test("invalid nonce generation never creates a session")
    func invalidNonceFailsClosed() async throws {
        let registry = RuntimeSessionRegistry(nonceSource: { "predictable" })
        let connection = try await registry.registerVerifiedConnection(peer: peer())
        await #expect(throws: RuntimeSessionError.nonceGenerationFailed) {
            try await registry.openSession(on: connection, request: self.handshake())
        }
        #expect(await !registry.isCurrent(connection))
    }
}
