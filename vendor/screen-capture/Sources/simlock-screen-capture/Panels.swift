// simlock's own, MIT-licensed (see NOTICE.md): which panel of a foldable simulator to stream (#1534).
import Foundation

enum PanelRole: String {
    case cover, inner
}

enum Panels {
    /// The panel holding the picture, from one SpringBoard `DisplayContentMode` line, or nil when the
    /// line names none.
    ///
    /// why: only a settled line counts. A line whose roles carry an arrow (`.inner:off→pri`) is a
    /// transition that has just started and may still turn back; the swap line after it has none.
    ///
    /// why: the line must carry SpringBoard's own category tag. `log` opens its output with a header
    /// that repeats the filter, `.cover:pri` and `.inner:pri` both, and that header is no move.
    static func primary(inLogLine line: String) -> PanelRole? {
        guard line.contains("[com.apple.SpringBoard:DisplayContentMode]") else { return nil }
        let pattern = try! NSRegularExpression(pattern: #"\.(inner|cover):([a-z]+)(→)?"#)
        let range = NSRange(line.startIndex..., in: line)
        var primaries: [PanelRole] = []
        for match in pattern.matches(in: line, range: range) {
            if match.range(at: 3).location != NSNotFound { return nil }
            guard let role = Range(match.range(at: 1), in: line), let state = Range(match.range(at: 2), in: line) else { continue }
            if line[state] == "pri", let named = PanelRole(rawValue: String(line[role])) { primaries.append(named) }
        }
        return primaries.count == 1 ? primaries[0] : nil
    }
}
