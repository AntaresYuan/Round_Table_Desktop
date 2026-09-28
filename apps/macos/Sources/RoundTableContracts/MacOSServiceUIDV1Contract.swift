import CryptoKit
import Foundation

public enum CanonicalContractVerifier {
    public static func verify(data: Data, expectedSHA256: String) throws {
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == expectedSHA256 else {
            throw ContractValidationError.digestMismatch
        }
        do {
            var parser = try StrictJSONParser(data: data)
            _ = try parser.parse()
        } catch StrictJSONError.duplicateKey(let key) {
            throw ContractValidationError.duplicateKey(key)
        } catch {
            throw ContractValidationError.malformedJSON
        }
    }
}

public struct MacOSServiceUIDV1Contract: Equatable, Sendable {
    public let contract: String
    public let version: Int
    public let maxConcurrency: Int
    public let secretTransport: String
    public let requests: [String]
    public let requestKeySets: [String: [String]]
    public let nestedKeySets: [String: [String]]
    public let responseKeySets: [String: [String]]
    public let seatKeySet: [String]
    public let workloads: [String]
    public let seatStates: [String]
    public let cleanupDisposition: String
    public let stopReasons: [String]
    public let errors: [String]

    public static func decodeStrict(_ data: Data) throws -> Self {
        let root: StrictJSONValue
        do {
            var parser = try StrictJSONParser(data: data)
            root = try parser.parse()
        } catch StrictJSONError.duplicateKey(let key) {
            throw ContractValidationError.duplicateKey(key)
        } catch {
            throw ContractValidationError.malformedJSON
        }

        let object = try requireObject(root, path: "$", keys: [
            "cleanupDisposition", "contract", "errors", "maxConcurrency",
            "nestedKeySets", "requestKeySets", "requests", "responseKeySets",
            "seatKeySet", "seatStates", "secretTransport", "stopReasons",
            "transportRules", "version", "workloads",
        ])

        let document = Self(
            contract: try requireString(object["contract"], path: "$.contract"),
            version: try requireInteger(object["version"], path: "$.version"),
            maxConcurrency: try requireInteger(
                object["maxConcurrency"],
                path: "$.maxConcurrency"
            ),
            secretTransport: try requireString(
                object["secretTransport"],
                path: "$.secretTransport"
            ),
            requests: try requireStringArray(object["requests"], path: "$.requests"),
            requestKeySets: try requireStringArrayMap(
                object["requestKeySets"],
                path: "$.requestKeySets",
                keys: Set(MacOSServiceUIDV1Generated.requestKeySets.keys)
            ),
            nestedKeySets: try requireStringArrayMap(
                object["nestedKeySets"],
                path: "$.nestedKeySets",
                keys: Set(MacOSServiceUIDV1Generated.nestedKeySets.keys)
            ),
            responseKeySets: try requireStringArrayMap(
                object["responseKeySets"],
                path: "$.responseKeySets",
                keys: Set(MacOSServiceUIDV1Generated.responseKeySets.keys)
            ),
            seatKeySet: try requireStringArray(object["seatKeySet"], path: "$.seatKeySet"),
            workloads: try requireStringArray(object["workloads"], path: "$.workloads"),
            seatStates: try requireStringArray(object["seatStates"], path: "$.seatStates"),
            cleanupDisposition: try requireString(
                object["cleanupDisposition"],
                path: "$.cleanupDisposition"
            ),
            stopReasons: try requireStringArray(object["stopReasons"], path: "$.stopReasons"),
            errors: try requireStringArray(object["errors"], path: "$.errors")
        )

        try validateTransportRules(object["transportRules"])
        try document.validateGeneratedValues()
        return document
    }

    public static func verifyCanonicalBytes(_ data: Data) throws -> Self {
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == MacOSServiceUIDV1Generated.corpusSHA256 else {
            throw ContractValidationError.digestMismatch
        }
        return try decodeStrict(data)
    }

