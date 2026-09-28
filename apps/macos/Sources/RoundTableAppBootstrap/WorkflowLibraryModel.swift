#if SWIFT_PACKAGE
import RoundTableScene
#endif
import Foundation
import SwiftUI

/// Owns the workflow library and the template being edited. Edits live in
/// `draft` until Save, the way the Web's editor keeps a working copy; the
/// difference is that here the rules are checked before a save is allowed.
@MainActor
final class WorkflowLibraryModel: ObservableObject {
    @Published private(set) var library: WorkflowLibrary
    /// The template the editor is showing, with unsaved edits applied.
    @Published var draft: WorkflowTemplate
    @Published private(set) var loadError: String?
    /// Set briefly after a save so the button can confirm it.
    @Published private(set) var justSaved = false

    private let store: WorkflowStore
    private var saveConfirmation: Task<Void, Never>?

    init(bundle: Bundle = .main, directory: URL = WorkflowStore.defaultDirectory()) {
        var builtins: [WorkflowTemplate] = []
        if let url = bundle.url(forResource: "workflow-builtins", withExtension: "json"),
           let decoded = try? WorkflowBuiltins.decode(Data(contentsOf: url)) {
            builtins = decoded
        }
        store = WorkflowStore(directory: directory, builtins: builtins)
        library = store.load()
        draft = store.load().active ?? WorkflowEditor.newTemplate()
        if builtins.isEmpty { loadError = "Built-in workflows are not bundled." }
    }

    var templates: [WorkflowTemplate] { library.templates }
    /// The stages that can be dragged into a workflow, from the built-ins.
    lazy var presets: [WorkflowEditor.StagePreset] = WorkflowEditor.presets(from: library.builtins)
    func preset(id: String) -> WorkflowEditor.StagePreset? { presets.first { $0.id == id } }
    var builtins: [WorkflowTemplate] { library.builtins }
    var userTemplates: [WorkflowTemplate] { library.userTemplates }
    var isUserSaved: Bool { library.isUserSaved(draft.id) }
    /// True while the draft differs from what is stored.
    var isDirty: Bool { library.template(id: draft.id) != draft }
    var problems: [WorkflowProblem] { WorkflowValidation.problems(in: draft, agents: MissionReplayModel.agents) }
    var canSave: Bool { problems.isEmpty && (isDirty || draft.builtin == true) }

    /// Switching drops unsaved edits, as on the Web. The UI warns first.
    func select(_ id: String) {
        guard let template = library.template(id: id) else { return }
        draft = template
        library.setActive(id)
        persist()
    }

    func edit(_ change: (WorkflowTemplate) -> WorkflowTemplate) {
        draft = change(draft)
    }

    func newTemplate() {
        let template = WorkflowEditor.newTemplate()
        library.save(template)
        draft = template
        persist()
    }

    /// Saving a built-in forks it; saving a user template updates it in place.
    func save() {
        guard problems.isEmpty else { return }
        let saved = WorkflowEditor.saved(draft, name: draft.name)
        library.save(saved)
        draft = saved
        persist()
        justSaved = true
        saveConfirmation?.cancel()
        saveConfirmation = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2.6))
            guard !Task.isCancelled else { return }
            self?.justSaved = false
        }
    }

    /// Drops the user's copy so the built-in resurfaces.
    func revertToBuiltin() {
        let id = draft.id
        library.revert(id: id)
        draft = library.template(id: id) ?? library.active ?? draft
        persist()
    }

    private func persist() {
        if !store.save(library) { loadError = "Could not write workflows.json." }
    }

    var storeLocation: String { store.fileURL.path }
}
