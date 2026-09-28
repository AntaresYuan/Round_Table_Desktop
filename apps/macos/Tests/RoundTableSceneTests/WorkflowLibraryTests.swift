import Foundation
import Testing
@testable import RoundTableScene

@Suite("Workflow library")
struct WorkflowLibraryTests {
    static let builtinsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("Resources/workflow-builtins.json")

    private func builtins() throws -> [WorkflowTemplate] {
        try WorkflowBuiltins.decode(Data(contentsOf: Self.builtinsURL))
    }

    private func temporaryStore(_ builtins: [WorkflowTemplate]) -> WorkflowStore {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("rt-workflows-\(UUID().uuidString)", isDirectory: true)
        return WorkflowStore(directory: directory, builtins: builtins)
    }

    @Test("the bundled built-ins are the server's templates and all validate")
    func builtinsAreUsable() throws {
        let templates = try builtins()
        #expect(templates.map(\.id) == ["wf-feature-builder", "wf-bug-fixer", "wf-codebase-onboarding"])
        #expect(templates.map { $0.stages.count } == [7, 5, 4])
        let (_, golden) = try TurnFixtures.load("feature-builder-local-dispatch")
        let agents = AgentRoster(golden.agents)
        for template in templates {
            #expect(template.builtin == true)
            #expect(WorkflowValidation.problems(in: template, agents: agents).isEmpty)
        }
    }

    @Test("the bundled Feature Builder matches the one the recorded mission ran")
    func matchesRecordedTemplate() throws {
        let recorded = try #require(TurnFixtures.load("feature-builder-local-dispatch").0.frames.first?.turn.workflow)
        let bundled = try #require(builtins().first { $0.id == recorded.id })
        #expect(bundled == recorded)
    }

    @Test("a user template overrides the built-in with the same id, others are appended")
    func merging() throws {
        var library = WorkflowLibrary(builtins: try builtins())
        #expect(library.templates.count == 3)
        #expect(library.active?.id == "wf-feature-builder")

        var edited = try #require(library.template(id: "wf-bug-fixer"))
        edited.name = "Bug Fixer (ours)"
        edited.builtin = false
        library.save(edited)
        #expect(library.templates.count == 3)
        #expect(library.template(id: "wf-bug-fixer")?.name == "Bug Fixer (ours)")
        #expect(library.isUserSaved("wf-bug-fixer"))
        #expect(library.active?.id == "wf-bug-fixer")

        let fresh = WorkflowEditor.newTemplate(id: "wf-user-1")
        library.save(fresh)
        #expect(library.templates.map(\.id) == ["wf-feature-builder", "wf-bug-fixer", "wf-codebase-onboarding", "wf-user-1"])

        library.revert(id: "wf-bug-fixer")
        #expect(library.template(id: "wf-bug-fixer")?.name == "Bug Fixer")
        #expect(!library.isUserSaved("wf-bug-fixer"))

        library.setActive("wf-user-1")
        library.revert(id: "wf-user-1")
        #expect(library.templates.count == 3 && library.active?.id == "wf-feature-builder")
    }

    @Test("only the user's templates are written, and they survive a reload")
    func persistence() throws {
        let store = temporaryStore(try builtins())
        defer { try? FileManager.default.removeItem(at: store.directory) }

        var library = store.load()
        #expect(library.userTemplates.isEmpty)
        let mine = WorkflowEditor.saved(try #require(library.template(id: "wf-feature-builder")),
                                        name: "My flow", forkId: "wf-user-mine")
        library.save(mine)
        #expect(store.save(library))

        let written = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: store.fileURL)) as? [String: Any])
        #expect(written["activeId"] as? String == "wf-user-mine")
        #expect((written["templates"] as? [[String: Any]])?.count == 1)

        let reloaded = store.load()
        #expect(reloaded.templates.map(\.id).last == "wf-user-mine")
        #expect(reloaded.active?.name == "My flow")
        #expect(reloaded.template(id: "wf-user-mine") == mine)
    }

    @Test("a corrupt file loses the user's templates, never the built-ins")
    func corruptFile() throws {
        let store = temporaryStore(try builtins())
        defer { try? FileManager.default.removeItem(at: store.directory) }
        try FileManager.default.createDirectory(at: store.directory, withIntermediateDirectories: true)
        try Data("{ not json".utf8).write(to: store.fileURL)
        let library = store.load()
        #expect(library.templates.count == 3 && library.userTemplates.isEmpty)
    }
}
