#if SWIFT_PACKAGE
import RoundTableScene
#endif
import SwiftUI

// The Workflow page: the native port of the Web editor
// (src/ui/components/workflow.jsx). Differences, all deliberate:
//   * every gate the orchestrator understands can be set (the Web offers three
//     and silently downgrades the rest);
//   * the template is checked before it can be saved, instead of failing on the
//     server afterwards;
//   * templates are saved to this machine, not to an account.

struct WorkflowEditorView: View {
    @ObservedObject var model: WorkflowLibraryModel
    let agents: AgentRoster
    /// The workflow id the replayed mission is running, when one is.
    var runningId: String?

    @State private var showingPicker = false
    @State private var configuring: Int?
    /// The connector a dragged preset is currently over.
    @State private var dropTarget: Int?
    /// The connector whose "add a stage" menu is open.
    @State private var addingAt: Int?
    #if DEBUG
    /// Screenshot runs cannot click: opens one stage's Configure popover.
    private let debugConfigureStage = ProcessInfo.processInfo.environment["ROUNDTABLE_DEBUG_CONFIGURE"]
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            // The flow itself stays at the top; the shelf below it scrolls.
            VStack(alignment: .leading, spacing: 14) {
                activeBar
                if !model.problems.isEmpty { problemsBanner }
                stageRow
            }
            .padding(.horizontal, 28).padding(.top, 4)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    palette
                    footer
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 28).padding(.top, 16).padding(.bottom, 20)
            }
        }
        .background(RT.bg)
        .accessibilityIdentifier("workflow.page")
        #if DEBUG
        .onAppear {
            if let id = debugConfigureStage, let index = model.draft.stages.firstIndex(where: { $0.id == id }) {
                configuring = index
            }
        }
        #endif
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Workflow").font(RT.ui(22, weight: .semibold)).foregroundStyle(RT.text)
                    .accessibilityAddTraits(.isHeader)
                (Text("A workflow is the ") + Text("packaged process").bold()
                    + Text(" your workbench runs every time. Edit the stages, who sits in them and where it pauses."))
                    .font(RT.ui(13)).foregroundStyle(RT.textMuted).lineSpacing(3)
                    .frame(maxWidth: 520, alignment: .leading)
            }
            Spacer(minLength: 0)
            HStack(spacing: 8) {
                Button { showingPicker.toggle() } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "square.3.layers.3d").font(RT.ui(11))
                        Text("Switch").font(RT.ui(12, weight: .medium))
                        Image(systemName: "chevron.down").font(RT.ui(9, weight: .semibold))
                    }
                    .foregroundStyle(RT.textMuted)
                    .padding(.horizontal, 12).frame(height: 32)
                    .background(RT.surface, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.border))
                }
                .buttonStyle(.plain)
                .popover(isPresented: $showingPicker, arrowEdge: .bottom) { picker }
                .accessibilityIdentifier("workflow.switch")

                Button(action: model.save) {
                    HStack(spacing: 7) {
                        Image(systemName: model.justSaved ? "checkmark" : "tray.and.arrow.down").font(RT.ui(11))
                        Text(model.justSaved ? "Saved" : model.draft.builtin == true ? "Save as your own" : "Save")
                            .font(RT.ui(12, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 13).frame(height: 32)
                    .background(model.canSave ? (model.justSaved ? RT.ok : RT.accent) : RT.accent.opacity(0.35),
                                in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(!model.canSave)
                .help(model.problems.isEmpty ? "Writes this workflow to this machine"
                      : "Fix what is listed above before saving")
                .accessibilityIdentifier("workflow.save")
            }
        }
        .padding(.horizontal, 28).padding(.top, 20).padding(.bottom, 14)
    }

    private var picker: some View {
        VStack(alignment: .leading, spacing: 0) {
            pickerSection("Built-in", model.builtins.map(\.id))
            if !model.userTemplates.isEmpty {
                Divider()
                pickerSection("Yours", model.userTemplates.map(\.id).filter { id in
                    !model.builtins.contains { $0.id == id }
                })
            }
            Divider()
            Button {
                showingPicker = false
                model.newTemplate()
            } label: {
                Label("New workflow", systemImage: "plus")
                    .font(RT.ui(12.5, weight: .medium)).foregroundStyle(RT.accent)
                    .padding(.horizontal, 12).padding(.vertical, 9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("workflow.new")
        }
        .frame(width: 260)
    }

    private func pickerSection(_ title: String, _ ids: [String]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased()).font(RT.ui(9.5, weight: .semibold)).tracking(0.8).foregroundStyle(RT.textFaint)
                .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 4)
            ForEach(ids, id: \.self) { id in
                if let template = model.library.template(id: id) {
                    Button {
                        showingPicker = false
                        model.select(id)
                    } label: {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(template.name).font(RT.ui(12.5)).foregroundStyle(RT.text).lineLimit(1)
                                Text("\(template.stages.count) stages").font(RT.ui(10.5)).foregroundStyle(RT.textFaint)
                            }
                            Spacer(minLength: 0)
                            if id == model.draft.id {
                                Image(systemName: "checkmark").font(RT.ui(11, weight: .semibold)).foregroundStyle(RT.accent)
                            }
                        }
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    // MARK: - Active bar

    private var activeBar: some View {
        HStack(spacing: 12) {
            Circle().fill(RT.accent).frame(width: 8, height: 8)
            TextField("Workflow name", text: Binding(get: { model.draft.name },
                                                     set: { model.draft.name = $0 }))
                .textFieldStyle(.plain)
                .font(RT.ui(14, weight: .semibold)).foregroundStyle(RT.text)
                .frame(minWidth: 90, maxWidth: 260)
                .accessibilityIdentifier("workflow.name")
            if let tag = model.draft.tag {
                Text(tag).font(RT.ui(11)).foregroundStyle(RT.accent)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(RT.tint(RT.accent, 12), in: RoundedRectangle(cornerRadius: 4))
            }
            if model.isDirty {
                Text("unsaved changes").font(RT.ui(11)).foregroundStyle(RT.warn)
            }
            Spacer(minLength: 0)
            if model.isUserSaved {
                Button("Revert to built-in", action: model.revertToBuiltin)
                    .buttonStyle(.plain)
                    .font(RT.ui(11.5)).foregroundStyle(RT.warn)
                    .help("Deletes your copy; the built-in workflow comes back")
                    .disabled(!model.builtins.contains { $0.id == model.draft.id })
            }
            if runningId == model.draft.id {
                HStack(spacing: 6) {
                    Circle().fill(RT.run).frame(width: 6, height: 6)
                    Text("running now at the table")
                }
                .font(RT.ui(12)).foregroundStyle(RT.textMuted)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .background(RT.surface2, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(RT.border))
    }

    private var problemsBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(model.problems) { problem in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle").font(RT.ui(11)).foregroundStyle(RT.warn)
                    Text(problem.message).font(RT.ui(12)).foregroundStyle(RT.text)
                }
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RT.tint(RT.warn, 10), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(RT.warn.opacity(0.35)))
        .accessibilityIdentifier("workflow.problems")
    }

    // MARK: - Stages

    private var stageRow: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            HStack(alignment: .top, spacing: 0) {
                ForEach(Array(model.draft.stages.enumerated()), id: \.element.id) { index, stage in
                    if index > 0 { connector(after: index - 1) }
                    StageEditorCard(
                        stage: stage,
                        index: index,
                        count: model.draft.stages.count,
                        agents: agents,
                        onPatch: { change in model.edit { WorkflowEditor.updateStage(in: $0, at: index, change) } },
                        onMove: { offset in model.edit { WorkflowEditor.moveStage(in: $0, at: index, by: offset) } },
                        onDelete: { model.edit { WorkflowEditor.removeStage(from: $0, at: index) } },
                        onConfigure: { configuring = index }
                    )
                    .popover(isPresented: Binding(get: { configuring == index },
                                                  set: { if !$0 { configuring = nil } }), arrowEdge: .bottom) {
                        StageConfigureView(
                            stage: stage,
                            agents: agents,
                            onPatch: { change in model.edit { WorkflowEditor.updateStage(in: $0, at: index, change) } },
                            onGate: { kind in model.edit { WorkflowEditor.setGate(in: $0, at: index, kind: kind) } },
                            onParallel: { model.edit { WorkflowEditor.toggleParallel(in: $0, at: index) } },
                            onAddSeat: { seat in model.edit { WorkflowEditor.addSeat(to: $0, at: index, seat: seat) } },
                            onRemoveSeat: { seatIndex in
                                model.edit { WorkflowEditor.removeSeat(from: $0, at: index, seatIndex: seatIndex) }
                            }
                        )
                    }
                }
                connector(after: model.draft.stages.count - 1)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.bottom, 14)
        }
    }

    /// A place to insert: drop a stage from the shelf, or click for the same
    /// list — dragging is not reachable from the keyboard. The Web can only
    /// insert between stages; here the last connector also appends.
    private func connector(after index: Int) -> some View {
        let targeted = dropTarget == index
        return HStack(spacing: 0) {
            Rectangle().fill(targeted ? RT.accent : RT.borderStrong).frame(width: 14, height: 2)
            Button { addingAt = index } label: {
                Image(systemName: "plus").font(RT.ui(targeted ? 12 : 10, weight: .semibold))
                    .foregroundStyle(targeted ? .white : RT.accent)
                    .frame(width: targeted ? 30 : 22, height: targeted ? 30 : 22)
                    .background(targeted ? RT.accent : RT.surface, in: Circle())
                    .overlay(Circle().strokeBorder(RT.accent.opacity(targeted ? 0 : 0.45),
                                                   style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
            }
            .buttonStyle(.plain)
            .help("Add a stage here")
            .accessibilityLabel("Add a stage after stage \(index + 1)")
            .popover(isPresented: Binding(get: { addingAt == index }, set: { if !$0 { addingAt = nil } }),
                     arrowEdge: .bottom) { presetMenu(after: index) }
            Rectangle().fill(targeted ? RT.accent : RT.borderStrong).frame(width: 14, height: 2)
        }
        .frame(height: 148)
        .animation(.easeOut(duration: 0.12), value: targeted)
        .onDrop(of: [.text], delegate: PresetDropDelegate(index: index, target: $dropTarget) { id in
            guard let preset = model.preset(id: id) else { return false }
            model.edit { WorkflowEditor.insertStage(into: $0, after: index, preset: preset) }
            return true
        })
    }

    private func presetMenu(after index: Int) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(model.presets) { preset in
                Button {
                    addingAt = nil
                    model.edit { WorkflowEditor.insertStage(into: $0, after: index, preset: preset) }
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: RT.symbol(forStageIcon: preset.icon)).font(RT.ui(11))
                            .foregroundStyle(RT.accent).frame(width: 20)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(preset.name).font(RT.ui(12, weight: .medium)).foregroundStyle(RT.text)
                            Text(preset.gateLabel.map { "gate · \($0)" } ?? "no gate")
                                .font(RT.ui(10)).foregroundStyle(RT.textFaint)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 11).padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
        .frame(width: 220)
    }

    /// The shelf: every stage the built-in workflows use, ready to drag in.
    /// The cards match the ones in the flow so the two read as one surface.
    private var palette: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text("ADD A STAGE").font(RT.ui(9.5, weight: .semibold)).tracking(0.8).foregroundStyle(RT.textFaint)
                Text("drag one into the flow, or click a ＋")
                    .font(RT.ui(11)).foregroundStyle(RT.textFaint)
                Spacer(minLength: 0)
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 248, maximum: 300), spacing: 14, alignment: .top)],
                      alignment: .leading, spacing: 14) {
                ForEach(model.presets) { preset in
                    presetCard(preset)
                        .onDrag { NSItemProvider(object: preset.id as NSString) }
                }
            }
        }
        .accessibilityIdentifier("workflow.palette")
    }

    private func presetCard(_ preset: WorkflowEditor.StagePreset) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: RT.symbol(forStageIcon: preset.icon)).font(RT.ui(14)).foregroundStyle(RT.accent)
                    .frame(width: 30, height: 30).background(RT.tint(RT.accent, 13), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    Text(preset.name).font(RT.ui(13.5, weight: .semibold)).foregroundStyle(RT.text)
                    Text(preset.kind.uppercased()).font(RT.mono(9.5)).tracking(0.76).foregroundStyle(RT.textFaint)
                }
                Spacer(minLength: 0)
                Image(systemName: "line.3.horizontal").font(RT.ui(11)).foregroundStyle(RT.textFaint)
                    .help("Drag this into the flow")
            }
            .padding(.horizontal, 12).padding(.vertical, 11)

            Divider()

            VStack(alignment: .leading, spacing: 10) {
                Text(preset.desc ?? "").font(RT.ui(12)).foregroundStyle(RT.textMuted)
                    .lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !(preset.stage.seats ?? []).isEmpty {
                    Text("WHO RUNS IT").font(RT.ui(9.5, weight: .semibold)).tracking(0.8).foregroundStyle(RT.textFaint)
                    FlowRow(spacing: 6) {
                        ForEach(Array((preset.stage.seats ?? []).enumerated()), id: \.offset) { _, seat in
                            SeatChip(seat: seat, agents: agents)
                        }
                    }
                }
            }
            .padding(12)

            Spacer(minLength: 0)
            Divider()
            HStack(spacing: 8) {
                if let label = preset.gateLabel {
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.shield").font(RT.ui(9))
                        Text(label).font(RT.ui(11, weight: .medium))
                    }
                    .foregroundStyle(RT.accent)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(RT.tint(RT.accent, 14), in: Capsule())
                } else {
                    Text("no gate").font(RT.ui(11)).foregroundStyle(RT.textFaint)
                }
                Spacer(minLength: 0)
                Text("drag in").font(RT.ui(11)).foregroundStyle(RT.textFaint)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
        .frame(minHeight: 196, alignment: .top)
        .background(RT.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(RT.border))
        .help(preset.desc ?? preset.name)
        .accessibilityIdentifier("preset.\(preset.id)")
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("Every mission on this workbench follows these stages. Changes are saved on this machine.",
                  systemImage: "sparkle")
                .font(RT.ui(12)).foregroundStyle(RT.textFaint)
            Text("The replayed mission keeps the template it recorded; running an edited workflow needs the Host Runtime.")
                .font(RT.ui(11.5)).foregroundStyle(RT.textFaint)
            if let error = model.loadError {
                Text(error).font(RT.ui(11.5)).foregroundStyle(RT.warn)
            }
        }
    }
}

