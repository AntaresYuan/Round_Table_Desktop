import Foundation
import OSLog
#if SWIFT_PACKAGE
import RoundTableContracts
#endif
import Security

/// A fact produced by the XPC audit-token verifier. The registry deliberately
/// receives no PID, path, bundle-id or UID claimed by request data.
public struct VerifiedAppPeer: Equatable, Sendable {
    public enum BuildProfile: String, Sendable {
        case development
        case release
    }

    public let effectiveUserID: uid_t
    public let auditSessionID: au_asid_t
    public let buildProfile: BuildProfile
    public let codeIdentityDigest: String

    public init(effectiveUserID: uid_t, auditSessionID: au_asid_t,
                buildProfile: BuildProfile, codeIdentityDigest: String) throws {
        guard !codeIdentityDigest.isEmpty, codeIdentityDigest.utf8.count <= 256 else {
            throw RuntimeSessionError.peerIdentityInvalid
        }
        self.effectiveUserID = effectiveUserID
        self.auditSessionID = auditSessionID
        self.buildProfile = buildProfile
        self.codeIdentityDigest = codeIdentityDigest
    }
}

public struct RuntimeConnection: Hashable, Sendable {
    fileprivate let generation: UInt64
    fileprivate let token: UUID
}

public struct RuntimeSession: Equatable, Sendable {
    public let owner: RuntimeSessionOwner
    public let protocolVersion: Int
    public let clientNonce: String
}

public enum RuntimeSessionError: String, Error, Equatable, Sendable {
    case peerIdentityInvalid = "peer_identity_invalid"
    case connectionReplaced = "connection_replaced"
    case handshakeAlreadyCompleted = "handshake_already_completed"
    case sessionInvalid = "session_invalid"
    case nonceGenerationFailed = "session_nonce_generation_failed"
    case replayDetected = "request_replay_detected"
    case replayWindowExhausted = "request_replay_window_exhausted"
    case rateLimitExceeded = "request_rate_limit_exceeded"
    case clockInvalid = "request_clock_invalid"
}

public struct RuntimeSessionConfiguration: Equatable, Sendable {
    public var maxReplayEntries: Int
    public var maxRequestsPerSecond: Int

    public init(maxReplayEntries: Int = 1_024,
                maxRequestsPerSecond: Int = MacOSHostRuntimeV1Generated.maxRequestsPerSecond) {
        self.maxReplayEntries = max(1, maxReplayEntries)
        self.maxRequestsPerSecond = max(1, maxRequestsPerSecond)
    }
}

