// why: this library is loaded into `launchd_sim` (DYLD_INSERT_LIBRARIES on `simctl boot`) and, with
// the environment `launchd_sim` passes on, into every process of that simulator. Nothing in the
// driver boots a simulator with it yet.
import Darwin

// why: a stock simulator has no sandbox, so there every advisory check answers "allowed" and "is
// this process sandboxed?" answers no. iOS daemons ask before they talk to each other (SpringBoard
// stops when a lookup check says no) and `log` refuses to run sandboxed, so they get the stock
// answer. Only honest processes are helped: the kernel and the host's launchd still refuse.
@_cdecl("simlock_jail_allowed") func jailAllowed() -> Int32 { 0 }

// why: `launchd_sim` makes its socket folders in /private/var/tmp, which every simulator of the
// worker shares. A per-simulator token in the name lets a profile allow this simulator's folders
// and no other's. The name keeps its length, because the caller owns the buffer.
@_cdecl("simlock_jail_mkdtemp")
func jailMkdtemp(_ template: UnsafeMutablePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
  let prefix = "/private/var/tmp/com.apple.launchd."
  let length = prefix.utf8.count
  if let template, let token = getenv("SIMLOCK_JAIL_TOKEN"), strlen(token) == 6,
    strncmp(template, prefix, length) == 0, strcmp(template + length, "XXXXXXXXXX") == 0
  {
    memcpy(template + length, token, 6)
  }
  return mkdtemp(template)
}

typealias Check = @convention(c) () -> Int32
typealias SelfCheck = @convention(c) (pid_t, UnsafePointer<CChar>?, Int32) -> Int32
typealias MakeTemp = @convention(c) (UnsafeMutablePointer<CChar>?) -> UnsafeMutablePointer<CChar>?

// why: dyld reads this section as (replacement, original) pairs and redirects every other image's
// calls; calls made from this library still reach the original.
@used @section("__DATA,__interpose")
let interposeCheck: (Check, SelfCheck) = (jailAllowed, sandbox_check)
@used @section("__DATA,__interpose")
let interposeCheckByToken: (Check, Check) = (jailAllowed, sandbox_check_by_audit_token)
@used @section("__DATA,__interpose")
let interposeCheckById: (Check, Check) = (jailAllowed, sandbox_check_by_uniqueid)
@used @section("__DATA,__interpose")
let interposeMakeTemp: (MakeTemp, MakeTemp) = (jailMkdtemp, mkdtemp)

// why: dyld runs this before the process's own code. `launchd_sim` is not sandboxed yet, so it
// applies the compiled profile there; the kernel gives the same sandbox to every child, which is
// why a process that is already sandboxed does nothing. A simulator that cannot be jailed must not
// run, so every failure ends the process.
@used @section("__DATA,__mod_init_func")
let enterJail: @convention(c) () -> Void = {
  guard let path = getenv("SIMLOCK_JAIL_PROFILE") else { return }
  if sandbox_check(getpid(), nil, 0) == 1 { return }
  let file = open(path, O_RDONLY)
  guard file >= 0 else { _exit(78) }
  var bytes = [UInt8](repeating: 0, count: 1 << 20)
  let count = read(file, &bytes, bytes.count)
  close(file)
  guard count > 0 else { _exit(78) }
  let applied = bytes.withUnsafeBufferPointer { buffer in
    var profile = simlock_jail_profile(
      data: buffer.baseAddress, size: count, container: nil, container_len: 0)
    return __sandbox_ms("Sandbox", 0, &profile)
  }
  guard applied == 0 else { _exit(78) }
  _sandbox_enter_notify_libxpc()
}
