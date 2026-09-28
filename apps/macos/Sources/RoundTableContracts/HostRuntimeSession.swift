import Foundation

public struct HostRuntimeSessionOpenRequest: Equatable, Sendable {
    public let protocolVersion: Int
    public let clientNonce: String

    public static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= MacOSHostRuntimeV1Generated.sessionOpenMaxRequestBytes else {
            throw ContractValidationError.valueMismatch("$")
        }
        let object = try sessionObject(
            data,
            keys: Set(MacOSHostRuntimeV1Generated.sessionOpenRequestKeys)
        )
        let version = try sessionVersion(object["protocolVersion"])
        guard case .string(let nonce) = object["clientNonce"],
              nonce.range(
                of: MacOSHostRuntimeV1Generated.clientNoncePattern,
                options: .regularExpression
              ) != nil else {
            throw ContractValidationError.valueMismatch("$.clientNonce")
        }
        return Self(protocolVersion: version, clientNonce: nonce)
    }

    /// Classifies a rejected handshake without relaxing strict parsing. Only an
    /// otherwise exact request with a supported nonce shape may report a
    /// protocol mismatch; malformed or duplicate-key JSON remains invalid.
    public static func failureCode(for data: Data) -> String {
        guard data.count <= MacOSHostRuntimeV1Generated.sessionOpenMaxRequestBytes,
              let object = try? sessionObject(
                data, keys: Set(MacOSHostRuntimeV1Generated.sessionOpenRequestKeys)),
              case .number(let token) = object["protocolVersion"],
              let version = Int(token),
              case .string(let nonce) = object["clientNonce"],
              nonce.range(
                of: MacOSHostRuntimeV1Generated.clientNoncePattern,
                options: .regularExpression
              ) != nil,
              version != MacOSHostRuntimeV1Generated.version else {
            return MacOSHostRuntimeV1Generated.handshakeMalformedRequestError
        }
        return MacOSHostRuntimeV1Generated.handshakeVersionMismatchError
    }
}

public struct HostRuntimeSessionOpenResponse: Equatable, Sendable {
    public let protocolVersion: Int
    public let sessionNonce: String

    public static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= MacOSHostRuntimeV1Generated.sessionOpenMaxResponseBytes else {
            throw ContractValidationError.valueMismatch("$")
        }
        let object = try sessionObject(
            data,
            keys: Set(MacOSHostRuntimeV1Generated.sessionOpenResponseKeys)
        )
        let version = try sessionVersion(object["protocolVersion"])
        guard case .string(let nonce) = object["sessionNonce"],
              nonce.range(
                of: MacOSHostRuntimeV1Generated.sessionNoncePattern,
                options: .regularExpression
              ) != nil else {
            throw ContractValidationError.valueMismatch("$.sessionNonce")
        }
        return Self(protocolVersion: version, sessionNonce: nonce)
    }
}

public struct HostRuntimeSessionOpenFailure: Equatable, Sendable {
    public let error: String

    public static func decodeStrict(_ data: Data) throws -> Self {
        guard data.count <= MacOSHostRuntimeV1Generated.sessionOpenMaxResponseBytes else {
            throw ContractValidationError.valueMismatch("$")
        }
        let object = try sessionObject(
            data,
            keys: Set(MacOSHostRuntimeV1Generated.sessionOpenFailureResponseKeys)
        )
        guard case .string(let error) = object["error"],
              [
                MacOSHostRuntimeV1Generated.handshakeVersionMismatchError,
                MacOSHostRuntimeV1Generated.handshakeMalformedRequestError,
              ].contains(error) else {
            throw ContractValidationError.valueMismatch("$.error")
        }
        return Self(error: error)
    }
}

private func sessionObject(
    _ data: Data,
    keys: Set<String>
) throws -> [String: StrictJSONValue] {
    let root: StrictJSONValue
    do {
        var parser = try StrictJSONParser(data: data)
        root = try parser.parse()
    } catch StrictJSONError.duplicateKey(let key) {
        throw ContractValidationError.duplicateKey(key)
    } catch {
        throw ContractValidationError.malformedJSON
    }
    guard case .object(let object) = root, Set(object.keys) == keys else {
        throw ContractValidationError.schemaMismatch("$")
    }
    return object
}

private func sessionVersion(_ value: StrictJSONValue?) throws -> Int {
    guard case .number(let token) = value,
          let version = Int(token),
          version == MacOSHostRuntimeV1Generated.version else {
        throw ContractValidationError.valueMismatch("$.protocolVersion")
    }
    return version
}
