import Foundation
import Security
#if SWIFT_PACKAGE
import RoundTableContracts
import RoundTableScene
#endif

struct RegisteredWorkspace: Equatable, Sendable {
    let id: String
    let name: String
    let entryCount: Int
}

struct HostRuntimeAvailability: Equatable, Sendable {
    let state: String
    let admission: String
}

enum HostRuntimeClientError: Error, Equatable, CustomStringConvertible {
    case connectionUnavailable
    case timedOut
    case invalidHandshake
    case invalidResponse
    case serviceIdentityInvalid
    case remote(String)

    var description: String {
        switch self {
        case .connectionUnavailable: "connection unavailable"
        case .timedOut: "request timed out"
        case .invalidHandshake: "invalid handshake"
        case .invalidResponse: "invalid response"
        case .serviceIdentityInvalid: "host runtime identity invalid"
        case .remote(let code): code
        }
    }
}

private final class XPCReplyGate<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?

    init(_ continuation: CheckedContinuation<Value, Error>) {
        self.continuation = continuation
    }

    func resume(_ result: Result<Value, Error>) {
        let pending = lock.withLock { () -> CheckedContinuation<Value, Error>? in
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(with: result)
    }
}

/// The App-side endpoint for the authenticated embedded XPC service.
///
/// This object owns one connection and one connection-scoped session nonce.
/// It never retries a mutation: a bookmark transfer is single-use, so callers
/// must make a fresh user-authorized selection after any ambiguous failure.
@MainActor
final class HostRuntimeClient {
    private static let serviceName = "com.roundtable.desktop.host-runtime"
    private static let timeout: DispatchTimeInterval = .seconds(5)

    private var connection: NSXPCConnection?
    private var proxy: RoundTableBootstrapXPCProtocol?
    private var sessionNonce: String?

    func connect() async throws {
        if connection != nil, proxy != nil, sessionNonce != nil { return }
        invalidate()

        let candidate = NSXPCConnection(serviceName: Self.serviceName)
        candidate.remoteObjectInterface = NSXPCInterface(
            with: RoundTableBootstrapXPCProtocol.self)
        candidate.invalidationHandler = { [weak self] in
            Task { @MainActor [weak self] in self?.clearIfCurrent(candidate) }
        }
        candidate.interruptionHandler = { [weak self] in
            Task { @MainActor [weak self] in self?.clearIfCurrent(candidate) }
        }
        do {
            // Pin the exact embedded service selected from this sealed App
            // bundle. This is configured before the first message is sent.
            candidate.setCodeSigningRequirement(try Self.embeddedServiceRequirement())
        } catch {
            candidate.invalidate()
            throw HostRuntimeClientError.serviceIdentityInvalid
        }
        candidate.resume()

        guard let endpoint = candidate.remoteObjectProxyWithErrorHandler({ _ in })
            as? RoundTableBootstrapXPCProtocol else {
            candidate.invalidate()
            throw HostRuntimeClientError.connectionUnavailable
        }
        connection = candidate
        proxy = endpoint

        do {
            let open = try Self.jsonData([
                "protocolVersion": MacOSHostRuntimeV1Generated.version,
                "clientNonce": Self.opaqueID(prefix: "client_"),
            ])
            let response = try await Self.openSession(endpoint, request: open)
            let session = try HostRuntimeSessionOpenResponse.decodeStrict(response)
            guard session.protocolVersion == MacOSHostRuntimeV1Generated.version else {
                throw HostRuntimeClientError.invalidHandshake
            }
            sessionNonce = session.sessionNonce
        } catch {
            invalidate()
            throw error
        }
    }

    func registerWorkspace(bookmarkData: Data, displayName: String) async throws -> RegisteredWorkspace {
        try await connect()
        guard let endpoint = proxy, let sessionNonce else {
            throw HostRuntimeClientError.connectionUnavailable
        }

        let registerPayload: [String: Any] = [
            "bookmarkTransferId": Self.opaqueID(prefix: "bookmark_"),
            "displayName": displayName,
        ]
        let register = try await perform(
            endpoint, sessionNonce: sessionNonce, operation: .workspaceRegister,
            payload: registerPayload, bookmarkData: bookmarkData)
        let registerPayloadObject = try Self.successPayload(
            register.data, requestID: register.requestID, operation: .workspaceRegister)
        guard let workspace = registerPayloadObject["workspace"] as? [String: Any],
              let workspaceID = workspace["id"] as? String,
              let workspaceName = workspace["name"] as? String else {
            throw HostRuntimeClientError.invalidResponse
        }

        let list = try await perform(
            endpoint, sessionNonce: sessionNonce, operation: .workspaceList,
            payload: ["workspaceId": workspaceID, "relativePath": ""], bookmarkData: nil)
        let listPayload = try Self.successPayload(
            list.data, requestID: list.requestID, operation: .workspaceList)
        guard let entries = listPayload["entries"] as? [[String: Any]] else {
            throw HostRuntimeClientError.invalidResponse
        }
        return RegisteredWorkspace(id: workspaceID, name: workspaceName, entryCount: entries.count)
    }

