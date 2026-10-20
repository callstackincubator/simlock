import { animate, type DitherOptions } from "./dither";

type Message =
  | ({ type: "init"; id: number; canvas: OffscreenCanvas } & DitherOptions)
  | { type: "size"; id: number; width: number; height: number }
  | { type: "visible"; id: number; on: boolean };

const runs = new Map<number, ReturnType<typeof animate>>();

self.onmessage = (event: MessageEvent<Message>) => {
  const m = event.data;
  if (m.type === "init") runs.set(m.id, animate(m.canvas, m));
  else if (m.type === "size") runs.get(m.id)?.setSize(m.width, m.height);
  else runs.get(m.id)?.setVisible(m.on);
};