// MARK: - Stage card

private struct StageEditorCard: View {
    let stage: WorkflowStage
    let index: Int
    let count: Int
    let agents: AgentRoster
    var onPatch: ((inout WorkflowStage) -> Void) -> Void
    var onMove: (Int) -> Void
    var onDelete: () -> Void
    var onConfigure: () -> Void

    private var gate: GateOption? {
        guard let kind = stage.gate?.kind, kind != "none" else { return nil }
        return GateOption.option(for: kind)
            ?? GateOption(kind: kind, label: stage.gate?.label ?? kind, icon: "dot",
                          hint: stage.gate?.description ?? "", required: stage.gate?.required ?? true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: RT.symbol(forStageIcon: stage.icon)).font(RT.ui(14)).foregroundStyle(RT.accent)
                    .frame(width: 30, height: 30).background(RT.tint(RT.accent, 13), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 2) {
                    TextField("Stage", text: Binding(get: { stage.name },
                                                     set: { value in onPatch { $0.name = value } }))
                        .textFieldStyle(.plain)
                        .font(RT.ui(13.5, weight: .semibold)).foregroundStyle(RT.text)
                    Text(stage.parallelGroup == nil ? "STAGE \(index + 1)" : "STAGE \(index + 1) · PARALLEL")
                        .font(RT.mono(9.5)).tracking(0.76).foregroundStyle(RT.textFaint)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 11)

            HStack(spacing: 4) {
                arrow("chevron.left", enabled: index > 0) { onMove(-1) }
                arrow("chevron.right", enabled: index < count - 1) { onMove(1) }
                Spacer(minLength: 0)
                if stage.fixed != true {
                    Button(action: onDelete) {
                        Image(systemName: "xmark").font(RT.ui(9, weight: .semibold)).foregroundStyle(RT.textMuted)
                            .frame(width: 22, height: 22)
                            .overlay(RoundedRectangle(cornerRadius: 5).stroke(RT.border))
                    }
                    .buttonStyle(.plain)
                    .help("Remove this stage")
                    .accessibilityLabel("Remove stage \(stage.name)")
                }
            }
            .padding(.horizontal, 12).padding(.bottom, 8)

            Divider()

            VStack(alignment: .leading, spacing: 10) {
                TextEditor(text: Binding(get: { stage.desc ?? "" }, set: { value in onPatch { $0.desc = value } }))
                    .font(RT.ui(12)).foregroundStyle(RT.textMuted)
                    .scrollContentBackground(.hidden)
                    .frame(height: 58)
                    .padding(.horizontal, 4).padding(.vertical, 2)
                    .background(RT.surface2, in: RoundedRectangle(cornerRadius: 6))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(RT.border))
                    .accessibilityLabel("Instructions for \(stage.name)")

                Text("WHO RUNS IT").font(RT.ui(9.5, weight: .semibold)).tracking(0.8).foregroundStyle(RT.textFaint)
                if (stage.seats ?? []).isEmpty {
                    Text("no one yet").font(RT.ui(11.5)).foregroundStyle(RT.textFaint)
                } else {
                    FlowRow(spacing: 6) {
                        ForEach(Array((stage.seats ?? []).enumerated()), id: \.offset) { _, seat in
                            SeatChip(seat: seat, agents: agents)
                        }
                    }
                }
            }
            .padding(12)