    func status() async throws -> HostRuntimeAvailability {
        try await connect()
        guard let endpoint = proxy, let sessionNonce else {
            throw HostRuntimeClientError.connectionUnavailable
        }
        let status = try await perform(
            endpoint, sessionNonce: sessionNonce, operation: .systemStatus,
            payload: [:], bookmarkData: nil)
        let payload = try Self.successPayload(
            status.data, requestID: status.requestID, operation: .systemStatus)
        guard let availability = payload["runtimeAvailability"] as? [String: Any],
              let state = availability["state"] as? String,
              let admission = availability["admission"] as? String else {
            throw HostRuntimeClientError.invalidResponse
        }
        return HostRuntimeAvailability(state: state, admission: admission)
    }

    func turnStream(
        action: TurnStreamAction, streamId: String? = nil,
        afterSequence: Int? = nil, goal: String? = nil,
        workflowTemplateId: String? = nil
    ) async throws -> TurnStreamResponse {
        try await connect()
        guard let endpoint = proxy, let sessionNonce else {
            throw HostRuntimeClientError.connectionUnavailable
        }
        let requestID = Self.opaqueID(prefix: "request_")
        var object: [String: Any] = [
            "protocolVersion": MacOSHostRuntimeV1Generated.version,
            "requestId": requestID,
            "sessionNonce": sessionNonce,
            "action": action.rawValue,
        ]
        if let streamId { object["streamId"] = streamId }
        if let afterSequence { object["afterSequence"] = afterSequence }
        if let goal { object["goal"] = goal }
        if let workflowTemplateId { object["workflowTemplateId"] = workflowTemplateId }
        let response = try await Self.turnStream(endpoint, request: Self.jsonData(object))
        let decoded: TurnStreamResponse
        do { decoded = try TurnStreamResponse.decodeStrict(response) }
        catch { throw HostRuntimeClientError.invalidResponse }
        guard decoded.requestId == requestID else { throw HostRuntimeClientError.invalidResponse }
        if !decoded.ok { throw HostRuntimeClientError.remote(decoded.error ?? "turn_stream_failed") }
        return decoded
    }

    func invalidate() {
        let previous = connection
        connection = nil
        proxy = nil
        sessionNonce = nil
        previous?.invalidate()
    }

    private func clearIfCurrent(_ candidate: NSXPCConnection) {
        guard connection === candidate else { return }
        connection = nil
        proxy = nil
        sessionNonce = nil
    }

    private func perform(
        _ endpoint: RoundTableBootstrapXPCProtocol,
        sessionNonce: String,
        operation: HostRuntimeOperation,
        payload: [String: Any],
        bookmarkData: Data?
    ) async throws -> (requestID: String, data: Data) {
        let requestID = Self.opaqueID(prefix: "request_")
        let request = try Self.jsonData([
            "protocolVersion": MacOSHostRuntimeV1Generated.version,
            "requestId": requestID,
            "sessionNonce": sessionNonce,
            "operation": operation.rawValue,
            "payload": payload,
        ])
        let response = try await Self.perform(endpoint, request: request, bookmarkData: bookmarkData)
        return (requestID, response)
    }

    private static func successPayload(
        _ data: Data, requestID: String, operation: HostRuntimeOperation
    ) throws -> [String: Any] {
        do { try HostRuntimeResponseCodec.validate(data) }
        catch { throw HostRuntimeClientError.invalidResponse }
        guard let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              envelope["requestId"] as? String == requestID,
              envelope["operation"] as? String == operation.rawValue,
              let ok = envelope["ok"] as? Bool else {
            throw HostRuntimeClientError.invalidResponse
        }
        if !ok {
            guard let code = envelope["error"] as? String else {
                throw HostRuntimeClientError.invalidResponse
            }
            throw HostRuntimeClientError.remote(code)
        }
        guard let payload = envelope["payload"] as? [String: Any] else {
            throw HostRuntimeClientError.invalidResponse
        }
        return payload
    }

