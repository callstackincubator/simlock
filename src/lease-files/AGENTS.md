# Lease files

Does: stores the files a lease's holder (or an operator) uploads over `PUT /v1/leases/{id}/files/{name}` in a folder of the worker, serves them back (with byte ranges), lists and deletes them, and removes the folder when the lease ends.

## Rules

- The module imports no `node:fs`: every read and write goes through the `Filesystem` port. It never checks an owner; the HTTP layer resolves the lease for the caller and passes the lease's grant.
- A lease's folder is `<dataDir>/lease-files/<hex(lease id)>-<grantedAt>/`, so a new lease with a reused id starts empty and two ids that differ only in case never share a folder.
- An upload goes to `.upload-<id>` in the folder and is renamed into place only after the whole body arrived. A cut or stalled body leaves nothing visible.
- Names are compared ignoring case: a PUT removes the other spellings, a lookup prefers the exact spelling, a DELETE removes every spelling. One writer per lowercase name (`FILE_BUSY`).
- A lease's bytes count what is stored plus the other running uploads' received bytes; the file a PUT replaces is not counted. The disk check runs once per upload, before the first byte is stored.
- A gateway holds no file. The worker names its own lease id in a refusal; the gateway puts the caller's back.
- `end` marks the lease ended, aborts its running uploads, waits for them and removes the folder; an upload or folder creation that finishes after that removes its own work. `sweep` at startup removes every folder whose lease is not live, upload temporary files included.
