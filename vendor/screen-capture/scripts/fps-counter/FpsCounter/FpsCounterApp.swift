// simlock's own, MIT-licensed (see NOTICE.md): the app `fps-reader.mjs` measures a stream with.
import QuartzCore
import SwiftUI

/// Counts the display link's ticks. The count is what the reader decodes from the stream.
final class Ticker: ObservableObject {
    @Published var count: UInt16 = 0
    private var link: CADisplayLink?

    func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick() {
        count &+= 1
    }
}

/// The count as 16 black or white blocks across the screen, the most significant bit first.
struct CounterRow: View {
    let count: UInt16

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<16, id: \.self) { bit in
                Rectangle()
                    .fill((count >> UInt16(15 - bit)) & 1 == 1 ? Color.white : Color.black)
            }
        }
        .frame(height: 40)
    }
}

struct ContentView: View {
    @StateObject private var ticker = Ticker()
    // why: the launch argument after the bundle id picks the scenario, so the reader needs no UI automation.
    private let scenario = CommandLine.arguments.dropFirst().first ?? "scroll"

    var body: some View {
        VStack(spacing: 0) {
            CounterRow(count: ticker.count)
            if scenario == "animation" {
                MovingSquare(count: ticker.count)
            } else {
                ScrollingList(count: ticker.count)
            }
        }
        .background(Color.gray)
        .statusBarHidden(true)
        .onAppear { ticker.start() }
    }
}

/// A list that scrolls up and down without end.
struct ScrollingList: View {
    let count: UInt16

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(0..<400, id: \.self) { row in
                        Text("Row \(row)")
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .background(row % 2 == 0 ? Color.blue.opacity(0.3) : Color.green.opacity(0.3))
                            .id(row)
                    }
                }
            }
            .onChange(of: count) { _, value in
                // why: a triangle wave over 600 ticks moves the list one way and then back.
                let phase = Int(value) % 600
                let offset = phase < 300 ? phase : 600 - phase
                proxy.scrollTo(offset, anchor: .top)
            }
        }
    }
}

/// One small square moving across the screen.
struct MovingSquare: View {
    let count: UInt16

    var body: some View {
        GeometryReader { geometry in
            let travel = max(geometry.size.width - 40, 1)
            let phase = Double(count % 240) / 120
            let position = (phase < 1 ? phase : 2 - phase) * travel
            Rectangle()
                .fill(Color.orange)
                .frame(width: 40, height: 40)
                .position(x: 20 + position, y: 100)
        }
    }
}

@main
struct FpsCounterApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