            Spacer(minLength: 0)
            Divider()
            HStack(spacing: 8) {
                if let gate {
                    HStack(spacing: 5) {
                        Image(systemName: RT.symbol(forStageIcon: gate.icon)).font(RT.ui(9))
                        Text(gate.label).font(RT.ui(11, weight: .medium))
                    }
                    .foregroundStyle(RT.accent)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(RT.tint(RT.accent, 14), in: Capsule())
                    .help(gate.hint)
                } else {
                    Text("no gate").font(RT.ui(11)).foregroundStyle(RT.textFaint)
                }
                Spacer(minLength: 0)
                Button(action: onConfigure) {
                    Label("Configure", systemImage: "slider.horizontal.3")
                        .font(RT.ui(11.5, weight: .medium)).foregroundStyle(RT.accent)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("stage.configure.\(stage.id)")
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
        }
        .frame(width: 248)
        .frame(minHeight: 296, alignment: .top)
        .background(RT.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(RT.border))
        .accessibilityIdentifier("stage.card.\(stage.id)")
    }

    private func arrow(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(RT.ui(9, weight: .semibold)).foregroundStyle(RT.textMuted)
                .frame(width: 22, height: 22)
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(RT.border))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.35)
        .accessibilityLabel(symbol == "chevron.left" ? "Move stage earlier" : "Move stage later")
    }
}

