// simlock's own, MIT-licensed (see NOTICE.md).
//
// The one place the CoreDevice version floor is enforced (architecture rule: one place enforces a
// rule). It runs before any CoreDevice call, because this program links the framework `weak` and an
// older CoreDevice lacks what the stubs declare.
import Foundation

enum CoreDeviceVersion {
    /// The oldest major this program's stubs were written against. A later major goes on: Apple
    /// builds CoreDevice with library evolution, so a later major keeps the stubs' calls unless it
    /// drops or renames one, and then the program stops at that call.
    static let minimumMajor = 642

    static let requirement =
        "Physical iPhone streams need Xcode 27 or later (CoreDevice \(minimumMajor) or later); "

    static let infoPlist =
        "/Library/Developer/PrivateFrameworks/CoreDevice.framework/Resources/Info.plist"

    /// The version string the framework reports, or why it could not be read.
    enum Reading {
        case version(String)
        case absent
        case unreadable
    }

    /// `SIMLOCK_COREDEVICE_INFO_PLIST` exists for the slow lane, which cannot install a different
    /// CoreDevice onto the Mac it runs on. The driver never passes it, and strips it from a daemon's
    /// environment, so no operator's configuration can point the floor at another file.
    static func read(environment: [String: String] = ProcessInfo.processInfo.environment) -> Reading {
        let path = environment["SIMLOCK_COREDEVICE_INFO_PLIST"] ?? infoPlist
        guard FileManager.default.fileExists(atPath: path) else { return .absent }
        guard let contents = FileManager.default.contents(atPath: path),
              let plist = try? PropertyListSerialization.propertyList(from: contents, format: nil),
              let dictionary = plist as? [String: Any],
              case let value? = dictionary["CFBundleShortVersionString"] as? String
        else {
            return .unreadable
        }
        return .version(value)
    }

    /// The text before the first `.`, with surrounding spaces trimmed; the whole string when it
    /// carries no dot. `6420.1` is therefore `6420`, not `642` — the comparison is on the major, not
    /// on a prefix.
    static func major(of version: String) -> String {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let dot = trimmed.firstIndex(of: ".") else { return trimmed }
        return String(trimmed[..<dot]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The reason this Mac cannot stream an iPhone, or nil when it can.
    static func refusal(for reading: Reading) -> String? {
        switch reading {
        case .absent:
            return requirement + "this Mac has no CoreDevice"
        case .unreadable:
            return requirement + "this Mac's CoreDevice version cannot be read"
        case .version(let value):
            guard let found = Int(major(of: value)), found >= minimumMajor else {
                return requirement
                    + "this Mac has CoreDevice \(value.trimmingCharacters(in: .whitespacesAndNewlines))"
            }
            return nil
        }
    }
}
