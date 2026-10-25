export type StreamRole = "agent" | "operator";

export interface StreamCaller {
  readonly principal: string;
  readonly role: StreamRole;
}
