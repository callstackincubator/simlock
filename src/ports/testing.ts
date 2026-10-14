// why: the real WebSocket adapters stay out of the ports barrel so the CLI never loads `ws`; tests that need them import them from here.
export { WebSocketUplinkConnector, WebSocketUplinkListenerFactory } from "./uplink-websocket.js";
