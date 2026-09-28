import Darwin
import Foundation
import RoundTableContracts
import Testing
@testable import RoundTableHostRuntimeCore

@Suite("Host Runtime operation dispatcher")
struct RuntimeDispatcherTests {
    private let nonce = "session_0123456789abcdef0123456789abcdef"
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    private func setup() async throws -> (RuntimeDispatcher, RuntimeConnection) {
        let sessions = RuntimeSessionRegistry(nonceSource: { nonce })
        let peer = try VerifiedAppPeer(effectiveUserID: 501, auditSessionID: 1,
                                       buildProfile: .development,
                                       codeIdentityDigest: "verified")
        let connection = try await sessions.registerVerifiedConnection(peer: peer)
        let handshake = try HostRuntimeSessionOpenRequest.decodeStrict(Data(
            #"{"protocolVersion":1,"clientNonce":"client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#.utf8))
        _ = try await sessions.openSession(on: connection, request: handshake)
        return (RuntimeDispatcher(sessions: sessions, admission: RuntimeAdmission()), connection)
    }

    private func request(_ id: Int, operation: String) -> Data {
        Data(#"{"protocolVersion":1,"requestId":"request_\#(id)","sessionNonce":"\#(nonce)","operation":"\#(operation)","payload":{}}"#.utf8)
    }

    @Test("status and closed catalogue produce canonical responses")
    func safeReadOperations() async throws {
        let (dispatcher, connection) = try await setup()
        let status = try await dispatcher.dispatch(request(1, operation: "system.status"),
                                                   on: connection, at: now)
        let catalog = try await dispatcher.dispatch(request(2, operation: "runtime.catalog"),
                                                    on: connection, at: now)
        try HostRuntimeResponseCodec.validate(status)
        try HostRuntimeResponseCodec.validate(catalog)
        #expect(String(decoding: status, as: UTF8.self).contains(#""admission":"open""#))
        #expect(String(decoding: catalog, as: UTF8.self).contains(#""available":false"#))
    }

    @Test("mission preparation without a grant returns a stable canonical failure")
    func disabledOperation() async throws {
        let (dispatcher, connection) = try await setup()
        let response = try await dispatcher.dispatch(
            Data(#"{"protocolVersion":1,"requestId":"request_1","sessionNonce":"\#(nonce)","operation":"mission.prepare","payload":{"workspaceId":"workspace_1","provider":"codex","prompt":"Fix"}}"#.utf8),
            on: connection, at: now)
        try HostRuntimeResponseCodec.validate(response)
        #expect(String(decoding: response, as: UTF8.self).contains(#""error":"workspace_not_authorized""#))
    }

    @Test("session rejection happens before any operation response")
    func sessionGatePrecedesHandler() async throws {
        let (dispatcher, connection) = try await setup()
        let repeated = request(1, operation: "system.status")
        _ = try await dispatcher.dispatch(repeated, on: connection, at: now)
        await #expect(throws: RuntimeSessionError.replayDetected) {
            try await dispatcher.dispatch(repeated, on: connection, at: self.now)
        }
    }

    @Test("workspace register consumes the matching attachment and list stays beneath the grant")
    func workspaceOperations() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("roundtable-dispatch-workspace-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        try Data("hello".utf8).write(to: root.appendingPathComponent("readme.txt"))
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("Sources", isDirectory: true),
            withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let workspaces = WorkspaceGrantRegistry { _ in
            ResolvedWorkspaceBookmark(url: root, isStale: false,
                                      lease: WorkspaceScopeLease {})
        }
        let sessions = RuntimeSessionRegistry(nonceSource: { nonce })
        let peer = try VerifiedAppPeer(effectiveUserID: 501, auditSessionID: 1,
                                       buildProfile: .development,
                                       codeIdentityDigest: "verified")
        let connection = try await sessions.registerVerifiedConnection(peer: peer)
        let handshake = try HostRuntimeSessionOpenRequest.decodeStrict(Data(
            #"{"protocolVersion":1,"clientNonce":"client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#.utf8))
        _ = try await sessions.openSession(on: connection, request: handshake)
        let dispatcher = RuntimeDispatcher(sessions: sessions, admission: RuntimeAdmission(),
                                           workspaces: workspaces)
        let register = Data(#"{"protocolVersion":1,"requestId":"request_1","sessionNonce":"\#(nonce)","operation":"workspace.register","payload":{"bookmarkTransferId":"bookmark_one","displayName":"Repo"}}"#.utf8)
        let registered = try await dispatcher.dispatch(
            register, on: connection,
            attachment: .init(transferId: "bookmark_one", data: Data([1])), at: now)
        try HostRuntimeResponseCodec.validate(registered)
        let text = String(decoding: registered, as: UTF8.self)
        let expression = try #require(text.range(of: #"workspace_[a-z0-9-]+"#,
                                                 options: .regularExpression))
        let workspaceId = String(text[expression])
        let list = Data(#"{"protocolVersion":1,"requestId":"request_2","sessionNonce":"\#(nonce)","operation":"workspace.list","payload":{"workspaceId":"\#(workspaceId)","relativePath":""}}"#.utf8)
        let listed = try await dispatcher.dispatch(list, on: connection, at: now)
        try HostRuntimeResponseCodec.validate(listed)
        let listedText = String(decoding: listed, as: UTF8.self)
        #expect(listedText.contains(#""name":"readme.txt""#))
        #expect(listedText.contains(#""kind":"directory""#))
    }

    @Test("mission prepare approve get and queued stop revalidate grant and provider")
    func missionOperations() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("roundtable-mission-workspace-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        let binary = root.appendingPathComponent("provider")
        try Data("provider".utf8).write(to: binary)
        #expect(chmod(binary.path, 0o700) == 0)
        defer { try? FileManager.default.removeItem(at: root) }
        let workspaces = WorkspaceGrantRegistry { _ in
            ResolvedWorkspaceBookmark(url: root, isStale: false,
                                      lease: WorkspaceScopeLease {})
        }
        let providers = ProviderRegistry(configuredPaths: [.codex: canonicalPath(binary.path)])
        let sessions = RuntimeSessionRegistry(nonceSource: { nonce })
        let peer = try VerifiedAppPeer(effectiveUserID: 501, auditSessionID: 1,
                                       buildProfile: .development, codeIdentityDigest: "verified")
        let connection = try await sessions.registerVerifiedConnection(peer: peer)
        let handshake = try HostRuntimeSessionOpenRequest.decodeStrict(Data(
            #"{"protocolVersion":1,"clientNonce":"client_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#.utf8))
        _ = try await sessions.openSession(on: connection, request: handshake)
        let dispatcher = RuntimeDispatcher(sessions: sessions, admission: RuntimeAdmission(),
                                           workspaces: workspaces, providers: providers)
        let registered = try await dispatcher.dispatch(
            Data(#"{"protocolVersion":1,"requestId":"request_1","sessionNonce":"\#(nonce)","operation":"workspace.register","payload":{"bookmarkTransferId":"bookmark_one","displayName":"Repo"}}"#.utf8),
            on: connection, attachment: .init(transferId: "bookmark_one", data: Data([1])), at: now)
        let workspaceId = try extractID("workspace_", from: registered)
        let prepared = try await dispatcher.dispatch(
            Data(#"{"protocolVersion":1,"requestId":"request_2","sessionNonce":"\#(nonce)","operation":"mission.prepare","payload":{"workspaceId":"\#(workspaceId)","provider":"codex","prompt":"Build it"}}"#.utf8),
            on: connection, at: now)
        try HostRuntimeResponseCodec.validate(prepared)
        let approvalId = try extractID("approval_", from: prepared)
        let approved = try await dispatcher.dispatch(
            Data(#"{"protocolVersion":1,"requestId":"request_3","sessionNonce":"\#(nonce)","operation":"mission.approve","payload":{"approvalId":"\#(approvalId)"}}"#.utf8),
            on: connection, at: now)
        try HostRuntimeResponseCodec.validate(approved)
        let executionId = try extractID("execution_", from: approved)
        let stopped = try await dispatcher.dispatch(
            Data(#"{"protocolVersion":1,"requestId":"request_4","sessionNonce":"\#(nonce)","operation":"execution.stop","payload":{"executionId":"\#(executionId)"}}"#.utf8),
            on: connection, at: now)
        try HostRuntimeResponseCodec.validate(stopped)
        #expect(String(decoding: stopped, as: UTF8.self).contains(#""state":"stopped""#))
        #expect(String(decoding: stopped, as: UTF8.self).contains(#""treeTermination":"confirmed""#))
    }
}

private func extractID(_ prefix: String, from data: Data) throws -> String {
    let text = String(decoding: data, as: UTF8.self)
    let range = try #require(
        text.range(of: "\(prefix)[a-z0-9-]+", options: .regularExpression),
        "missing \(prefix) in \(text)")
    return String(text[range])
}

private func canonicalPath(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
}