private struct SeatChip: View {
    let seat: StageSeat
    let agents: AgentRoster
    var onRemove: (() -> Void)?

    var body: some View {
        let agent = seat.ref.agentId.flatMap { agents[$0] }
            ?? agents.ordered.first { $0.role == seat.ref.role }
        let isUser = seat.ref.kind == "user"
        let color = isUser ? RT.pm : RT.agentColor(agent?.agentId ?? seat.ref.role ?? "")
        HStack(spacing: 5) {
            if isUser {
                AvatarImage(assetName: "you", name: "You", color: color)
                    .frame(width: 18, height: 18).clipShape(Circle())
            } else if let agent {
                AvatarImage(assetName: agent.agentId == "orchestrator" ? "planning" : agent.agentId,
                            name: agent.displayName, color: color)
                    .frame(width: 18, height: 18).clipShape(Circle())
            } else {
                Circle().fill(color).frame(width: 8, height: 8)
            }
            Text(isUser ? "You" : agent?.displayName ?? seat.ref.role ?? "agent")
                .font(RT.ui(11.5, weight: .medium)).foregroundStyle(RT.text)
            if !isUser {
                Text("@\(seat.ref.role ?? agent?.role ?? "agent")").font(RT.mono(10)).foregroundStyle(color)
            }
            if let onRemove {
                Button(action: onRemove) {
                    Image(systemName: "xmark").font(RT.ui(8, weight: .bold)).foregroundStyle(RT.warn)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove seat")
            }
        }
        .padding(.horizontal, 7).padding(.vertical, 3)
        .background(RT.surface2, in: Capsule())
        .overlay(Capsule().stroke(color.opacity(0.35)))
    }
}

// MARK: - Configure

private struct StageConfigureView: View {
    let stage: WorkflowStage
    let agents: AgentRoster
    var onPatch: ((inout WorkflowStage) -> Void) -> Void
    var onGate: (String) -> Void
    var onParallel: () -> Void
    var onAddSeat: (StageSeat) -> Void
    var onRemoveSeat: (Int) -> Void

