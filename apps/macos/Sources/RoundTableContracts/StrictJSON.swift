import Foundation

public enum StrictJSONValue: Equatable, Sendable {
    case object([String: StrictJSONValue])
    case array([StrictJSONValue])
    case string(String)
    case number(String)
    case boolean(Bool)
    case null
}

public extension StrictJSONValue {
    func encodedData() -> Data {
        Data(encodedString().utf8)
    }

    private func encodedString() -> String {
        switch self {
        case .object(let object):
            return "{" + object.keys.sorted().map { key in
                "\"\(escape(key))\":\(object[key]!.encodedString())"
            }.joined(separator: ",") + "}"
        case .array(let values): return "[" + values.map { $0.encodedString() }.joined(separator: ",") + "]"
        case .string(let value): return "\"\(escape(value))\""
        case .number(let value): return value
        case .boolean(let value): return value ? "true" : "false"
        case .null: return "null"
        }
    }

    private func escape(_ value: String) -> String {
        value.unicodeScalars.map { scalar in
            switch scalar.value {
            case 0x22: return "\\\""
            case 0x5c: return "\\\\"
            case 0x08: return "\\b"
            case 0x0c: return "\\f"
            case 0x0a: return "\\n"
            case 0x0d: return "\\r"
            case 0x09: return "\\t"
            case 0..<0x20: return String(format: "\\u%04x", scalar.value)
            default: return String(scalar)
            }
        }.joined()
    }
}

public enum StrictJSONError: Error, Equatable, Sendable {
    case invalidEncoding
    case invalidSyntax
    case duplicateKey(String)
    case trailingContent
}

public struct StrictJSONParser {
    private let bytes: [UInt8]
    private var index = 0

    public init(data: Data) throws {
        guard String(data: data, encoding: .utf8) != nil else {
            throw StrictJSONError.invalidEncoding
        }
        bytes = Array(data)
    }

    public mutating func parse() throws -> StrictJSONValue {
        skipWhitespace()
        let value = try parseValue()
        skipWhitespace()
        guard index == bytes.count else { throw StrictJSONError.trailingContent }
        return value
    }

    private mutating func parseValue() throws -> StrictJSONValue {
        guard let byte = peek() else { throw StrictJSONError.invalidSyntax }
        switch byte {
        case ascii("{"):
            return try parseObject()
        case ascii("["):
            return try parseArray()
        case ascii("\""):
            return .string(try parseString())
        case ascii("t"):
            try consumeLiteral("true")
            return .boolean(true)
        case ascii("f"):
            try consumeLiteral("false")
            return .boolean(false)
        case ascii("n"):
            try consumeLiteral("null")
            return .null
        case ascii("-"), ascii("0")...ascii("9"):
            return .number(try parseNumber())
        default:
            throw StrictJSONError.invalidSyntax
        }
    }

    private mutating func parseObject() throws -> StrictJSONValue {
        try consume(ascii("{"))
        skipWhitespace()
        var object: [String: StrictJSONValue] = [:]
        if consumeIf(ascii("}")) { return .object(object) }

        while true {
            guard peek() == ascii("\"") else { throw StrictJSONError.invalidSyntax }
            let key = try parseString()
            guard object[key] == nil else { throw StrictJSONError.duplicateKey(key) }
            skipWhitespace()
            try consume(ascii(":"))
            skipWhitespace()
            object[key] = try parseValue()
            skipWhitespace()
            if consumeIf(ascii("}")) { return .object(object) }
            try consume(ascii(","))
            skipWhitespace()
        }
    }

    private mutating func parseArray() throws -> StrictJSONValue {
        try consume(ascii("["))
        skipWhitespace()
        var values: [StrictJSONValue] = []
        if consumeIf(ascii("]")) { return .array(values) }

        while true {
            values.append(try parseValue())
            skipWhitespace()
            if consumeIf(ascii("]")) { return .array(values) }
            try consume(ascii(","))
            skipWhitespace()
        }
    }

