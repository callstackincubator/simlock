import type { z } from "zod";

import type { SessionRoleResolver } from "../auth/index.js";
import {
  describeSchemaIssues,
  helloReplySchema,
  helloRequestSchema,
  negotiateProtocolVersion,
  normalizeProtocolVersion,
  type ProtocolRange,
  type Role,
} from "../contract/index.js";
import type { RequestFrame } from "../daemon-protocol/index.js";
import type { Logger } from "../ports/index.js";
import { classifyError } from "./error-code.js";
import {
  type Connection,
  errorMessage,
  parseOutput,
  respondError,
  writeFrame,
} from "./server-connection.js";

interface HandshakeOptions {
  readonly defaultRequesterId: string;
  readonly logger: Logger;
  readonly protocolRange: ProtocolRange;
  readonly resolveRole: SessionRoleResolver;
  readonly version: string;
}

export class Handshake {
  constructor(private readonly options: HandshakeOptions) {}

  // fallow-ignore-next-line complexity -- handshake validation, version negotiation, and role resolution are one sequential gate; splitting it would scatter the early-return contract.
  async handle(connection: Connection, frame: RequestFrame): Promise<void> {
    if (frame.type !== "hello") {
      await respondError(
        connection.socket,
        frame.id,
        "HANDSHAKE_REQUIRED",
        "First message must be hello",
      );
      await connection.socket.close();
      return;
    }
    const parsedHello = helloRequestSchema.safeParse(frame.payload);
    if (!parsedHello.success) {
      await respondError(
        connection.socket,
        frame.id,
        "BAD_REQUEST",
        parsedHello.error.issues.map((issue) => issue.message).join("; "),
      );
      await connection.socket.close();
      return;
    }
    const payload = parsedHello.data;
    // why: ADR 0003 §6: the daemon prefers the client's `protocolRange` when present, and treats a
    // bare `protocolVersion` as `{n, n}` only when it is not -- `helloRequestSchema` already
    // guarantees at least one of the two is present.
    const clientRange: ProtocolRange =
      payload.protocolRange ?? normalizeProtocolVersion(payload.protocolVersion as number);
    const negotiated = negotiateProtocolVersion(clientRange, this.options.protocolRange);
    // why: A resolver that rejects a bad credential throws here, before
    // `connection.helloReceived` is ever set, which is why this
    // whole block is wrapped: nothing after it should be able to run for a rejected `hello` --
    // including the version-mismatch path just below. Credential verification and role
    // resolution run *before* the version check, and independently of its outcome: ADR §6's
    // frozen exception exempts `daemon.stop` from the protocol-version gate only, never from
    // authentication, so a wrong credential must fail the handshake outright here regardless of
    // whether the versions would otherwise have matched.
    let role: Role;
    try {
      // why: ADR 0005 §5: an uplink connection's role comes from how it was accepted (this daemon
      // dialled the gateway named in its own config), so no credential is consulted -- see
      // `acceptUplink`. Every other connection resolves its role from `hello` exactly as
      // before.
      role =
        connection.forcedRole ??
        (await this.options.resolveRole.resolve({
          ...(payload.principal === undefined ? {} : { principal: payload.principal }),
          ...(payload.credential === undefined ? {} : { credential: payload.credential }),
        }));
    } catch (error: unknown) {
      await respondError(connection.socket, frame.id, errorCode(error), errorMessage(error));
      await connection.socket.close();
      return;
    }
    connection.principal = payload.principal ?? this.options.defaultRequesterId;
    connection.role = role;
    if (negotiated === undefined) {
      const details = {
        client: clientRange,
        daemon: this.options.protocolRange,
        daemonVersion: this.options.version,
      };
      const message = `No overlapping protocol version: client supports ${clientRange.min}-${clientRange.max}, daemon supports ${this.options.protocolRange.min}-${this.options.protocolRange.max}`;
      // why: `helloReceived` is still set: the handshake completed (credential verified, role
      // resolved) even though negotiation failed. `protocolMismatch` is what `DaemonServer#dispatchLine`
      // checks to refuse every subsequent operation except `daemon.stop` with this same error
      // (ADR §6). The socket is deliberately left open -- closing it here is what today's bug
      // fixes: an admin client whose range does not overlap the daemon's must still be able to
      // send `daemon.stop` on this connection instead of restarting the daemon (§6: "the client
      // never restarts the daemon on mismatch").
      connection.helloReceived = true;
      connection.protocolMismatch = { message, details };
      this.options.logger.info("Connection opened with unsupported protocol version", {
        clientVersion: payload.clientVersion,
        principal: connection.principal,
        role: connection.role,
      });
      await respondError(
        connection.socket,
        frame.id,
        "PROTOCOL_VERSION_UNSUPPORTED",
        message,
        details,
      );
      return;
    }
    connection.helloReceived = true;
    this.options.logger.info("Connection opened", {
      clientVersion: payload.clientVersion,
      principal: connection.principal,
      protocolVersion: negotiated,
      role: connection.role,
    });
    const reply = parseOutput(
      this.options.logger,
      helloReplySchema,
      {
        protocolVersion: negotiated,
        daemonProtocolRange: this.options.protocolRange,
        version: this.options.version,
        role: connection.role,
        // why: ADR §4: report the resolved principal back -- see `helloReplySchema`'s comment. Read
        // from `connection.principal`, set a few lines above from `payload.principal` or the
        // daemon's own default, so this is always the same value every subsequent dispatched
        // request is authorized against.
        principal: connection.principal,
      },
      "hello",
    );
    await writeFrame(connection.socket, { id: frame.id, ok: true, payload: reply });
  }
}

export class ProtocolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** why: Parses a request payload through its contract input schema, translating a validation
 * failure into the daemon's own `ProtocolError("BAD_REQUEST", ...)` rather than letting a raw
 * `ZodError` escape (its shape is not part of the wire contract). */
export function parseInput<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ProtocolError("BAD_REQUEST", describeSchemaIssues(result.error.issues));
}

/**
 * why: Resolves the wire `code` for a socket response. `ProtocolError` is this file's own
 * socket-framing error and carries the `code` the framing already decided (`BAD_FRAME`,
 * `BAD_REQUEST`, `UNKNOWN_REQUEST`), so it answers for itself and never reaches the shared
 * dispatcher; every other error this daemon can throw is classified by the one
 * shared table both transports read -- see `./error-code.js`'s module doc (ADR 0003 §7, review
 * finding B5: this used to be its own hand-written `instanceof` chain that silently drifted
 * from HTTP's).
 */
export function errorCode(error: unknown): string {
  if (error instanceof ProtocolError) {
    return error.code;
  }
  return classifyError(error) ?? "INTERNAL";
}
