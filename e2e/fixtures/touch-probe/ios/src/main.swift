import UIKit

// A touch probe: draws a dot where it is touched and appends the touch's fraction of its window to
// Documents/touches.txt, one "x,y" line per touch that ends.
final class ProbeView: UIView {
    private let dot = UIView(frame: CGRect(x: 0, y: 0, width: 24, height: 24))

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .white
        dot.backgroundColor = .red
        dot.layer.cornerRadius = 12
        dot.isHidden = true
        addSubview(dot)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard let touch = touches.first, let window = window else { return }
        let point = touch.location(in: window)
        dot.center = touch.location(in: self)
        dot.isHidden = false
        let line = String(format: "%.3f,%.3f\n", point.x / window.bounds.width, point.y / window.bounds.height)
        let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("touches.txt")
        if let handle = try? FileHandle(forWritingTo: file) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: file)
        }
    }
}

// iOS 27 ends an app that does not adopt the scene lifecycle, so the window is made in a scene.
@objc(TouchProbeSceneDelegate)
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        let controller = UIViewController()
        controller.view = ProbeView(frame: window.bounds)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
    }
}

final class AppDelegate: UIResponder, UIApplicationDelegate {}

UIApplicationMain(CommandLine.argc, CommandLine.unsafeArgv, nil, NSStringFromClass(AppDelegate.self))
