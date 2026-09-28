#if SWIFT_PACKAGE
import RoundTableScene
#endif
import SwiftUI

/// Port of the Web `WorkflowStrip` (src/ui/components/workflow.jsx): the
/// workflow's stages with live done/active flags from the run.
struct WorkflowStripView: View {
    let workflow: WorkflowTemplate
    let run: WorkflowRun?
    /// Drops the caption and the template name when the strip has to fit a
    /// narrower column.
    var compact = false
    var onOpen: () -> Void = {}

    var body: some View {
        let steps = WorkflowStripModel.steps(workflow: workflow, run: run)
        HStack(spacing: 4) {
            if !compact {
                Button(action: onOpen) {
                    Text(workflow.name).font(RT.ui(11.5, weight: .semibold)).foregroundStyle(RT.text)
                        .lineLimit(1).frame(maxWidth: 170, alignment: .leading).padding(.trailing, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Open workflow")
                .accessibilityIdentifier("workflow.open")
            }
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                if index > 0 {
                    Rectangle().fill(step.done || step.active ? RT.accent : RT.borderStrong).frame(width: 12, height: 1.5)
                }
                HStack(spacing: 5) {
                    Image(systemName: step.done ? "checkmark" : RT.symbol(forStageIcon: step.stage.icon))
                        .font(RT.ui(10, weight: step.done ? .bold : .regular))
                    if step.active || step.done {
                        Text(step.stage.name).lineLimit(1)
                    }
                }
                .font(RT.ui(11.5, weight: step.active ? .semibold : .medium))
                .foregroundStyle(step.active ? .white : step.done ? RT.accent : RT.textFaint)
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(step.active ? RT.accent : step.done ? RT.tint(RT.accent, 14) : .clear, in: Capsule())
                .help(step.stage.desc ?? step.stage.name)
                .accessibilityLabel("\(step.stage.name), \(step.done ? "done" : step.active ? "active" : "pending")")
            }
        }
        .padding(.vertical, 6)
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Workflow \(workflow.name)")
    }
}

/// Port of the status line in the Web `Dock` (src/ui/components/stage-scene.jsx):
/// who is speaking, "Plan ready", or the idle prompt.
struct DockStatusLine: View {
    let scene: RoundtableScene?
    let agents: AgentRoster
    let pending: Bool

    var body: some View {
        HStack(spacing: 14) {
            Circle().fill(dotColor).frame(width: 8, height: 8)
                .background(Circle().fill(dotColor.opacity(scene?.speech != nil ? 0.22 : 0)).frame(width: 16, height: 16))
            content
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("dock.status")
    }

    private var dotColor: Color {
        if let speech = scene?.speech, let agent = agents[speech.agentId] {
            return agent.pm == true ? RT.pm : RT.agentColor(agent.agentId)
        }
        return scene?.run.phase == "awaiting_approval" ? RT.ok : RT.textFaint
    }

    @ViewBuilder
    private var content: some View {
        if let speech = scene?.speech, let agent = agents[speech.agentId] {
            if agent.pm == true {
                (Text(agent.displayName).bold().foregroundColor(RT.pm) + Text(" · \(speech.text.isEmpty ? "facilitating…" : speech.text)"))
                    .font(RT.ui(13.5)).foregroundStyle(RT.textMuted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                let verb = speech.mode == "working" ? "is working" : speech.mode == "thinking" ? "is thinking" : "is speaking"
                (Text(agent.displayName).bold().foregroundColor(RT.agentColor(agent.agentId)) + Text(" \(verb)…"))
                    .font(RT.ui(13.5)).foregroundStyle(RT.text)
            }
        } else if scene?.run.phase == "awaiting_approval" {
            VStack(alignment: .leading, spacing: 1) {
                (Text("Plan ready").bold() + Text(" · assignments and prerequisites are now on the table"))
                    .font(RT.ui(13.5)).foregroundStyle(RT.text)
                Text("Review the plan above, then confirm to start the CLI agents.")
                    .font(RT.ui(12.5)).foregroundStyle(RT.textFaint)
            }
        } else {
            VStack(alignment: .leading, spacing: 1) {
                Text(pending ? "Drafting the plan…" : scene?.started != true ? "Ready to begin" : "The table is quiet")
                    .font(RT.ui(13.5)).foregroundStyle(RT.text)
                if scene?.started != true {
                    Text("create a task or message the table").font(RT.ui(12.5)).foregroundStyle(RT.textFaint)
                }
            }
        }
    }
}
