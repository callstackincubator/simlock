import { sleep, whenVisible } from "../site/anim";
import {
  type Ev,
  leases,
  mmss,
  type SlotKind,
  slotWords,
  TTL,
  type Wait,
  workers,
} from "./console-story";

export default function runConsoleView(viz: HTMLElement) {
  const $ = <T extends Element = HTMLElement>(s: string) => viz.querySelector<T>(s)!;
  const $$ = <T extends Element = HTMLElement>(s: string) => [...viz.querySelectorAll<T>(s)];

  const slotEls = new Map(workers.map((w) => [w.id, $$(`[data-worker="${w.id}"] [data-slot]`)]));
  const leaseRows = $$("[data-lease]");
  const evRows = $$("[data-events] li");
  const screen = $("[data-screen]");
  const app = $("[data-app]");
  const tap = $("[data-tap]");
  const appRows = $$("[data-row]");

  let left: (number | null)[] = [];
  let wait: Wait | null = null;
  let events: Ev[] = [];
  let clock = 0;

  // why: classList edits keep Astro's scoping class, which a className rewrite would drop.
  const setSlot = (worker: string, i: number, kind: SlotKind) => {
    const el = slotEls.get(worker)![i]!;
    el.classList.remove("slot--leased", "slot--ready", "slot--booting", "slot--free");
    el.classList.add(`slot--${kind}`);
    el.title = slotWords[kind];
    const held = slotEls.get(worker)!.filter((s) => s.classList.contains("slot--leased")).length;
    $(`[data-worker="${worker}"] [data-wl]`).textContent = String(held);
  };

  const drawLeases = () => {
    leaseRows.forEach((row, i) => {
      const s = left[i];
      row.classList.toggle("is-off", s == null);
      if (s == null) return;
      row.querySelector("[data-left]")!.textContent = mmss(s);
      row.querySelector<HTMLElement>("[data-meter]")!.style.width =
        `${Math.round((s / TTL) * 100)}%`;
    });
    const held = left.filter((s) => s != null).length;
    $('[data-tile="leases"]').textContent = String(held);
    $("[data-lease-meta]").textContent = `${held} held`;
    if (left[0] != null) $("[data-expires]").textContent = mmss(left[0]);
  };

  const drawWait = () => {
    $("[data-wait]").hidden = !wait;
    $("[data-wait-empty]").hidden = !!wait;
    $('[data-tile="waiting"]').textContent = wait ? "1" : "0";
    $("[data-nav-wait]").textContent = wait ? "1" : "";
    $("[data-wait-meta]").textContent = wait ? "1 request" : "";
    $('[data-tile="wait"]').textContent = wait ? `${wait.waited}s` : "—";
    if (!wait) return;
    $('[data-w="holder"]').textContent = wait.holder;
    $('[data-w="device"]').textContent = wait.device;
    $('[data-w="stage"]').textContent = wait.stage;
    $('[data-w="waited"]').textContent = `${wait.waited}s`;
  };

  const drawEvents = () => {
    evRows.forEach((li, i) => {
      const e = events[i];
      li.style.visibility = e ? "" : "hidden";
      if (!e) return;
      const [t, n, x] = li.children;
      t!.textContent = e.time;
      n!.textContent = e.name;
      x!.textContent = e.text;
    });
  };

  const emit = (name: string, text: string) => {
    const s = 5 + clock;
    events = [{ time: `09:41:${String(s).padStart(2, "0")}`, name, text }, ...events].slice(
      0,
      evRows.length,
    );
    drawEvents();
  };

  const tick = () => {
    clock++;
    left = left.map((s) => (s == null ? s : s - 1));
    if (wait) wait.waited++;
    drawLeases();
    drawWait();
  };

  const screenOn = (on: boolean) => screen.classList.toggle("is-off", !on);

  let appRun = 0;
  const playApp = async () => {
    const run = ++appRun;
    while (run === appRun) {
      app.classList.remove("is-detail");
      const row = appRows[1 + Math.floor(Math.random() * 3)]!;
      await sleep(1100);
      if (run !== appRun) return;
      const r = row.getBoundingClientRect();
      const a = app.getBoundingClientRect();
      tap.style.left = `${r.left - a.left + r.width * 0.6}px`;
      tap.style.top = `${r.top - a.top + r.height / 2}px`;
      tap.style.opacity = "1";
      row.classList.add("is-hit");
      await sleep(300);
      tap.style.opacity = "0";
      row.classList.remove("is-hit");
      app.classList.add("is-detail");
      await sleep(1700);
    }
  };

  const reset = () => {
    for (const w of workers) w.start.forEach((k, i) => setSlot(w.id, i, k));
    left = leases.map(() => null);
    wait = null;
    events = [];
    clock = 0;
    drawLeases();
    drawWait();
    drawEvents();
    screenOn(false);
    appRun++;
    app.classList.remove("is-detail");
  };

  const grant = (i: number, slot: number) => {
    const l = leases[i]!;
    setSlot(l.worker, slot, "leased");
    left[i] = TTL;
    drawLeases();
    emit("lease.granted", `${l.holder} · ${l.device} · ${l.worker}`);
  };

  const play = async () => {
    reset();
    const timer = setInterval(tick, 1000);
    try {
      await sleep(1000);
      emit("lease.requested", "agent-1 · iPhone 17 Pro");
      await sleep(500);
      grant(0, 0);
      screenOn(true);
      void playApp();
      await sleep(2000);

      emit("lease.requested", "ci-runner-3 · iPhone 17 Pro");
      wait = { holder: "ci-runner-3", device: "iPhone 17 Pro", stage: "queued", waited: 0 };
      drawWait();
      await sleep(800);
      wait.stage = "starting";
      drawWait();
      setSlot("mac-studio-2", 0, "booting");
      await sleep(2400);
      emit("device.ready", "iPhone 17 Pro · mac-studio-2");
      await sleep(600);
      wait = null;
      drawWait();
      grant(1, 0);
      await sleep(1800);

      emit("lease.requested", "agent-3 · Pixel 8");
      await sleep(500);
      grant(2, 0);
      await sleep(1800);

      emit("lease.requested", "agent-4 · iPhone 17 Pro");
      wait = { holder: "agent-4", device: "iPhone 17 Pro", stage: "queued", waited: 0 };
      drawWait();
      await sleep(700);
      wait.stage = "starting";
      drawWait();
      setSlot("mac-studio-1", 1, "booting");
      await sleep(6000);
    } finally {
      clearInterval(timer);
      appRun++;
    }
  };

  // why: the server HTML is already the end state, so reduced motion keeps it untouched.
  whenVisible(viz, play, () => {});
}
