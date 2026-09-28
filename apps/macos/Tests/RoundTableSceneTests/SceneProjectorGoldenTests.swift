import Foundation
import Testing
@testable import RoundTableScene

/// Golden scenes generated from the Web's own projection by
/// scripts/generate-turn-scenes.mjs.
struct TurnScenesGolden: Decodable {
    struct Step: Decodable {
        var id: String
        var frameIndex: Int?
        var playback: MeetingPlayback
        var scene: RoundtableScene
    }

    var format: String
    var version: Int
    var timeline: String
    var agents: [SceneAgent]
    var meetingDurationsMs: [String: Int]
    var steps: [Step]
}

enum TurnFixtures {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("Fixtures/TurnTimelines")

    static func load(_ name: String) throws -> (TurnTimeline, TurnScenesGolden) {
        let timeline = try TurnTimeline.decode(Data(contentsOf: directory.appendingPathComponent("\(name).timeline.json")))
        let golden = try JSONDecoder().decode(
            TurnScenesGolden.self,
            from: Data(contentsOf: directory.appendingPathComponent("\(name).scenes.json"))
        )
        return (timeline, golden)
    }
}

@Suite("Scene projection parity with the Web")
struct SceneProjectorGoldenTests {
    static let fixtures = ["feature-builder-local-dispatch", "feature-builder-synthetic-live"]

    @Test("every golden step projects identically", arguments: fixtures)
    func goldenSteps(fixture: String) throws {
        let (timeline, golden) = try TurnFixtures.load(fixture)
        #expect(golden.format == "roundtable.turn-scenes" && golden.version == 1)
        #expect(golden.timeline == "\(fixture).timeline.json")
        let agents = AgentRoster(golden.agents)
        let first = timeline.frames[0].turn

        for step in golden.steps {
            let turn: LiveTurn
            if let frameIndex = step.frameIndex {
                turn = LiveTurn(stored: timeline.frames[frameIndex].turn)
            } else {
                #expect(step.id == "pending")
                turn = .pending(id: first.id, chatId: first.localChatId, message: first.message, createdAt: first.createdAt)
            }
            let scene = try #require(SceneProjector.project(turns: [turn], agents: agents, playback: step.playback))
            #expect(scene == step.scene, "step \(step.id)")
        }
    }

    @Test("meeting durations match the Web's pacing", arguments: fixtures)
    func meetingDurations(fixture: String) throws {
        let (timeline, golden) = try TurnFixtures.load(fixture)
        let messages = timeline.frames.flatMap { $0.turn.planningMeeting?.messages ?? [] }
        #expect(!messages.isEmpty)
        for message in messages {
            #expect(MeetingPlayback.durationMs(for: message.content) == golden.meetingDurationsMs[message.id], "\(message.id)")
        }
    }

    @Test("meeting playback walks every message once, then completes")
    func playbackAdvances() {
        var playback = MeetingPlayback.starting
        var shown: [Int] = []
        while !playback.meetingComplete {
            shown.append(playback.meetingMessageIndex)
            playback = playback.advanced(messageCount: 3)
        }
        #expect(shown == [0, 1, 2])
        #expect(playback.advanced(messageCount: 3) == playback)
    }

    @Test("no live turn keeps the base scene")
    func noTurns() {
        let agents = AgentRoster([SceneAgent(agentId: "orchestrator", role: "planner", displayName: "Planning", pm: true)])
        #expect(SceneProjector.project(turns: [], agents: agents, playback: .idle) == nil)
        let draft = LiveTurn(id: "live-1", chatId: nil, message: "x", status: "queued", createdAt: nil, serverConfirmed: false)
        #expect(SceneProjector.project(turns: [draft], agents: agents, playback: .idle) == nil)
    }

    @Test("speech text collapses whitespace and caps at 520 UTF-16 units")
    func speechText() {
        #expect(SceneProjector.meetingSpeechText("  a \t b\r\n\n\n c  ") == "a b\nc")
        let long = String(repeating: "x", count: 600)
        let capped = SceneProjector.meetingSpeechText(long)
        #expect(capped == String(repeating: "x", count: 520) + "…")
    }

    @Test("pending speech follows the mission language")
    func pendingLanguage() {
        #expect(SceneProjector.pendingSpeech(for: "修复登录问题").hasPrefix("我先读取"))
        #expect(SceneProjector.pendingSpeech(for: "Fix login").hasPrefix("I am reading"))
    }

    @Test("latest turn prefers the newest createdAt, then the earlier entry on ties")
    func latestTurn() {
        let older = LiveTurn(id: "a", chatId: nil, message: "", status: "pending", createdAt: "2026-09-19T17:00:00.000Z", serverConfirmed: false)
        let newer = LiveTurn(id: "b", chatId: nil, message: "", status: "pending", createdAt: "2026-09-19T17:05:00.000Z", serverConfirmed: false)
        let tie = LiveTurn(id: "c", chatId: nil, message: "", status: "pending", createdAt: "2026-09-19T17:05:00.000Z", serverConfirmed: false)
        #expect(SceneProjector.latestLiveTurn([older, newer, tie])?.id == "b")
        let byId = LiveTurn(id: "live-2000", chatId: nil, message: "", status: "pending", createdAt: nil, serverConfirmed: false)
        let byIdOlder = LiveTurn(id: "live-1000", chatId: nil, message: "", status: "pending", createdAt: nil, serverConfirmed: false)
        #expect(SceneProjector.latestLiveTurn([byIdOlder, byId])?.id == "live-2000")
    }

    @Test("running transcripts become now-doing bubbles")
    func liveActivity() {
        let agents = AgentRoster([
            SceneAgent(agentId: "orchestrator", role: "planner", displayName: "Planning", pm: true),
            SceneAgent(agentId: "atlas", role: "implementer", displayName: "Atlas"),
            SceneAgent(agentId: "vera", role: "reviewer", displayName: "Vera"),
        ])
        let tasks = [
            SceneTask(id: "t1", owner: "atlas", status: "running"),
            SceneTask(id: "t2", owner: "vera", status: "running"),
            SceneTask(id: "t3", owner: "vera", status: "completed"),
        ]
        let activity: [String: TaskLiveActivity] = [
            "t1": TaskLiveActivity(status: "running", agentId: "atlas",
                                   transcript: [TranscriptEntry(kind: "thinking", content: "…"),
                                                TranscriptEntry(kind: "status", content: "Using write_file")]),
            "t2": TaskLiveActivity(status: "running", agentId: nil, transcript: []),
            "t3": TaskLiveActivity(status: "completed", agentId: "vera", transcript: [TranscriptEntry(kind: "response", content: "done")]),
        ]
        let work = SceneProjector.workByAgent(activity, tasks: tasks, agents: agents)
        #expect(work["atlas"] == SceneWork(taskId: "t1", mode: "working", text: "Using write_file", tool: "write_file", steps: 2))
        #expect(work["vera"] == SceneWork(taskId: "t2", mode: "starting", text: "Starting up…", tool: nil, steps: 0))
    }
}

extension SceneTask {
    init(id: String, owner: String, status: String) {
        self.init(id: id, title: nil, assignee: nil, owner: owner, role: nil, stageId: nil, brief: nil, objective: nil,
                  deps: nil, parallel: nil, acceptanceCriteria: nil, status: status)
    }
}
