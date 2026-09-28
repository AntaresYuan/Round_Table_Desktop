public enum ContractValidationError: Error, Equatable, Sendable {
    case malformedJSON
    case duplicateKey(String)
    case schemaMismatch(String)
    case valueMismatch(String)
    case digestMismatch
}