    private mutating func parseString() throws -> String {
        try consume(ascii("\""))
        var scalarBytes: [UInt8] = []
        while let byte = peek() {
            index += 1
            if byte == ascii("\"") {
                guard let value = String(bytes: scalarBytes, encoding: .utf8) else {
                    throw StrictJSONError.invalidEncoding
                }
                return value
            }
            if byte == ascii("\\") {
                guard let escaped = peek() else { throw StrictJSONError.invalidSyntax }
                index += 1
                switch escaped {
                case ascii("\""), ascii("\\"), ascii("/"):
                    scalarBytes.append(escaped)
                case ascii("b"):
                    scalarBytes.append(0x08)
                case ascii("f"):
                    scalarBytes.append(0x0c)
                case ascii("n"):
                    scalarBytes.append(0x0a)
                case ascii("r"):
                    scalarBytes.append(0x0d)
                case ascii("t"):
                    scalarBytes.append(0x09)
                case ascii("u"):
                    let scalar = try parseUnicodeEscape()
                    scalarBytes.append(contentsOf: String(scalar).utf8)
                default:
                    throw StrictJSONError.invalidSyntax
                }
                continue
            }
            guard byte >= 0x20 else { throw StrictJSONError.invalidSyntax }
            scalarBytes.append(byte)
        }
        throw StrictJSONError.invalidSyntax
    }

    private mutating func parseUnicodeEscape() throws -> Unicode.Scalar {
        let first = try parseHexQuad()
        if (0xd800...0xdbff).contains(first) {
            try consume(ascii("\\"))
            try consume(ascii("u"))
            let second = try parseHexQuad()
            guard (0xdc00...0xdfff).contains(second) else {
                throw StrictJSONError.invalidSyntax
            }
            let value = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
            guard let scalar = Unicode.Scalar(value) else { throw StrictJSONError.invalidSyntax }
            return scalar
        }
        guard !(0xdc00...0xdfff).contains(first), let scalar = Unicode.Scalar(first) else {
            throw StrictJSONError.invalidSyntax
        }
        return scalar
    }

    private mutating func parseHexQuad() throws -> UInt32 {
        var value: UInt32 = 0
        for _ in 0..<4 {
            guard let byte = peek(), let digit = hexValue(byte) else {
                throw StrictJSONError.invalidSyntax
            }
            index += 1
            value = (value << 4) | digit
        }
        return value
    }

    private mutating func parseNumber() throws -> String {
        let start = index
        _ = consumeIf(ascii("-"))
        guard let first = peek() else { throw StrictJSONError.invalidSyntax }
        if first == ascii("0") {
            index += 1
            if let next = peek(), isDigit(next) { throw StrictJSONError.invalidSyntax }
        } else {
            guard isNonZeroDigit(first) else { throw StrictJSONError.invalidSyntax }
            repeat { index += 1 } while peek().map(isDigit) == true
        }
        if consumeIf(ascii(".")) {
            guard peek().map(isDigit) == true else { throw StrictJSONError.invalidSyntax }
            repeat { index += 1 } while peek().map(isDigit) == true
        }
        if peek() == ascii("e") || peek() == ascii("E") {
            index += 1
            if peek() == ascii("+") || peek() == ascii("-") { index += 1 }
            guard peek().map(isDigit) == true else { throw StrictJSONError.invalidSyntax }
            repeat { index += 1 } while peek().map(isDigit) == true
        }
        return String(decoding: bytes[start..<index], as: UTF8.self)
    }

    private mutating func consumeLiteral(_ literal: StaticString) throws {
        for byte in literal.withUTF8Buffer({ Array($0) }) {
            try consume(byte)
        }
    }

    private mutating func skipWhitespace() {
        while let byte = peek(), [0x20, 0x09, 0x0a, 0x0d].contains(byte) {
            index += 1
        }
    }

    private func peek() -> UInt8? {
        index < bytes.count ? bytes[index] : nil
    }

    private mutating func consume(_ byte: UInt8) throws {
        guard peek() == byte else { throw StrictJSONError.invalidSyntax }
        index += 1
    }

    private mutating func consumeIf(_ byte: UInt8) -> Bool {
        guard peek() == byte else { return false }
        index += 1
        return true
    }
}

private func ascii(_ value: Character) -> UInt8 {
    value.asciiValue!
}

private func isDigit(_ byte: UInt8) -> Bool {
    (ascii("0")...ascii("9")).contains(byte)
}

private func isNonZeroDigit(_ byte: UInt8) -> Bool {
    (ascii("1")...ascii("9")).contains(byte)
}

private func hexValue(_ byte: UInt8) -> UInt32? {
    switch byte {
    case ascii("0")...ascii("9"):
        return UInt32(byte - ascii("0"))
    case ascii("a")...ascii("f"):
        return UInt32(byte - ascii("a") + 10)
    case ascii("A")...ascii("F"):
        return UInt32(byte - ascii("A") + 10)
    default:
        return nil
    }
}