    @State private var addingSeat = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                section("Icon") {
                    FlowRow(spacing: 6) {
                        ForEach(WorkflowEditor.iconOptions, id: \.self) { icon in
                            Button { onPatch { $0.icon = icon } } label: {
                                Image(systemName: RT.symbol(forStageIcon: icon)).font(RT.ui(12))
                                    .foregroundStyle(stage.icon == icon ? .white : RT.textMuted)
                                    .frame(width: 30, height: 30)
                                    .background(stage.icon == icon ? RT.accent : RT.surface2,
                                                in: RoundedRectangle(cornerRadius: 7))
                                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(RT.border))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(icon)
                        }
                    }
                }

                section("Who runs it") {
                    VStack(alignment: .leading, spacing: 8) {
                        FlowRow(spacing: 6) {
                            ForEach(Array((stage.seats ?? []).enumerated()), id: \.offset) { index, seat in
                                SeatChip(seat: seat, agents: agents) { onRemoveSeat(index) }
                            }
                            Button { addingSeat.toggle() } label: {
                                Image(systemName: "plus").font(RT.ui(10, weight: .semibold)).foregroundStyle(RT.accent)
                                    .frame(width: 24, height: 24)
                                    .overlay(Circle().strokeBorder(RT.accent.opacity(0.45),
                                                                   style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
                            }
                            .buttonStyle(.plain)
                            .help("Add someone to this stage")
                            .popover(isPresented: $addingSeat, arrowEdge: .bottom) { seatMenu }
                        }
                        Text("Seats are slots: the same agent can take more than one.")
                            .font(RT.ui(10.5)).foregroundStyle(RT.textFaint)
                    }
                }

                section("Runs in parallel") {
                    Toggle(isOn: Binding(get: { stage.parallelGroup != nil }, set: { _ in onParallel() })) {
                        Text("Seats in this stage work at the same time")
                            .font(RT.ui(11.5)).foregroundStyle(RT.textMuted)
                    }
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }

                section("Quality gate") {
                    VStack(spacing: 5) {
                        ForEach(GateOption.all) { option in
                            Button { onGate(option.kind) } label: {
                                HStack(alignment: .top, spacing: 9) {
                                    Image(systemName: (stage.gate?.kind ?? "none") == option.kind
                                          ? "largecircle.fill.circle" : "circle")
                                        .font(RT.ui(12))
                                        .foregroundStyle((stage.gate?.kind ?? "none") == option.kind ? RT.accent : RT.textFaint)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(option.label).font(RT.ui(12, weight: .medium)).foregroundStyle(RT.text)
                                        Text(option.hint).font(RT.ui(10.5)).foregroundStyle(RT.textFaint)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 9).padding(.vertical, 7)
                                .background((stage.gate?.kind ?? "none") == option.kind ? RT.surface2 : .clear,
                                            in: RoundedRectangle(cornerRadius: 7))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("gate.\(option.kind)")
                        }
                        if let kind = stage.gate?.kind, kind != "none", GateOption.option(for: kind) == nil {
                            Text("This stage uses “\(kind)”, which this editor does not offer. It is kept as it is.")
                                .font(RT.ui(10.5)).foregroundStyle(RT.warn)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
            .padding(16)
        }
        .frame(width: 320, height: 470)
        .accessibilityIdentifier("stage.configure.panel")
    }

    private var seatMenu: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(agents.ordered, id: \.agentId) { agent in
                Button { onAddSeat(.role(agent.role, agent.agentId)); addingSeat = false } label: {
                    HStack(spacing: 8) {
                        AvatarImage(assetName: agent.agentId == "orchestrator" ? "planning" : agent.agentId,
                                    name: agent.displayName, color: RT.agentColor(agent.agentId))
                            .frame(width: 20, height: 20).clipShape(Circle())
                        Text(agent.displayName).font(RT.ui(12)).foregroundStyle(RT.text)
                        Text("@\(agent.role)").font(RT.mono(10)).foregroundStyle(RT.textFaint)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Divider()
            Button { onAddSeat(.user); addingSeat = false } label: {
                HStack(spacing: 8) {
                    AvatarImage(assetName: "you", name: "You", color: RT.pm)
                        .frame(width: 20, height: 20).clipShape(Circle())
                    Text("You").font(RT.ui(12)).foregroundStyle(RT.text)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10).padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .frame(width: 220)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title.uppercased()).font(RT.ui(9.5, weight: .semibold)).tracking(0.8).foregroundStyle(RT.textFaint)
            content()
        }
    }
}

/// Highlights the connector under the pointer and hands the preset id back.
private struct PresetDropDelegate: DropDelegate {
    let index: Int
    @Binding var target: Int?
    let onDrop: (String) -> Bool

    func dropEntered(info: DropInfo) { target = index }
    func dropExited(info: DropInfo) { if target == index { target = nil } }
    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [.text]) }

    func performDrop(info: DropInfo) -> Bool {
        target = nil
        guard let provider = info.itemProviders(for: [.text]).first else { return false }
        provider.loadObject(ofClass: NSString.self) { value, _ in
            guard let id = value as? String else { return }
            Task { @MainActor in _ = onDrop(id) }
        }
        return true
    }
}
