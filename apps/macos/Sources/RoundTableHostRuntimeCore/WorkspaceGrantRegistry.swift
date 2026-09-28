import Darwin
import Foundation
import OSLog

public struct WorkspaceGrant: Equatable, Sendable {
    public let workspaceId: String
    public let displayName: String
    public let canonicalRoot: String
    public let device: UInt64
    public let inode: UInt64
    public let generation: UInt64
    public let owner: RuntimeSessionOwner
}

public struct WorkspaceDirectoryEntry: Equatable, Sendable {
    public let name: String
    public let relativePath: String
    public let kind: String
}

public struct WorkspaceDirectoryListing: Equatable, Sendable {
    public let grant: WorkspaceGrant
    public let relativePath: String
    public let entries: [WorkspaceDirectoryEntry]
    public let truncated: Bool
}

public enum WorkspaceGrantError: String, Error, Equatable, Sendable {
    case invalidDisplayName = "workspace_display_name_invalid"
    case invalidRoot = "workspace_root_invalid"
    case rootNotDirectory = "workspace_root_not_directory"
    case rootIsSymbolicLink = "workspace_root_symbolic_link"
    case identityChanged = "workspace_identity_changed"
    case notAuthorized = "workspace_not_authorized"
    case invalidTransfer = "workspace_transfer_invalid"
    case transferAlreadyConsumed = "workspace_transfer_consumed"
    case bookmarkStale = "workspace_bookmark_stale"
    case scopeDenied = "workspace_scope_denied"
    case invalidRelativePath = "workspace_relative_path_invalid"
    case listFailed = "workspace_list_failed"
}

public final class WorkspaceScopeLease: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    private let stop: @Sendable () -> Void

    public init(stop: @escaping @Sendable () -> Void) { self.stop = stop }
    public func invalidate() {
        lock.lock()
        let shouldStop = active
        active = false
        lock.unlock()
        if shouldStop { stop() }
    }
    deinit { invalidate() }
}

public struct ResolvedWorkspaceBookmark: @unchecked Sendable {
    public let url: URL
    public let isStale: Bool
    public let lease: WorkspaceScopeLease

    public init(url: URL, isStale: Bool, lease: WorkspaceScopeLease) {
        self.url = url
        self.isStale = isStale
        self.lease = lease
    }
}

