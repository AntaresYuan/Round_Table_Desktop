import Foundation
import Testing
@testable import RoundTableScene

/// Editing a workflow writes the template back, so decoding must not quietly
/// drop fields the orchestrator reads (planning, capabilities, gate actions).
@Suite("Workflow template coding")
struct WorkflowTemplateCodingTests {
    private func fixtureWorkflowJSON() throws -> [String: Any] {
        let (timeline, _) = try TurnFixtures.load("feature-builder-local-dispatch")
        let turn = try #require(timeline.frames.first?.turn)
        let data = try JSONEncoder().encode(try #require(turn.workflow))
        return try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("every field of the recorded template survives a decode and re-encode")
    func roundTripKeepsEveryField() throws {
        let url = TurnFixtures.directory.appendingPathComponent("feature-builder-local-dispatch.timeline.json")
        let raw = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let frames = try #require(raw["frames"] as? [[String: Any]])
        let original = try #require((frames[0]["turn"] as? [String: Any])?["workflow"] as? [String: Any])

        let reencoded = try fixtureWorkflowJSON()
        #expect(missingKeys(original: original, encoded: reencoded).isEmpty)
    }

    /// Reports `path` for every key the original has and the re-encode lost.
    private func missingKeys(original: [String: Any], encoded: [String: Any], path: String = "") -> [String] {
        var missing: [String] = []
        for (key, value) in original {
            let here = path.isEmpty ? key : "\(path).\(key)"
            guard let mirrored = encoded[key] else {
                // An empty array or an explicit null carries no information to lose.
                if let array = value as? [Any], array.isEmpty { continue }
                if value is NSNull { continue }
                missing.append(here)
                continue
            }
            if let nested = value as? [String: Any], let other = mirrored as? [String: Any] {
                missing += missingKeys(original: nested, encoded: other, path: here)
            }
            if let nested = value as? [[String: Any]], let other = mirrored as? [[String: Any]], nested.count == other.count {
                for (index, element) in nested.enumerated() {
                    missing += missingKeys(original: element, encoded: other[index], path: "\(here)[\(index)]")
                }
            }
        }
        return missing
    }

    @Test("the fields the read-only view never touched are decoded")
    func decodesEditorRelevantFields() throws {
        let (timeline, _) = try TurnFixtures.load("feature-builder-local-dispatch")
        let workflow = try #require(timeline.frames.first?.turn.workflow)
        #expect(workflow.builtin == true)
        #expect(workflow.version == 1)
        #expect(workflow.planning?.cut == "by_capability")
        #expect(workflow.planning?.clarifyThreshold == 0.6)
        #expect(workflow.planning?.maxClarifyQuestions == 3)
        let clarify = try #require(workflow.stages.first { $0.id == "clarify" })
        #expect(clarify.gate?.kind == "requirement_clarification")
        #expect(clarify.gate?.actions == ["answer_questions"])
        #expect(clarify.requiredCapabilities == ["mission.planning", "product.briefing"])
        let build = try #require(workflow.stages.first { $0.id == "build" })
        #expect(build.parallelGroup == "build")
    }
}
