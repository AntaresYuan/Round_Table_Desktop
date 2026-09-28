import Foundation
import OSLog

private final class HostRuntimeState: @unchecked Sendable {
    let sessions = RuntimeSessionRegistry()
    let admission = RuntimeAdmission()
    let workspaces = WorkspaceGrantRegistry()
    let providers = ProviderRegistry()
    let orchestration: RoundTableOrchestration?
    lazy var dispatcher = RuntimeDispatcher(
        sessions: sessions, admission: admission,
        workspaces: workspaces, providers: providers)

    init() {
        orchestration = Bundle.main.url(
            forResource: "feature-builder-local-dispatch.timeline", withExtension: "json")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? RoundTableOrchestration(oracleData: $0) }
    }
}

private final class XPCConnectionBox: @unchecked Sendable {
    weak var connection: NSXPCConnection?

    init(_ connection: NSXPCConnection) { self.connection = connection }
}

private final class HostRuntimeService: NSObject, RoundTableBootstrapXPCProtocol, @unchecked Sendable {
    private let logger = Logger(subsystem: "com.roundtable.desktop.host-runtime",
                                category: "request-gate")
    private let connection: NSXPCConnection
    private let runtime: HostRuntimeState
    private let registration: Task<RuntimeConnection, Error>
    private let lock = NSLock()
    private var owner: RuntimeSessionOwner?

    init(connection: NSXPCConnection, runtime: HostRuntimeState,
         registration: Task<RuntimeConnection, Error>) {
        self.connection = connection
        self.runtime = runtime
        self.registration = registration
    }

    func status(reply: @escaping @Sendable (String) -> Void) { reply("unavailable") }

    func openSession(_ request: Data, reply: @escaping @Sendable (Data) -> Void) {
        Task {
            do {
                let handle = try await registration.value
                let decoded = try HostRuntimeSessionOpenRequest.decodeStrict(request)
                let session = try await runtime.sessions.openSession(on: handle, request: decoded)
                lock.withLock { owner = session.owner }
                reply(Data("{\"protocolVersion\":1,\"sessionNonce\":\"\(session.owner.sessionNonce)\"}".utf8))
            } catch {
                let code = Self.handshakeFailureCode(request)
                reply(Data("{\"error\":\"\(code)\"}".utf8))
                invalidateAfterReply()
            }
        }
    }

    func perform(_ request: Data, bookmarkData: Data?, reply: @escaping @Sendable (Data) -> Void) {
        Task {
            do {
                let handle = try await registration.value
                let decoded = try HostRuntimeRequestEnvelope.decodeStrict(request)
                let attachment: WorkspaceBookmarkAttachment?
                if let bookmarkData {
                    if case .workspaceRegister(let transferId, _) = decoded.payload {
                        attachment = .init(transferId: transferId, data: bookmarkData)
                    } else {
                        attachment = .init(transferId: "bookmark_unexpected", data: bookmarkData)
                    }
                } else {
                    attachment = nil
                }
                reply(try await runtime.dispatcher.dispatch(
                    request, on: handle, attachment: attachment))
            } catch {
                logger.error("perform rejected: \(String(describing: error), privacy: .public)")
                if let decoded = try? HostRuntimeRequestEnvelope.decodeStrict(request),
                   let response = try? HostRuntimeResponseCodec.failure(
                    requestID: decoded.requestID, operation: decoded.operation,
                    error: "session_invalid") {
                    reply(response)
                } else {
                    reply(Data())
                }
                invalidateAfterReply()
            }
        }
    }

