import Foundation

// Where workflow templates live on the desktop. The Web has two stores (server
// rows when signed in, `localStorage["rt.workflows"]` otherwise); the desktop
// has one: built-ins from the bundled resource, plus the user's own templates
// in Application Support. Editing is local authoring — running them still needs
// the Host Runtime.

public struct WorkflowBuiltins: Codable, Equatable, Sendable {
    public var format: String
    public var version: Int
    public var templates: [WorkflowTemplate]

    public static func decode(_ data: Data) throws -> [WorkflowTemplate] {
        let file = try JSONDecoder().decode(WorkflowBuiltins.self, from: data)
        guard file.format == "roundtable.workflow-builtins", file.version == 1 else {
            throw WorkflowLibraryError.unsupported(format: file.format, version: file.version)
        }
        return file.templates
    }
}

public enum WorkflowLibraryError: Error, Equatable {
    case unsupported(format: String, version: Int)
}

/// The user's own templates, as written to disk.
struct WorkflowLibraryFile: Codable, Equatable {
    var format = "roundtable.workflows"
    var version = 1
    var activeId: String?
    var templates: [WorkflowTemplate]
}

/// Built-ins merged with the user's templates, and the file that holds them.
/// A user template with a built-in's id overrides it, as on the Web and the
/// server; anything else is appended.
public struct WorkflowLibrary: Equatable, Sendable {
    public private(set) var builtins: [WorkflowTemplate]
    public private(set) var userTemplates: [WorkflowTemplate]
    /// The workflow the workbench would run, when the user has chosen one.
    public private(set) var activeId: String?

    public init(builtins: [WorkflowTemplate], userTemplates: [WorkflowTemplate] = [], activeId: String? = nil) {
        self.builtins = builtins
        self.userTemplates = userTemplates
        self.activeId = activeId
    }

    /// Built-ins first (overridden where the user saved over one), then the
    /// user's own templates.
    public var templates: [WorkflowTemplate] {
        let overridden = builtins.map { builtin in
            userTemplates.first { $0.id == builtin.id } ?? builtin
        }
        let extras = userTemplates.filter { template in
            !builtins.contains { $0.id == template.id }
        }
        return overridden + extras
    }

    public var active: WorkflowTemplate? {
        if let activeId, let match = templates.first(where: { $0.id == activeId }) { return match }
        return templates.first
    }

    public func template(id: String) -> WorkflowTemplate? {
        templates.first { $0.id == id }
    }

    public func isUserSaved(_ id: String) -> Bool {
        userTemplates.contains { $0.id == id }
    }

    public mutating func setActive(_ id: String) {
        guard template(id: id) != nil else { return }
        activeId = id
    }

    /// Saves a template: replaces the user's copy with the same id, else adds it.
    public mutating func save(_ template: WorkflowTemplate) {
        if let index = userTemplates.firstIndex(where: { $0.id == template.id }) {
            userTemplates[index] = template
        } else {
            userTemplates.append(template)
        }
        activeId = template.id
    }

    /// Drops the user's copy. A built-in id then falls back to the built-in;
    /// removing a template that only exists here moves to the first built-in.
    public mutating func revert(id: String) {
        userTemplates.removeAll { $0.id == id }
        if activeId == id, template(id: id) == nil { activeId = builtins.first?.id }
    }
}

/// Reads and writes the library. Injecting the directory keeps it testable and
/// keeps the app out of anything but its own Application Support folder.
public struct WorkflowStore: Sendable {
    public let directory: URL
    private let builtins: [WorkflowTemplate]

    public var fileURL: URL { directory.appendingPathComponent("workflows.json") }

    public init(directory: URL, builtins: [WorkflowTemplate]) {
        self.directory = directory
        self.builtins = builtins
    }

    /// `~/Library/Application Support/com.roundtable.desktop`.
    public static func defaultDirectory(bundleId: String = "com.roundtable.desktop") -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent(bundleId, isDirectory: true)
    }

    /// Missing or unreadable files start an empty library rather than failing:
    /// a broken file must not cost the user the built-ins.
    public func load() -> WorkflowLibrary {
        guard let data = try? Data(contentsOf: fileURL),
              let file = try? JSONDecoder().decode(WorkflowLibraryFile.self, from: data),
              file.format == "roundtable.workflows", file.version == 1 else {
            return WorkflowLibrary(builtins: builtins)
        }
        return WorkflowLibrary(builtins: builtins, userTemplates: file.templates, activeId: file.activeId)
    }

    @discardableResult
    public func save(_ library: WorkflowLibrary) -> Bool {
        let file = WorkflowLibraryFile(activeId: library.activeId, templates: library.userTemplates)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(file) else { return false }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: fileURL, options: .atomic)
            return true
        } catch {
            return false
        }
    }
}
