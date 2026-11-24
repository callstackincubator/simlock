// why: a Windows developer's shell may set MSYS_NO_PATHCONV=1 (turbo's `//#task` names need it), and
// the scripts the tests start in Git Bash hand MSYS paths such as `/tmp/...` to node and git, which
// open them only when Git Bash converts them, as it does on CI.
if (process.platform === "win32") delete process.env["MSYS_NO_PATHCONV"];