/// Connection-scoped session authority. Attestation creates a bounded candidate;
/// only a successful strict handshake atomically promotes it and replaces the
/// old generation. Every uncertainty after handshake invalidates that generation
/// before an operation can reach a handler.
public actor RuntimeSessionRegistry {
    public typealias SessionNonceSource = @Sendable () throws -> String

    private struct State: Sendable {
        let peer: VerifiedAppPeer
        var session: RuntimeSession?
        var requestIDs: Set<String> = []
        var recentRequestTimes: [Date] = []
        var lastRequestAt: Date?
    }

    private let configuration: RuntimeSessionConfiguration
    private let logger = Logger(subsystem: "com.roundtable.desktop.host-runtime",
                                category: "session-registry")
    private let nonceSource: SessionNonceSource
    private var nextGeneration: UInt64 = 1
    private var currentConnection: RuntimeConnection?
    private var states: [RuntimeConnection: State] = [:]

    public init(configuration: RuntimeSessionConfiguration = .init(),
                nonceSource: @escaping SessionNonceSource = RuntimeSessionRegistry.secureSessionNonce) {
        self.configuration = configuration
        self.nonceSource = nonceSource
    }

    /// The caller must invoke this only after audit-token and code requirement
    /// verification. The active session remains authoritative until a verified
    /// candidate completes its strict handshake.
    public func registerVerifiedConnection(peer: VerifiedAppPeer) throws -> RuntimeConnection {
        guard nextGeneration != UInt64.max else { throw RuntimeSessionError.connectionReplaced }
        if let currentConnection {
            states = states.filter { $0.key == currentConnection }
        } else {
            states.removeAll()
        }
        let connection = RuntimeConnection(generation: nextGeneration, token: UUID())
        nextGeneration += 1
        states[connection] = State(peer: peer)
        logger.debug("registered generation \(connection.generation)")
        return connection
    }

    public func openSession(on connection: RuntimeConnection,
                            request: HostRuntimeSessionOpenRequest) throws -> RuntimeSession {
        guard var state = states[connection] else {
            throw RuntimeSessionError.connectionReplaced
        }
        guard state.session == nil else {
            invalidate(connection)
            throw RuntimeSessionError.handshakeAlreadyCompleted
        }
        let nonce: String
        do { nonce = try nonceSource() } catch {
            invalidate(connection)
            throw RuntimeSessionError.nonceGenerationFailed
        }
        guard nonce.range(of: MacOSHostRuntimeV1Generated.sessionNoncePattern,
                          options: .regularExpression) != nil else {
            invalidate(connection)
            throw RuntimeSessionError.nonceGenerationFailed
        }
        let owner = try RuntimeSessionOwner(connectionGeneration: connection.generation,
                                            sessionNonce: nonce)
        let session = RuntimeSession(owner: owner, protocolVersion: request.protocolVersion,
                                     clientNonce: request.clientNonce)
        state.session = session
        states.removeAll()
        states[connection] = state
        currentConnection = connection
        logger.debug("opened generation \(connection.generation)")
        return session
    }

    /// Runs after bounded strict envelope decoding and before authority or any
    /// operation handler. Success returns the connection-bound owner token.
    public func admit(_ request: HostRuntimeRequestEnvelope,
                      on connection: RuntimeConnection,
                      at now: Date = Date()) throws -> RuntimeSessionOwner {
        let candidateState = states[connection]
        let candidateSession = candidateState?.session
        guard connection == currentConnection, var state = states[connection],
              let session = state.session,
              request.sessionNonce == session.owner.sessionNonce else {
            logger.error("admit rejected generation \(connection.generation); current \(self.currentConnection?.generation ?? 0); state \(candidateState != nil); session \(candidateSession != nil); nonce \(candidateSession?.owner.sessionNonce == request.sessionNonce)")
            invalidate(connection)
            throw RuntimeSessionError.sessionInvalid
        }
        if let last = state.lastRequestAt, now < last {
            invalidate(connection)
            throw RuntimeSessionError.clockInvalid
        }
        guard !state.requestIDs.contains(request.requestID) else {
            invalidate(connection)
            throw RuntimeSessionError.replayDetected
        }
        guard state.requestIDs.count < configuration.maxReplayEntries else {
            invalidate(connection)
            throw RuntimeSessionError.replayWindowExhausted
        }
        state.recentRequestTimes.removeAll { now.timeIntervalSince($0) >= 1 }
        guard state.recentRequestTimes.count < configuration.maxRequestsPerSecond else {
            invalidate(connection)
            throw RuntimeSessionError.rateLimitExceeded
        }
        state.requestIDs.insert(request.requestID)
        state.recentRequestTimes.append(now)
        state.lastRequestAt = now
        states[connection] = state
        return session.owner
    }

    public func invalidate(_ connection: RuntimeConnection) {
        logger.debug("invalidating generation \(connection.generation); current \(self.currentConnection?.generation ?? 0)")
        states.removeValue(forKey: connection)
        if currentConnection == connection { currentConnection = nil }
    }

    public func isCurrent(_ connection: RuntimeConnection) -> Bool {
        connection == currentConnection && states[connection] != nil
    }

    public nonisolated static func secureSessionNonce() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw RuntimeSessionError.nonceGenerationFailed
        }
        return "session_" + bytes.map { String(format: "%02x", $0) }.joined()
    }
}