    nonisolated static func embeddedServiceRequirement() throws -> String {
        let executable = Bundle.main.bundleURL
            .appendingPathComponent("Contents/XPCServices", isDirectory: true)
            .appendingPathComponent("RoundTableHostRuntimeBootstrap.xpc", isDirectory: true)
            .appendingPathComponent("Contents/MacOS/RoundTableHostRuntimeBootstrap", isDirectory: false)
        var staticCode: SecStaticCode?
        guard SecStaticCodeCreateWithPath(executable as CFURL, [], &staticCode) == errSecSuccess,
              let staticCode,
              SecStaticCodeCheckValidity(staticCode, [], nil) == errSecSuccess else {
            throw HostRuntimeClientError.serviceIdentityInvalid
        }
        var information: CFDictionary?
        guard SecCodeCopySigningInformation(
            staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
              let information = information as? [String: Any],
              information[kSecCodeInfoIdentifier as String] as? String
                == "com.roundtable.desktop.host-runtime" else {
            throw HostRuntimeClientError.serviceIdentityInvalid
        }
        var requirement: SecRequirement?
        guard SecCodeCopyDesignatedRequirement(staticCode, [], &requirement) == errSecSuccess,
              let requirement else {
            throw HostRuntimeClientError.serviceIdentityInvalid
        }
        var text: CFString?
        guard SecRequirementCopyString(requirement, [], &text) == errSecSuccess,
              let text else {
            throw HostRuntimeClientError.serviceIdentityInvalid
        }
        return text as String
    }

    private static func openSession(
        _ endpoint: RoundTableBootstrapXPCProtocol, request: Data
    ) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let gate = XPCReplyGate(continuation)
            endpoint.openSession(request) { gate.resume(.success($0)) }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
                gate.resume(.failure(HostRuntimeClientError.timedOut))
            }
        }
    }

    private static func perform(
        _ endpoint: RoundTableBootstrapXPCProtocol, request: Data, bookmarkData: Data?
    ) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let gate = XPCReplyGate(continuation)
            endpoint.perform(request, bookmarkData: bookmarkData) {
                gate.resume(.success($0))
            }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
                gate.resume(.failure(HostRuntimeClientError.timedOut))
            }
        }
    }

    private static func turnStream(
        _ endpoint: RoundTableBootstrapXPCProtocol, request: Data
    ) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            let gate = XPCReplyGate(continuation)
            endpoint.turnStream(request) { gate.resume(.success($0)) }
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + timeout) {
                gate.resume(.failure(HostRuntimeClientError.timedOut))
            }
        }
    }

    private static func jsonData(_ value: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    }

    private static func opaqueID(prefix: String) -> String {
        prefix + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    }
}

@MainActor
final class HostRuntimeTurnSource: TurnSource, @unchecked Sendable {
    nonisolated let events: AsyncStream<TurnSourceEvent>
    private let continuation: AsyncStream<TurnSourceEvent>.Continuation
    private let client = HostRuntimeClient()
    private let goal: String
    private let workflowTemplateId: String
    private var streamId: String?
    private var lastSequence = 0
    private var cancelled = false

    init(goal: String, workflowTemplateId: String) {
        self.goal = goal
        self.workflowTemplateId = workflowTemplateId
        (events, continuation) = AsyncStream.makeStream(of: TurnSourceEvent.self)
    }

    func startMission() async {
        guard !cancelled, streamId == nil else { return }
        do {
            let response = try await client.turnStream(
                action: .start, goal: goal, workflowTemplateId: workflowTemplateId)
            streamId = response.streamId
            try publish(response)
        } catch {
            continuation.yield(.failed(Self.stable(error)))
            continuation.finish()
        }
    }

    func resolve(_ gate: TurnGate) async {
        guard !cancelled, let streamId else { return }
        let action: TurnStreamAction
        switch gate {
        case .planApproval: action = .approve
        case .deliveryDecision: action = .accept
        case .clarification:
            continuation.yield(.failed("unsupported_gate"))
            continuation.finish()
            return
        }
        do { try publish(try await client.turnStream(action: action, streamId: streamId)) }
        catch {
            continuation.yield(.failed(Self.stable(error)))
            continuation.finish()
        }
    }

    func cancel() async {
        guard !cancelled else { return }
        cancelled = true
        if let streamId { _ = try? await client.turnStream(action: .stop, streamId: streamId) }
        client.invalidate()
        continuation.finish()
    }

    private func publish(_ response: TurnStreamResponse) throws {
        guard !cancelled else { return }
        for frame in response.frames where frame.sequence > lastSequence {
            let turn = try JSONDecoder().decode(RoundtableTurn.self, from: frame.turn)
            continuation.yield(.turns([LiveTurn(stored: turn)]))
            lastSequence = frame.sequence
        }
        if let gate = response.awaiting.flatMap(TurnGate.init(rawValue:)) {
            continuation.yield(.awaiting(gate))
        }
        if response.terminal == true {
            continuation.yield(.finished)
            continuation.finish()
            client.invalidate()
        }
    }

    private static func stable(_ error: Error) -> String {
        (error as? HostRuntimeClientError)?.description ?? "turn_stream_failed"
    }
}
