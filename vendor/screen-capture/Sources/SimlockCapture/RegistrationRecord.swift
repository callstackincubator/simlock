import Foundation

/// The frame-callback UUIDs a capture program has registered on one simulator, kept in a file so
/// the next program on that simulator can unregister those a SIGKILL or a crash left behind.
public struct RegistrationRecord {
    public init(deviceUDID: String, directory: URL = URL(fileURLWithPath: NSTemporaryDirectory())) {}

    /// Replaces the record with `uuids`.
    public func write(_ uuids: [UUID]) {}

    /// The UUIDs a program that did not stop left, forgotten once returned.
    public func takeLeftovers() -> [UUID] { [] }

    /// Forgets the record: the program stopped, so it left nothing behind.
    public func clear() {}
}
