import Foundation
import Testing
@testable import RoundTableContracts

@Suite("Host Runtime Turn stream contract")
struct TurnStreamContractTests {
    private let nonce = "session_0123456789abcdef0123456789abcdef"
    private let request = "request_0123456789abcdef0123456789abcdef"

    @Test("all actions are exact-key and owner-session shaped")
    func requests() throws {
        let start = Data("{\"action\":\"start\",\"goal\":\"Build it\",\"protocolVersion\":1,\"requestId\":\"\(request)\",\"sessionNonce\":\"\(nonce)\",\"workflowTemplateId\":\"wf-feature-builder\"}".utf8)
        #expect(try TurnStreamRequest.decodeStrict(start).action == .start)
        let polluted = Data("{\"action\":\"poll\",\"afterSequence\":0,\"credential\":\"x\",\"protocolVersion\":1,\"requestId\":\"\(request)\",\"sessionNonce\":\"\(nonce)\",\"streamId\":\"turnstream_0123456789abcdef0123456789abcdef\"}".utf8)
        #expect(throws: (any Error).self) { try TurnStreamRequest.decodeStrict(polluted) }
    }

    @Test("success response preserves bounded Turn bytes and rejects duplicate fields")
    func responses() throws {
        let success = Data("{\"awaiting\":\"plan_approval\",\"frames\":[{\"gate\":\"plan_approval\",\"sequence\":1,\"turn\":{\"id\":\"turn_1\",\"message\":\"Build it\",\"status\":\"done\"}}],\"ok\":true,\"protocolVersion\":1,\"requestId\":\"\(request)\",\"streamId\":\"turnstream_0123456789abcdef0123456789abcdef\",\"terminal\":false}".utf8)
        let decoded = try TurnStreamResponse.decodeStrict(success)
        #expect(decoded.frames.map(\.sequence) == [1])
        #expect(decoded.awaiting == "plan_approval")
        let duplicate = Data("{\"protocolVersion\":1,\"protocolVersion\":1}".utf8)
        #expect(throws: StrictJSONError.duplicateKey("protocolVersion")) {
            try TurnStreamResponse.decodeStrict(duplicate)
        }
    }
}
