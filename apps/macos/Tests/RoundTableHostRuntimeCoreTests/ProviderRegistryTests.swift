import Darwin
import Foundation
import Testing
@testable import RoundTableHostRuntimeCore

@Suite("Provider executable registry")
struct ProviderRegistryTests {
    @Test("catalog uses only an explicit safe executable and freezes its fingerprint")
    func explicitFingerprint() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let binary = directory.appendingPathComponent("codex")
        try Data("provider-v1".utf8).write(to: binary)
        #expect(chmod(binary.path, 0o700) == 0)
        let registry = ProviderRegistry(configuredPaths: [.codex: binary.path])
        let catalog = await registry.refresh()
        #expect(catalog.count == 3)
        #expect(catalog.first(where: { $0.provider == .codex })?.available == true)
        #expect(catalog.first(where: { $0.provider == .claudeCode })?.available == false)
        let frozen = try await registry.requireUnchanged(.codex)
        #expect(frozen.sha256.count == 64 && frozen.canonicalPath == binary.path)

        try Data("provider-v2".utf8).write(to: binary)
        #expect(chmod(binary.path, 0o700) == 0)
        await #expect(throws: ProviderRegistryError.executableChanged) {
            try await registry.requireUnchanged(.codex)
        }
    }

    @Test("symlink and writable executables remain unavailable")
    func unsafeExecutables() async throws {
        let directory = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let binary = directory.appendingPathComponent("real")
        let link = directory.appendingPathComponent("linked")
        try Data("provider".utf8).write(to: binary)
        #expect(chmod(binary.path, 0o722) == 0)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: binary)
        let registry = ProviderRegistry(configuredPaths: [.codex: binary.path, .opencode: link.path])
        let catalog = await registry.refresh()
        #expect(catalog.allSatisfy { !$0.available })
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("roundtable-provider-\(UUID())", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        return URL(fileURLWithPath: canonical(url.path), isDirectory: true)
    }
}

private func canonical(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
}
