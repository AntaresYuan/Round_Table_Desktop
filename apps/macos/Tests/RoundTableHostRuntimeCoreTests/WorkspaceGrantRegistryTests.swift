import Darwin
import Foundation
import Testing
@testable import RoundTableHostRuntimeCore

@Suite("Workspace grant identity")
struct WorkspaceGrantRegistryTests {
    private func owner(_ generation: UInt64 = 1) throws -> RuntimeSessionOwner {
        try RuntimeSessionOwner(connectionGeneration: generation,
                                sessionNonce: "session_0123456789abcdef0123456789abcdef")
    }

    @Test("grant binds canonical device inode generation and owner")
    func stableIdentity() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("roundtable-workspace-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let registry = WorkspaceGrantRegistry()
        let session = try owner()
        let grant = try await registry.registerResolvedDirectory(root, displayName: " Repo ", owner: session)
        #expect(grant.displayName == "Repo")
        #expect(grant.canonicalRoot == canonical(root.path))
        #expect(grant.device > 0 && grant.inode > 0 && grant.generation == 1)
        #expect(try await registry.resolve(grant.workspaceId, owner: session) == grant)
        await #expect(throws: WorkspaceGrantError.notAuthorized) {
            try await registry.resolve(grant.workspaceId, owner: self.owner(2))
        }
    }

    @Test("replacement at the same path is rejected")
    func replacementFailsClosed() async throws {
        let parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("roundtable-parent-\(UUID())", isDirectory: true)
        let root = parent.appendingPathComponent("repo", isDirectory: true)
        let moved = parent.appendingPathComponent("old", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: parent) }
        let registry = WorkspaceGrantRegistry()
        let session = try owner()
        let grant = try await registry.registerResolvedDirectory(root, displayName: "Repo", owner: session)
        try FileManager.default.moveItem(at: root, to: moved)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        await #expect(throws: WorkspaceGrantError.identityChanged) {
            try await registry.resolve(grant.workspaceId, owner: session)
        }
    }

    @Test("symlink and non-directory roots are refused")
    func unsafeRootsRejected() async throws {
        let parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("roundtable-unsafe-\(UUID())", isDirectory: true)
        let directory = parent.appendingPathComponent("directory", isDirectory: true)
        let link = parent.appendingPathComponent("link", isDirectory: true)
        let file = parent.appendingPathComponent("file")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: directory)
        try Data().write(to: file)
        defer { try? FileManager.default.removeItem(at: parent) }
        let registry = WorkspaceGrantRegistry()
        let session = try owner()
        await #expect(throws: WorkspaceGrantError.rootIsSymbolicLink) {
            try await registry.registerResolvedDirectory(link, displayName: "Link", owner: session)
        }
        await #expect(throws: WorkspaceGrantError.rootNotDirectory) {
            try await registry.registerResolvedDirectory(file, displayName: "File", owner: session)
        }
    }

    @Test("bookmark transfer is single-use and scope lives until owner revocation")
    func bookmarkLifetime() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("roundtable-bookmark-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        let counter = StopCounter()
        let registry = WorkspaceGrantRegistry { data in
            #expect(data == Data("bookmark".utf8))
            return ResolvedWorkspaceBookmark(
                url: root, isStale: false,
                lease: WorkspaceScopeLease { counter.increment() })
        }
        let session = try owner()
        let grant = try await registry.registerBookmark(
            transferId: "bookmark_one", data: Data("bookmark".utf8),
            displayName: "Repo", owner: session)
        #expect(try await registry.resolve(grant.workspaceId, owner: session) == grant)
        #expect(counter.value == 0)
        await #expect(throws: WorkspaceGrantError.transferAlreadyConsumed) {
            try await registry.registerBookmark(
                transferId: "bookmark_one", data: Data("bookmark".utf8),
                displayName: "Repo", owner: session)
        }
        await registry.revokeOwned(by: session)
        #expect(counter.value == 1)
        await #expect(throws: WorkspaceGrantError.notAuthorized) {
            try await registry.resolve(grant.workspaceId, owner: session)
        }
    }

    @Test("stale bookmarks fail closed and release their scope")
    func staleBookmark() async throws {
        let counter = StopCounter()
        let registry = WorkspaceGrantRegistry { _ in
            ResolvedWorkspaceBookmark(
                url: URL(fileURLWithPath: "/tmp", isDirectory: true), isStale: true,
                lease: WorkspaceScopeLease { counter.increment() })
        }
        await #expect(throws: WorkspaceGrantError.bookmarkStale) {
            try await registry.registerBookmark(
                transferId: "bookmark_stale", data: Data([1]),
                displayName: "Repo", owner: self.owner())
        }
        #expect(counter.value == 1)
    }

    @Test("listing is fd-relative, bounded, and never traverses a symlink")
    func safeListing() async throws {
        let parent = FileManager.default.temporaryDirectory
            .appendingPathComponent("roundtable-list-\(UUID())", isDirectory: true)
        let root = parent.appendingPathComponent("repo", isDirectory: true)
        let child = root.appendingPathComponent("child", isDirectory: true)
        let outside = parent.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        try Data("a".utf8).write(to: root.appendingPathComponent("a.txt"))
        try Data("b".utf8).write(to: root.appendingPathComponent("b.txt"))
        try FileManager.default.createSymbolicLink(
            at: root.appendingPathComponent("escape"), withDestinationURL: outside)
        defer { try? FileManager.default.removeItem(at: parent) }
        let registry = WorkspaceGrantRegistry()
        let session = try owner()
        let grant = try await registry.registerResolvedDirectory(root, displayName: "Repo", owner: session)
        let listing = try await registry.list(grant.workspaceId, relativePath: "", owner: session,
                                              limit: 2)
        #expect(listing.entries.count == 2)
        #expect(listing.truncated)
        let full = try await registry.list(grant.workspaceId, relativePath: "", owner: session)
        #expect(full.entries.first(where: { $0.name == "escape" })?.kind == "symlink")
        await #expect(throws: WorkspaceGrantError.listFailed) {
            try await registry.list(grant.workspaceId, relativePath: "escape", owner: session)
        }
        await #expect(throws: WorkspaceGrantError.invalidRelativePath) {
            try await registry.list(grant.workspaceId, relativePath: "../outside", owner: session)
        }
    }
}

private final class StopCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.withLock { count } }
    func increment() { lock.withLock { count += 1 } }
}

private func canonical(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
}
