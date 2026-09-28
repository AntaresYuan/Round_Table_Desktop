import CryptoKit
import Darwin
import Foundation

public struct ProviderExecutableFingerprint: Equatable, Sendable {
    public let provider: RuntimeProvider
    public let canonicalPath: String
    public let device: UInt64
    public let inode: UInt64
    public let size: UInt64
    public let sha256: String
}

public struct ProviderCatalogEntry: Equatable, Sendable {
    public let provider: RuntimeProvider
    public let label: String
    public let available: Bool
    public let version: String?
    public let installHint: String
    public let adapterVersion: String
    public let fingerprint: ProviderExecutableFingerprint?
    public let warnings: [String]
}

public enum ProviderRegistryError: String, Error, Equatable, Sendable {
    case pathNotConfigured = "provider_path_not_configured"
    case pathInvalid = "provider_path_invalid"
    case executableUnsafe = "provider_executable_unsafe"
    case executableChanged = "provider_executable_changed"
}

/// Provider discovery is intentionally configuration-driven. It never consults
/// PATH, shell startup files, aliases or a provider-reported executable path.
public actor ProviderRegistry {
    private var configuredPaths: [RuntimeProvider: String]
    private var fingerprints: [RuntimeProvider: ProviderExecutableFingerprint] = [:]

    public init(configuredPaths: [RuntimeProvider: String] = [:]) {
        self.configuredPaths = configuredPaths
    }

    public func refresh() -> [ProviderCatalogEntry] {
        RuntimeProvider.allCases.map { provider in
            guard let path = configuredPaths[provider] else {
                fingerprints.removeValue(forKey: provider)
                return Self.unavailable(provider, reason: "Choose an explicit provider executable.")
            }
            do {
                let fingerprint = try Self.fingerprint(provider: provider, path: path)
                fingerprints[provider] = fingerprint
                return ProviderCatalogEntry(
                    provider: provider, label: Self.label(provider), available: true,
                    version: nil, installHint: "Configured by the user.",
                    adapterVersion: "\(provider.rawValue)-v1", fingerprint: fingerprint,
                    warnings: [])
            } catch {
                fingerprints.removeValue(forKey: provider)
                return Self.unavailable(provider, reason: "Configured executable failed validation.")
            }
        }
    }

    public func requireUnchanged(_ provider: RuntimeProvider) throws -> ProviderExecutableFingerprint {
        guard let expected = fingerprints[provider] else {
            throw ProviderRegistryError.pathNotConfigured
        }
        let current = try Self.fingerprint(provider: provider, path: expected.canonicalPath)
        guard current == expected else { throw ProviderRegistryError.executableChanged }
        return current
    }

    private static func fingerprint(provider: RuntimeProvider,
                                    path: String) throws -> ProviderExecutableFingerprint {
        guard path.hasPrefix("/"), path.utf8.count <= 4_096 else {
            throw ProviderRegistryError.pathInvalid
        }
        var beforeLink = stat()
        guard lstat(path, &beforeLink) == 0,
              (beforeLink.st_mode & S_IFMT) == S_IFREG else {
            throw ProviderRegistryError.executableUnsafe
        }
        guard let resolved = realpath(path, nil) else { throw ProviderRegistryError.pathInvalid }
        defer { free(resolved) }
        let canonical = String(cString: resolved)
        guard canonical == path else { throw ProviderRegistryError.executableUnsafe }
        var before = stat()
        guard stat(canonical, &before) == 0,
              (before.st_mode & S_IFMT) == S_IFREG,
              before.st_mode & 0o111 != 0,
              before.st_mode & 0o022 == 0,
              before.st_size >= 0 else {
            throw ProviderRegistryError.executableUnsafe
        }
        let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: canonical))
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 64 * 1_024), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        var after = stat()
        guard stat(canonical, &after) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino,
              before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
              before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else {
            throw ProviderRegistryError.executableChanged
        }
        let digest = hasher.finalize().map { String(format: "%02x", $0) }.joined()
        return ProviderExecutableFingerprint(
            provider: provider, canonicalPath: canonical,
            device: UInt64(after.st_dev), inode: UInt64(after.st_ino),
            size: UInt64(after.st_size), sha256: digest)
    }

    private static func unavailable(_ provider: RuntimeProvider, reason: String) -> ProviderCatalogEntry {
        ProviderCatalogEntry(provider: provider, label: label(provider), available: false,
                             version: nil, installHint: reason,
                             adapterVersion: "\(provider.rawValue)-v1", fingerprint: nil,
                             warnings: ["Execution remains unavailable."])
    }

    private static func label(_ provider: RuntimeProvider) -> String {
        switch provider {
        case .codex: "Codex"
        case .claudeCode: "Claude Code"
        case .opencode: "OpenCode"
        }
    }
}
