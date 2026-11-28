// why: the host half of the simulator jail, `simlock-jail`:
//   compile <profile.sb> <output> [NAME=VALUE ...]   a simulator runtime carries no profile
//       compiler, so the profile is compiled on the Mac and the jail library applies the bytes
//   check <pid> [<pid> ...]   exits 0 only when every process is sandboxed, so whoever booted a
//       simulator can refuse one whose jail did not take
import Darwin

func fail(_ code: Int32, _ message: String) -> Never {
  fputs("simlock-jail: \(message)\n", stderr)
  exit(code)
}

func compile(_ arguments: [String]) {
  guard arguments.count >= 2 else { usage() }
  // why: libsandbox looks a relative name up among its built-in profiles, not in the working folder.
  guard let source = realpath(arguments[0], nil) else { fail(66, "cannot read \(arguments[0])") }
  guard let parameters = sandbox_create_params() else { fail(70, "cannot create parameters") }
  for pair in arguments.dropFirst(2) {
    guard let equals = pair.firstIndex(of: "="), equals != pair.startIndex else {
      fail(64, "\(pair) is not NAME=VALUE")
    }
    let name = String(pair[..<equals])
    let value = String(pair[pair.index(after: equals)...])
    // why: libsandbox keeps the two pointers instead of copying the text, so they must outlive
    // the compile; a temporary Swift hands over is gone by then.
    guard sandbox_set_param(parameters, strdup(name), strdup(value)) == 0 else {
      fail(70, "cannot set \(name)")
    }
  }
  var message: UnsafeMutablePointer<CChar>?
  guard let profile = sandbox_compile_file(source, parameters, &message) else {
    fail(65, message.map { String(cString: $0) } ?? "unknown error")
  }
  guard let output = fopen(arguments[1], "wb") else { fail(73, "cannot write \(arguments[1])") }
  let written = fwrite(profile.pointee.data, 1, profile.pointee.size, output)
  guard fclose(output) == 0, written == profile.pointee.size else {
    fail(73, "cannot write \(arguments[1])")
  }
}

func check(_ arguments: [String]) {
  guard !arguments.isEmpty else { usage() }
  var free: [String] = []
  for argument in arguments {
    guard let pid = pid_t(argument), pid > 0 else { fail(64, "\(argument) is not a process id") }
    if sandbox_check(pid, nil, 0) != 1 { free.append(argument) }
  }
  if !free.isEmpty { fail(1, "not sandboxed: \(free.joined(separator: " "))") }
}

func usage() -> Never {
  fputs(
    """
    usage: simlock-jail compile <profile.sb> <output> [NAME=VALUE ...]
           simlock-jail check <pid> [<pid> ...]

    """, stderr)
  exit(64)
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "compile": compile(Array(arguments.dropFirst()))
case "check": check(Array(arguments.dropFirst()))
default: usage()
}
