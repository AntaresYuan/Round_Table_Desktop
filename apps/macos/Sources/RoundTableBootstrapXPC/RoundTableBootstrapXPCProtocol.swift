import Foundation

@objc protocol RoundTableBootstrapXPCProtocol {
    func status(reply: @escaping @Sendable (String) -> Void)
    func openSession(_ request: Data, reply: @escaping @Sendable (Data) -> Void)
    func perform(_ request: Data, bookmarkData: Data?, reply: @escaping @Sendable (Data) -> Void)
    func turnStream(_ request: Data, reply: @escaping @Sendable (Data) -> Void)
}