    func turnStream(_ request: Data, reply: @escaping @Sendable (Data) -> Void) {
        Task {
            let decoded: TurnStreamRequest
            do { decoded = try TurnStreamRequest.decodeStrict(request) }
            catch {
                reply(TurnStreamWireCodec.failure(
                    requestId: "request_invalid", error: "turn_stream_request_invalid"))
                return
            }
            do {
                _ = try await registration.value
                guard let owner = lock.withLock({ owner }),
                      owner.sessionNonce == decoded.sessionNonce,
                      let orchestration = runtime.orchestration else {
                    throw OrchestrationError.streamOwnerMismatch
                }
                let batch: OrchestrationBatch
                switch decoded.action {
                case .start:
                    batch = try await orchestration.start(
                        goal: decoded.goal!, workflowTemplateId: decoded.workflowTemplateId!,
                        owner: owner)
                case .poll:
                    batch = try await orchestration.poll(
                        streamId: decoded.streamId!, afterSequence: decoded.afterSequence!,
                        owner: owner)
                case .approve:
                    batch = try await orchestration.resolve(
                        streamId: decoded.streamId!, gate: .planApproval, owner: owner)
                case .accept:
                    batch = try await orchestration.resolve(
                        streamId: decoded.streamId!, gate: .deliveryDecision, owner: owner)
                case .stop:
                    try await orchestration.stop(streamId: decoded.streamId!, owner: owner)
                    reply(TurnStreamWireCodec.failure(
                        requestId: decoded.requestId, error: "turn_stream_stopped"))
                    return
                }
                reply(TurnStreamWireCodec.success(requestId: decoded.requestId, batch: batch))
            } catch let error as OrchestrationError {
                reply(TurnStreamWireCodec.failure(
                    requestId: decoded.requestId, error: error.rawValue))
            } catch {
                reply(TurnStreamWireCodec.failure(
                    requestId: decoded.requestId, error: "turn_stream_unavailable"))
            }
        }
    }

    func invalidate() {
        let currentOwner = lock.withLock { owner }
        Task {
            if let currentOwner {
                await runtime.workspaces.revokeOwned(by: currentOwner)
                await runtime.orchestration?.revokeOwned(by: currentOwner)
            }
            if let handle = try? await registration.value {
                await runtime.sessions.invalidate(handle)
            }
        }
    }

    private func invalidateAfterReply() {
        // Invoking the reply block queues the XPC response. Give that message a
        // bounded delivery window before invalidating the compromised session.
        let box = XPCConnectionBox(connection)
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + .milliseconds(100)) {
            box.connection?.invalidate()
        }
    }

    private static func handshakeFailureCode(_ request: Data) -> String {
        HostRuntimeSessionOpenRequest.failureCode(for: request)
    }
}

private final class HostRuntimeListenerDelegate: NSObject, NSXPCListenerDelegate {
    private let logger = Logger(subsystem: "com.roundtable.desktop.host-runtime",
                                category: "peer-admission")
    private let runtime = HostRuntimeState()
    private let peerPolicy: Result<XPCPeerPolicy, Error>
    private let lock = NSLock()
    private var setupTail: Task<Void, Never>?

    override init() {
        peerPolicy = Result { try XPCPeerPolicy.load() }
        super.init()
    }

    func listener(_ listener: NSXPCListener,
                  shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard case .success(let peerPolicy) = peerPolicy else {
            if case .failure(let error) = peerPolicy {
                logger.error("peer policy initialization failed: \(String(describing: error), privacy: .public)")
            }
            return false
        }
        let peer: VerifiedAppPeer
        do {
            peer = try peerPolicy.verify(connection)
        } catch {
            logger.error("peer verification failed: \(String(describing: error), privacy: .public)")
            return false
        }
        lock.withLock {
            let predecessor = setupTail
            let registration = Task<RuntimeConnection, Error> { [runtime] in
                _ = await predecessor?.result
                return try await runtime.sessions.registerVerifiedConnection(peer: peer)
            }
            setupTail = Task {
                _ = try? await registration.value
            }
            let service = HostRuntimeService(
                connection: connection, runtime: runtime, registration: registration)
            connection.exportedInterface = NSXPCInterface(
                with: RoundTableBootstrapXPCProtocol.self)
            connection.exportedObject = service
            connection.invalidationHandler = { service.invalidate() }
            connection.interruptionHandler = { service.invalidate() }
            connection.resume()
        }
        return true
    }
}

private let delegate = HostRuntimeListenerDelegate()
private let listener = NSXPCListener.service()
listener.delegate = delegate
listener.activate()
dispatchMain()
