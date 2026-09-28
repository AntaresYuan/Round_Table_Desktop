import AppKit
import Foundation
#if SWIFT_PACKAGE
import RoundTableContracts
#endif

enum BootstrapXPCSmoke {
    private final class ConnectionBox: @unchecked Sendable {
        let connection: NSXPCConnection
        init(_ connection: NSXPCConnection) { self.connection = connection }
    }

    private final class ProxyBox: @unchecked Sendable {
        let proxy: RoundTableBootstrapXPCProtocol
        init(_ proxy: RoundTableBootstrapXPCProtocol) { self.proxy = proxy }
    }

    private final class Endpoint: @unchecked Sendable {
        let connection: NSXPCConnection
        let proxy: RoundTableBootstrapXPCProtocol

        init(connection: NSXPCConnection, proxy: RoundTableBootstrapXPCProtocol) {
            self.connection = connection
            self.proxy = proxy
        }
    }

    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var fired = false

        func run(_ action: () -> Void) {
            let shouldRun = lock.withLock {
                guard !fired else { return false }
                fired = true
                return true
            }
            if shouldRun { action() }
        }
    }

    private static let serviceName = "com.roundtable.desktop.host-runtime"
    private static let smokeEnvironmentKey = "ROUNDTABLE_BOOTSTRAP_XPC_SMOKE"

    static func runIfRequested() {
        switch ProcessInfo.processInfo.environment[smokeEnvironmentKey] {
        case "1", "live":
            runLive()
        case "security":
            SecuritySmokeRunner().run()
        case "workspace":
            SecuritySmokeRunner().runWorkspace()
        case "orchestration":
            SecuritySmokeRunner().runOrchestration()
        default:
            return
        }
    }

    private static func runLive() {
        let connection = NSXPCConnection(serviceName: serviceName)
        let box = ConnectionBox(connection)
        connection.remoteObjectInterface = NSXPCInterface(with: RoundTableBootstrapXPCProtocol.self)
        connection.interruptionHandler = { finish("interrupted\n", connection, 1) }
        connection.invalidationHandler = {}
        guard let requirement = try? HostRuntimeClient.embeddedServiceRequirement() else {
            finish("service_identity_unavailable\n", connection, 1)
            return
        }
        connection.setCodeSigningRequirement(requirement)
        connection.resume()

        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ error in
            finish("error:\(error.localizedDescription)\n", connection, 1)
        }) as? RoundTableBootstrapXPCProtocol else {
            finish("proxy_unavailable\n", connection, 1)
            return
        }
        let proxyBox = ProxyBox(proxy)
        let clientNonce = "client_" + UUID().uuidString
            .replacingOccurrences(of: "-", with: "").lowercased()
        let open = Data(
            "{\"protocolVersion\":1,\"clientNonce\":\"\(clientNonce)\"}".utf8)
        proxy.openSession(open) { response in
            guard let session = try? HostRuntimeSessionOpenResponse.decodeStrict(response) else {
                finish("handshake_invalid\n", box.connection, 1)
                return
            }
            let requestID = "request_" + UUID().uuidString
                .replacingOccurrences(of: "-", with: "").lowercased()
            let statusJSON =
                "{\"protocolVersion\":1,\"requestId\":\"\(requestID)\"," +
                "\"sessionNonce\":\"\(session.sessionNonce)\"," +
                "\"operation\":\"system.status\",\"payload\":{}}"
            let statusRequest = Data(statusJSON.utf8)
            proxyBox.proxy.perform(statusRequest, bookmarkData: nil) { statusResponse in
                guard (try? HostRuntimeResponseCodec.validate(statusResponse)) != nil,
                      let envelope = try? JSONSerialization.jsonObject(with: statusResponse)
                        as? [String: Any],
                      envelope["requestId"] as? String == requestID,
                      envelope["operation"] as? String == "system.status",
                      envelope["ok"] as? Bool == true else {
                    finish("status_invalid\n", box.connection, 1)
                    return
                }
                finish("live\n", box.connection, 0)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            FileHandle.standardOutput.write(Data("timeout\n".utf8))
            exit(1)
        }
    }

    private static func finish(
        _ result: String,
        _ connection: NSXPCConnection,
        _ status: Int32
    ) {
        FileHandle.standardOutput.write(Data(result.utf8))
        connection.invalidate()
        exit(status)
    }

    private final class SecuritySmokeRunner: @unchecked Sendable {
        private var connections: [NSXPCConnection] = []
        private var workspaceURL: URL?

        func run() {
            guard let first = connect() else { return }
            let nonce = "client_0123456789abcdef0123456789abcdef"
            let request = Data(
                "{\"protocolVersion\":0,\"clientNonce\":\"\(nonce)\"}".utf8)
            first.proxy.openSession(request) { [self] response in
                guard let failure = try? HostRuntimeSessionOpenFailure.decodeStrict(response),
                      failure.error ==
                        MacOSHostRuntimeV1Generated.handshakeVersionMismatchError else {
                    fail("downgrade_not_rejected")
                }
                exerciseReplayAndReconnect()
            }
            installTimeout()
        }

        func runWorkspace() {
            do {
                let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                    "roundtable-workspace-smoke-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(
                    at: root, withIntermediateDirectories: false)
                try Data("workspace-smoke".utf8).write(
                    to: root.appendingPathComponent("marker.txt"), options: .atomic)
                workspaceURL = root
                let bookmark = try root.bookmarkData(
                    options: [.withSecurityScope], includingResourceValuesForKeys: nil,
                    relativeTo: nil)
                var bookmarkIsStale = false
                _ = try URL(
                    resolvingBookmarkData: bookmark, options: [.withSecurityScope],
                    relativeTo: nil, bookmarkDataIsStale: &bookmarkIsStale)
                guard !bookmarkIsStale else {
                    fail("workspace_fixture_bookmark_stale")
                }
                guard let endpoint = connect() else { return }
                openValid(endpoint.proxy) { [self] session in
                    registerWorkspace(endpoint, session: session, bookmark: bookmark)
                }
                installTimeout()
            } catch {
                fail("workspace_fixture_failed:\(error.localizedDescription)")
            }
        }

        func runOrchestration() {
            guard let url = Bundle.main.url(
                forResource: "feature-builder-local-dispatch.timeline", withExtension: "json"),
                  let data = try? Data(contentsOf: url),
                  let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let frames = root["frames"] as? [[String: Any]],
                  let first = frames.first?["turn"] as? [String: Any],
                  let goal = first["message"] as? String,
                  let endpoint = connect() else {
                fail("orchestration_fixture_unavailable")
            }
            openValid(endpoint.proxy) { [self] session in
                let startID = newID(prefix: "request_")
                sendTurn(endpoint, request: turnRequest(
                    requestID: startID, session: session, action: "start",
                    fields: ["goal": goal, "workflowTemplateId": "wf-feature-builder"])) { [self] started in
                    guard started.ok, started.awaiting == "plan_approval",
                          started.frames.map(\.sequence) == [1],
                          let streamID = started.streamId else { fail("orchestration_start_invalid") }
                    let approveID = newID(prefix: "request_")
                    sendTurn(endpoint, request: turnRequest(
                        requestID: approveID, session: session, action: "approve",
                        fields: ["streamId": streamID])) { [self] approved in
                        guard approved.ok, approved.awaiting == "delivery_decision",
                              approved.frames.map(\.sequence) == [1, 2, 3] else {
                            fail("orchestration_approve_invalid")
                        }
                        let pollID = newID(prefix: "request_")
                        sendTurn(endpoint, request: turnRequest(
                            requestID: pollID, session: session, action: "poll",
                            fields: ["streamId": streamID, "afterSequence": 1])) { [self] replayed in
                            guard replayed.frames.map(\.sequence) == [2, 3] else {
                                fail("orchestration_replay_invalid")
                            }
                            let acceptID = newID(prefix: "request_")
                            sendTurn(endpoint, request: turnRequest(
                                requestID: acceptID, session: session, action: "accept",
                                fields: ["streamId": streamID])) { delivered in
                                guard delivered.terminal == true, delivered.awaiting == nil else {
                                    self.fail("orchestration_delivery_invalid")
                                }
                                finish("orchestration\n", endpoint.connection, 0)
                            }
                        }
                    }
                }
            }
            installTimeout()
        }

        private func turnRequest(
            requestID: String, session: HostRuntimeSessionOpenResponse,
            action: String, fields: [String: Any]
        ) -> Data {
            var object: [String: Any] = [
                "protocolVersion": 1, "requestId": requestID,
                "sessionNonce": session.sessionNonce, "action": action,
            ]
            for (key, value) in fields { object[key] = value }
            return try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        }

        private func sendTurn(
            _ endpoint: Endpoint, request: Data,
            completion: @escaping @Sendable (TurnStreamResponse) -> Void
        ) {
            endpoint.proxy.turnStream(request) { [self] data in
                guard let response = try? TurnStreamResponse.decodeStrict(data) else {
                    fail("orchestration_response_invalid")
                }
                completion(response)
            }
        }

        private func registerWorkspace(
            _ endpoint: Endpoint, session: HostRuntimeSessionOpenResponse, bookmark: Data
        ) {
            let requestID = newID(prefix: "request_")
            let transferID = newID(prefix: "bookmark_")
            let request = Data((
                "{\"protocolVersion\":1,\"requestId\":\"\(requestID)\"," +
                "\"sessionNonce\":\"\(session.sessionNonce)\"," +
                "\"operation\":\"workspace.register\",\"payload\":{" +
                "\"bookmarkTransferId\":\"\(transferID)\"," +
                "\"displayName\":\"Smoke Workspace\"}}"
            ).utf8)
            endpoint.proxy.perform(request, bookmarkData: bookmark) { [self] response in
                guard (try? HostRuntimeResponseCodec.validate(response)) != nil,
                      let object = try? JSONSerialization.jsonObject(with: response)
                        as? [String: Any],
                      object["ok"] as? Bool == true,
                      let payload = object["payload"] as? [String: Any],
                      let workspace = payload["workspace"] as? [String: Any],
                      let workspaceID = workspace["id"] as? String else {
                    fail("workspace_register_invalid:\(String(decoding: response, as: UTF8.self))")
                }
                listWorkspace(endpoint, session: session, workspaceID: workspaceID)
            }
        }

        private func listWorkspace(
            _ endpoint: Endpoint, session: HostRuntimeSessionOpenResponse,
            workspaceID: String
        ) {
            let requestID = newID(prefix: "request_")
            let request = Data((
                "{\"protocolVersion\":1,\"requestId\":\"\(requestID)\"," +
                "\"sessionNonce\":\"\(session.sessionNonce)\"," +
                "\"operation\":\"workspace.list\",\"payload\":{" +
                "\"workspaceId\":\"\(workspaceID)\",\"relativePath\":\"\"}}"
            ).utf8)
            endpoint.proxy.perform(request, bookmarkData: nil) { [self] response in
                guard (try? HostRuntimeResponseCodec.validate(response)) != nil,
                      let object = try? JSONSerialization.jsonObject(with: response)
                        as? [String: Any],
                      object["ok"] as? Bool == true,
                      let payload = object["payload"] as? [String: Any],
                      let entries = payload["entries"] as? [[String: Any]],
                      entries.contains(where: {
                          $0["name"] as? String == "marker.txt" &&
                          $0["kind"] as? String == "file"
                      }) else {
                    fail("workspace_list_invalid")
                }
                cleanupWorkspace()
                finish("workspace\n", endpoint.connection, 0)
            }
        }

        private func exerciseReplayAndReconnect() {
            guard let second = connect() else { return }
            openValid(second.proxy) { [self] secondSession in
                guard let replacement = connect() else { return }
                openValid(replacement.proxy) { [self] replacementSession in
                    let once = Once()
                    let continueWithReplacement: @Sendable () -> Void = { [self] in
                        once.run {
                            exerciseReplay(on: replacement, session: replacementSession)
                        }
                    }
                    guard let retiredProxy = second.connection
                        .remoteObjectProxyWithErrorHandler({ _ in
                            continueWithReplacement()
                        }) as? RoundTableBootstrapXPCProtocol else {
                        fail("replacement_proxy_unavailable")
                    }
                    let requestID = newID(prefix: "request_")
                    retiredProxy.perform(
                        statusRequest(
                            requestID: requestID,
                            sessionNonce: secondSession.sessionNonce),
                        bookmarkData: nil
                    ) { [self] response in
                        guard validFailure(
                            response, requestID: requestID, error: "session_invalid"
                        ) else {
                            fail("replaced_connection_still_authorized")
                        }
                        continueWithReplacement()
                    }
                }
            }
        }

        private func exerciseReplay(
            on endpoint: Endpoint, session: HostRuntimeSessionOpenResponse
        ) {
            let requestID = newID(prefix: "request_")
            let request = statusRequest(
                requestID: requestID, sessionNonce: session.sessionNonce)
            endpoint.proxy.perform(request, bookmarkData: nil) { [self] firstResponse in
                guard validStatus(firstResponse, requestID: requestID) else {
                    fail("first_status_invalid:\(String(decoding: firstResponse, as: UTF8.self))")
                }
                endpoint.proxy.perform(request, bookmarkData: nil) { [self] replayResponse in
                    guard validFailure(
                        replayResponse, requestID: requestID, error: "session_invalid"
                    ) else {
                        fail("replay_not_rejected")
                    }
                    proveReconnect()
                }
            }
        }

        private func proveReconnect() {
            guard let final = connect() else { return }
            openValid(final.proxy) { [self] session in
                let requestID = newID(prefix: "request_")
                final.proxy.perform(
                    statusRequest(requestID: requestID, sessionNonce: session.sessionNonce),
                    bookmarkData: nil
                ) { response in
                    guard self.validStatus(response, requestID: requestID) else {
                        self.fail("reconnect_status_invalid")
                    }
                    finish("security\n", final.connection, 0)
                }
            }
        }

        private func connect() -> Endpoint? {
            let connection = NSXPCConnection(serviceName: serviceName)
            connection.remoteObjectInterface = NSXPCInterface(
                with: RoundTableBootstrapXPCProtocol.self)
            connection.invalidationHandler = {}
            connection.interruptionHandler = {}
            guard let requirement = try? HostRuntimeClient.embeddedServiceRequirement() else {
                fail("service_identity_unavailable")
            }
            connection.setCodeSigningRequirement(requirement)
            connection.resume()
            connections.append(connection)
            guard let proxy = connection.remoteObjectProxyWithErrorHandler({ [self] error in
                fail("xpc_error:\(error.localizedDescription)")
            }) as? RoundTableBootstrapXPCProtocol else {
                fail("proxy_unavailable")
            }
            return Endpoint(connection: connection, proxy: proxy)
        }

        private func openValid(
            _ proxy: RoundTableBootstrapXPCProtocol,
            completion: @escaping @Sendable (HostRuntimeSessionOpenResponse) -> Void
        ) {
            let clientNonce = newID(prefix: "client_")
            proxy.openSession(Data(
                "{\"protocolVersion\":1,\"clientNonce\":\"\(clientNonce)\"}".utf8
            )) { [self] response in
                guard let session = try? HostRuntimeSessionOpenResponse.decodeStrict(response) else {
                    fail("handshake_invalid")
                }
                completion(session)
            }
        }

        private func statusRequest(requestID: String, sessionNonce: String) -> Data {
            Data((
                "{\"protocolVersion\":1,\"requestId\":\"\(requestID)\"," +
                "\"sessionNonce\":\"\(sessionNonce)\"," +
                "\"operation\":\"system.status\",\"payload\":{}}"
            ).utf8)
        }

        private func validStatus(_ data: Data, requestID: String) -> Bool {
            guard (try? HostRuntimeResponseCodec.validate(data)) != nil,
                  let object = try? JSONSerialization.jsonObject(with: data)
                    as? [String: Any] else { return false }
            return object["requestId"] as? String == requestID &&
                object["operation"] as? String == "system.status" &&
                object["ok"] as? Bool == true
        }

        private func validFailure(_ data: Data, requestID: String, error: String) -> Bool {
            guard (try? HostRuntimeResponseCodec.validate(data)) != nil,
                  let object = try? JSONSerialization.jsonObject(with: data)
                    as? [String: Any] else { return false }
            return object["requestId"] as? String == requestID &&
                object["operation"] as? String == "system.status" &&
                object["ok"] as? Bool == false &&
                object["error"] as? String == error
        }

        private func newID(prefix: String) -> String {
            prefix + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        }

        private func installTimeout() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
                FileHandle.standardOutput.write(Data("security_timeout\n".utf8))
                exit(1)
            }
        }

        private func fail(_ reason: String) -> Never {
            cleanupWorkspace()
            FileHandle.standardOutput.write(Data("\(reason)\n".utf8))
            exit(1)
        }

        private func cleanupWorkspace() {
            guard let workspaceURL else { return }
            try? FileManager.default.removeItem(at: workspaceURL)
            self.workspaceURL = nil
        }
    }
}