/// Owns the stable identity portion of a workspace capability. The live XPC
/// boundary must resolve and retain a security-scoped bookmark before calling
/// registerResolvedDirectory; an ordinary path string is not a grant.
public actor WorkspaceGrantRegistry {
    public typealias BookmarkResolver = @Sendable (Data) throws -> ResolvedWorkspaceBookmark
    private struct StoredGrant: Sendable {
        let grant: WorkspaceGrant
        let lease: WorkspaceScopeLease?
    }

    private var grants: [String: StoredGrant] = [:]
    private var consumedTransfers: [RuntimeSessionOwner: Set<String>] = [:]
    private var nextGeneration: UInt64 = 1
    private let bookmarkResolver: BookmarkResolver

    public init(bookmarkResolver: @escaping BookmarkResolver = WorkspaceGrantRegistry.resolveBookmark) {
        self.bookmarkResolver = bookmarkResolver
    }

    public func registerBookmark(transferId: String, data: Data, displayName: String,
                                 owner: RuntimeSessionOwner) throws -> WorkspaceGrant {
        guard transferId.range(of: "^bookmark_[A-Za-z0-9._:-]{1,119}$",
                               options: .regularExpression) != nil,
              !data.isEmpty, data.count <= 1_048_576 else {
            throw WorkspaceGrantError.invalidTransfer
        }
        guard consumedTransfers[owner, default: []].insert(transferId).inserted else {
            throw WorkspaceGrantError.transferAlreadyConsumed
        }
        let resolved = try bookmarkResolver(data)
        guard !resolved.isStale else {
            resolved.lease.invalidate()
            throw WorkspaceGrantError.bookmarkStale
        }
        do {
            return try registerResolvedDirectory(resolved.url, displayName: displayName,
                                                 owner: owner, lease: resolved.lease)
        } catch {
            resolved.lease.invalidate()
            throw error
        }
    }

    func registerResolvedDirectory(_ url: URL, displayName: String,
                                   owner: RuntimeSessionOwner,
                                   lease: WorkspaceScopeLease? = nil) throws -> WorkspaceGrant {
        let name = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf8.count <= 255, !name.contains("\n"), !name.contains("\r") else {
            throw WorkspaceGrantError.invalidDisplayName
        }
        let identity = try Self.capture(url)
        guard nextGeneration != UInt64.max else { throw WorkspaceGrantError.identityChanged }
        let grant = WorkspaceGrant(
            workspaceId: "workspace_\(UUID().uuidString.lowercased())",
            displayName: name, canonicalRoot: identity.root,
            device: identity.device, inode: identity.inode,
            generation: nextGeneration, owner: owner)
        nextGeneration += 1
        grants[grant.workspaceId] = StoredGrant(grant: grant, lease: lease)
        return grant
    }

    public func resolve(_ workspaceId: String, owner: RuntimeSessionOwner) throws -> WorkspaceGrant {
        guard let stored = grants[workspaceId], stored.grant.owner == owner else {
            throw WorkspaceGrantError.notAuthorized
        }
        let grant = stored.grant
        let current = try Self.capture(URL(fileURLWithPath: grant.canonicalRoot, isDirectory: true))
        guard current.root == grant.canonicalRoot, current.device == grant.device,
              current.inode == grant.inode else { throw WorkspaceGrantError.identityChanged }
        return grant
    }

    public func revokeOwned(by owner: RuntimeSessionOwner) {
        let revoked = grants.values.filter { $0.grant.owner == owner }
        grants = grants.filter { $0.value.grant.owner != owner }
        consumedTransfers.removeValue(forKey: owner)
        revoked.forEach { $0.lease?.invalidate() }
    }

    public func list(_ workspaceId: String, relativePath: String,
                     owner: RuntimeSessionOwner, limit: Int = 500) throws -> WorkspaceDirectoryListing {
        let grant = try resolve(workspaceId, owner: owner)
        let components = try Self.relativeComponents(relativePath)
        var descriptor = open(grant.canonicalRoot, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard descriptor >= 0 else { throw WorkspaceGrantError.listFailed }
        defer { close(descriptor) }
        var rootInfo = stat()
        guard fstat(descriptor, &rootInfo) == 0,
              UInt64(rootInfo.st_dev) == grant.device,
              UInt64(rootInfo.st_ino) == grant.inode else {
            throw WorkspaceGrantError.identityChanged
        }
        for component in components {
            let next = component.withCString {
                openat(descriptor, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            guard next >= 0 else { throw WorkspaceGrantError.listFailed }
            var childInfo = stat()
            guard fstat(next, &childInfo) == 0,
                  UInt64(childInfo.st_dev) == grant.device else {
                close(next)
                throw WorkspaceGrantError.identityChanged
            }
            close(descriptor)
            descriptor = next
        }
        guard let directory = fdopendir(dup(descriptor)) else { throw WorkspaceGrantError.listFailed }
        defer { closedir(directory) }
        var entries: [WorkspaceDirectoryEntry] = []
        while let item = readdir(directory) {
            let name = withUnsafePointer(to: &item.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(MAXNAMLEN) + 1) {
                    String(cString: $0)
                }
            }
            if name == "." || name == ".." { continue }
            guard Self.validComponent(name) else { throw WorkspaceGrantError.listFailed }
            var info = stat()
            let result = name.withCString { fstatat(descriptor, $0, &info, AT_SYMLINK_NOFOLLOW) }
            guard result == 0 else { throw WorkspaceGrantError.listFailed }
            let type = info.st_mode & S_IFMT
            let kind: String
            switch type {
            case S_IFDIR: kind = "directory"
            case S_IFREG: kind = "file"
            case S_IFLNK: kind = "symlink"
            default: kind = "other"
            }
            entries.append(.init(name: name,
                                 relativePath: relativePath.isEmpty ? name : "\(relativePath)/\(name)",
                                 kind: kind))
        }
        entries.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        let boundedLimit = min(500, max(1, limit))
        return WorkspaceDirectoryListing(grant: grant, relativePath: relativePath,
                                         entries: Array(entries.prefix(boundedLimit)),
                                         truncated: entries.count > boundedLimit)
    }

    public nonisolated static func resolveBookmark(_ data: Data) throws -> ResolvedWorkspaceBookmark {
        var stale = false
        let url: URL
        do {
            url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope],
                          relativeTo: nil, bookmarkDataIsStale: &stale)
        } catch {
            Logger(subsystem: "com.roundtable.desktop.host-runtime",
                   category: "workspace-bookmark")
                .error("bookmark resolution failed: \(String(describing: error), privacy: .public)")
            throw WorkspaceGrantError.invalidTransfer
        }
        guard url.startAccessingSecurityScopedResource() else {
            throw WorkspaceGrantError.scopeDenied
        }
        return ResolvedWorkspaceBookmark(
            url: url, isStale: stale,
            lease: WorkspaceScopeLease { url.stopAccessingSecurityScopedResource() })
    }

    private static func capture(_ url: URL) throws -> (root: String, device: UInt64, inode: UInt64) {
        guard url.isFileURL, url.path.hasPrefix("/") else { throw WorkspaceGrantError.invalidRoot }
        var linkInfo = stat()
        guard lstat(url.path, &linkInfo) == 0 else { throw WorkspaceGrantError.invalidRoot }
        guard (linkInfo.st_mode & S_IFMT) != S_IFLNK else {
            throw WorkspaceGrantError.rootIsSymbolicLink
        }
        guard (linkInfo.st_mode & S_IFMT) == S_IFDIR else {
            throw WorkspaceGrantError.rootNotDirectory
        }
        guard let resolved = realpath(url.path, nil) else { throw WorkspaceGrantError.invalidRoot }
        defer { free(resolved) }
        let root = String(cString: resolved)
        var info = stat()
        guard stat(root, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
            throw WorkspaceGrantError.invalidRoot
        }
        return (root, UInt64(info.st_dev), UInt64(info.st_ino))
    }

    private static func relativeComponents(_ path: String) throws -> [String] {
        guard path.utf8.count <= 512, !path.hasPrefix("/"), !path.contains("\\"),
              !path.contains(":"),
              !path.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) else {
            throw WorkspaceGrantError.invalidRelativePath
        }
        if path.isEmpty { return [] }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.allSatisfy(validComponent) else { throw WorkspaceGrantError.invalidRelativePath }
        return parts
    }

    private static func validComponent(_ value: String) -> Bool {
        !value.isEmpty && value != "." && value != ".." && value.utf8.count <= 255
            && !value.contains("/") && !value.contains("\\") && !value.contains(":")
            && !value.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f })
    }
}
