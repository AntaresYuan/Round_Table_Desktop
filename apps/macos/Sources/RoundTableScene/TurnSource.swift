import Foundation

// The native UI's single entry point for mission data. During S2 the source is
// a recorded TurnTimeline; from S3 it is the Host Runtime's orchestration
// stream. Views read the same LiveTurn snapshots either way.

public enum TurnGate: String, Codable, Equatable, Sendable {
    case clarification
    case planApproval = "plan_approval"
    case deliveryDecision = "delivery_decision"
}

public enum TurnSourceEvent: Equatable, Sendable {
    /// The full set of client turns after a change, newest last.
    case turns([LiveTurn])
    /// The run is waiting for the user; call `resolve(_:)` to continue.
    case awaiting(TurnGate)
    case failed(String)
    case finished
}

public protocol TurnSource: Sendable {
    var events: AsyncStream<TurnSourceEvent> { get }
    func startMission() async
    func resolve(_ gate: TurnGate) async
    func cancel() async
}

public struct TurnTimeline: Codable, Equatable, Sendable {
    public struct Frame: Codable, Equatable, Sendable {
        public var atMs: Int
        public var gate: TurnGate?
        public var turn: RoundtableTurn
    }

    public var format: String
    public var version: Int
    public var frames: [Frame]

    public static func decode(_ data: Data) throws -> TurnTimeline {
        let timeline = try JSONDecoder().decode(TurnTimeline.self, from: data)
        guard timeline.format == "roundtable.turn-timeline", timeline.version == 1 else {
            throw TurnTimelineError.unsupported(format: timeline.format, version: timeline.version)
        }
        guard !timeline.frames.isEmpty else { throw TurnTimelineError.empty }
        return timeline
    }
}

public enum TurnTimelineError: Error, Equatable {
    case unsupported(format: String, version: Int)
    case empty
}

/// Replays a recorded TurnTimeline: a client-created pending turn, then each
/// recorded snapshot at its recorded offset (scaled by `speed`), pausing at
/// every gate until the UI resolves it. Replay never implies execution.
public actor ReplayTurnSource: TurnSource {
    public nonisolated let events: AsyncStream<TurnSourceEvent>
    private let continuation: AsyncStream<TurnSourceEvent>.Continuation
    private let timeline: TurnTimeline
    private let speed: Double
    private let sleep: @Sendable (Duration) async throws -> Void
    private var started = false
    private var cancelled = false
    private var waitingGate: (gate: TurnGate, resume: CheckedContinuation<Void, Never>)?
    private var resolvedEarly: Set<TurnGate> = []

    public init(timeline: TurnTimeline, speed: Double = 1,
                sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        (events, continuation) = AsyncStream.makeStream(of: TurnSourceEvent.self)
        self.timeline = timeline
        self.speed = speed > 0 ? speed : 1
        self.sleep = sleep
    }

    /// Plays the whole timeline; returns when it has finished or was cancelled.
    public func startMission() async {
        guard !started else { return }
        started = true
        let first = timeline.frames[0].turn
        continuation.yield(.turns([.pending(id: first.id, chatId: first.localChatId, message: first.message,
                                            createdAt: first.createdAt)]))
        var previousAtMs = 0
        for frame in timeline.frames {
            let delayMs = Double(max(0, frame.atMs - previousAtMs)) / speed
            previousAtMs = frame.atMs
            do { try await sleep(.milliseconds(Int(delayMs.rounded()))) } catch { break }
            guard !cancelled, !Task.isCancelled else { break }
            continuation.yield(.turns([LiveTurn(stored: frame.turn)]))
            if let gate = frame.gate {
                continuation.yield(.awaiting(gate))
                await wait(for: gate)
            }
            if cancelled || Task.isCancelled { break }
        }
        if !cancelled, !Task.isCancelled { continuation.yield(.finished) }
        continuation.finish()
    }

    public func resolve(_ gate: TurnGate) async {
        guard !cancelled else { return }
        if let waiting = waitingGate, waiting.gate == gate {
            waitingGate = nil
            waiting.resume.resume()
        } else {
            resolvedEarly.insert(gate)
        }
    }

    /// Releases a replay paused at a gate and closes its event stream.
    public func cancel() async {
        guard !cancelled else { return }
        cancelled = true
        if let waitingGate {
            self.waitingGate = nil
            waitingGate.resume.resume()
        }
        continuation.finish()
    }

    private func wait(for gate: TurnGate) async {
        if cancelled || resolvedEarly.remove(gate) != nil { return }
        await withCheckedContinuation { resume in
            if cancelled { resume.resume() }
            else { waitingGate = (gate, resume) }
        }
    }
}
