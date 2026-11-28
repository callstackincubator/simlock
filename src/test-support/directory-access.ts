import { FakeDirectoryAccessReader } from "../ports/index.js";

// why: on Windows the production reader runs `powershell.exe` before a daemon serves, so every daemon a test starts passes this one (#1932).
export function fakeDirectoryAccess(): FakeDirectoryAccessReader {
  return new FakeDirectoryAccessReader({ user: "S-1-5-21-1-2-3-1001", entries: [] });
}
