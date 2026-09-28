import Foundation

/// Canonical response construction for trusted Host Runtime handlers. Every
/// success is validated against the same operation-specific schema before the
/// bytes leave the Contracts module.
public enum HostRuntimeResponseCodec {
    public static func success<Payload: Encodable>(requestID: String,
                                                   operation: HostRuntimeOperation,
                                                   payload: Payload) throws -> Data {
        let payloadData = try JSONEncoder().encode(payload)
        var parser = try StrictJSONParser(data: payloadData)
        let value = try parser.parse()
        let data = HostRuntimeResponseEnvelope(requestID: requestID, operation: operation,
                                               ok: true, payload: value).encodedData()
        _ = try HostRuntimeResponseEnvelope.decodeStrict(data)
        return data
    }

    public static func failure(requestID: String, operation: HostRuntimeOperation,
                               error: String) throws -> Data {
        let data = HostRuntimeResponseEnvelope(requestID: requestID, operation: operation,
                                               ok: false, error: error).encodedData()
        _ = try HostRuntimeResponseEnvelope.decodeStrict(data)
        return data
    }

    public static func validate(_ data: Data) throws {
        _ = try HostRuntimeResponseEnvelope.decodeStrict(data)
    }
}