    private func validateGeneratedValues() throws {
        try requireEqual(contract, MacOSServiceUIDV1Generated.contract, "$.contract")
        try requireEqual(version, MacOSServiceUIDV1Generated.version, "$.version")
        try requireEqual(
            maxConcurrency,
            MacOSServiceUIDV1Generated.maxConcurrency,
            "$.maxConcurrency"
        )
        try requireEqual(
            secretTransport,
            MacOSServiceUIDV1Generated.secretTransport,
            "$.secretTransport"
        )
        try requireEqual(requests, MacOSServiceUIDV1Generated.requests, "$.requests")
        try requireEqual(
            requestKeySets,
            MacOSServiceUIDV1Generated.requestKeySets,
            "$.requestKeySets"
        )
        try requireEqual(
            nestedKeySets,
            MacOSServiceUIDV1Generated.nestedKeySets,
            "$.nestedKeySets"
        )
        try requireEqual(
            responseKeySets,
            MacOSServiceUIDV1Generated.responseKeySets,
            "$.responseKeySets"
        )
        try requireEqual(seatKeySet, MacOSServiceUIDV1Generated.seatKeySet, "$.seatKeySet")
        try requireEqual(workloads, MacOSServiceUIDV1Generated.workloads, "$.workloads")
        try requireEqual(seatStates, MacOSServiceUIDV1Generated.seatStates, "$.seatStates")
        try requireEqual(
            cleanupDisposition,
            MacOSServiceUIDV1Generated.cleanupDisposition,
            "$.cleanupDisposition"
        )
        try requireEqual(stopReasons, MacOSServiceUIDV1Generated.stopReasons, "$.stopReasons")
        try requireEqual(errors, MacOSServiceUIDV1Generated.errors, "$.errors")
    }
}

private func validateTransportRules(_ value: StrictJSONValue?) throws {
    let rules = try requireObject(value, path: "$.transportRules", keys: [
        "consumption", "fdAllowedRequest", "fdCount", "fdIndex", "fdKey", "fdType",
    ])
    try requireEqual(
        try requireString(rules["fdKey"], path: "$.transportRules.fdKey"),
        "secretChannelFd",
        "$.transportRules.fdKey"
    )
    try requireEqual(
        try requireString(rules["fdType"], path: "$.transportRules.fdType"),
        "XPC_TYPE_FD",
        "$.transportRules.fdType"
    )
    try requireEqual(
        try requireString(
            rules["fdAllowedRequest"],
            path: "$.transportRules.fdAllowedRequest"
        ),
        "prepare",
        "$.transportRules.fdAllowedRequest"
    )
    try requireEqual(
        try requireInteger(rules["fdCount"], path: "$.transportRules.fdCount"),
        1,
        "$.transportRules.fdCount"
    )
    try requireEqual(
        try requireInteger(rules["fdIndex"], path: "$.transportRules.fdIndex"),
        0,
        "$.transportRules.fdIndex"
    )
    try requireEqual(
        try requireString(rules["consumption"], path: "$.transportRules.consumption"),
        "once",
        "$.transportRules.consumption"
    )
}

private func requireObject(
    _ value: StrictJSONValue?,
    path: String,
    keys: Set<String>
) throws -> [String: StrictJSONValue] {
    guard case .object(let object) = value else {
        throw ContractValidationError.schemaMismatch(path)
    }
    guard Set(object.keys) == keys else {
        throw ContractValidationError.schemaMismatch(path)
    }
    return object
}

private func requireString(_ value: StrictJSONValue?, path: String) throws -> String {
    guard case .string(let string) = value else {
        throw ContractValidationError.schemaMismatch(path)
    }
    return string
}

private func requireInteger(_ value: StrictJSONValue?, path: String) throws -> Int {
    guard case .number(let token) = value,
          !token.contains("."),
          !token.contains("e"),
          !token.contains("E"),
          let integer = Int(token)
    else {
        throw ContractValidationError.schemaMismatch(path)
    }
    return integer
}

private func requireStringArray(
    _ value: StrictJSONValue?,
    path: String
) throws -> [String] {
    guard case .array(let values) = value else {
        throw ContractValidationError.schemaMismatch(path)
    }
    let strings = try values.enumerated().map { index, entry in
        try requireString(entry, path: "\(path)[\(index)]")
    }
    guard Set(strings).count == strings.count else {
        throw ContractValidationError.schemaMismatch(path)
    }
    return strings
}

private func requireStringArrayMap(
    _ value: StrictJSONValue?,
    path: String,
    keys: Set<String>
) throws -> [String: [String]] {
    let object = try requireObject(value, path: path, keys: keys)
    return try object.mapValues { value in
        try requireStringArray(value, path: path)
    }
}

private func requireEqual<T: Equatable>(_ actual: T, _ expected: T, _ path: String) throws {
    guard actual == expected else { throw ContractValidationError.valueMismatch(path) }
}
