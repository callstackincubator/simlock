import { sleep } from "../site/anim";
import { type Agent, prompt, steps, tokens } from "./story";

// why: each step runs for a fixed time, so its button can fill in step with it.
const DUR = [9500, 11500];
const FPS = 12;

class Aborted extends Error {}

export default function runHero(root: HTMLElement) {
  const stage = root.querySelector<HTMLElement>(".st-stage")!;
  const svg = root.querySelector<SVGSVGElement>("[data-wires]")!;
  const buttons = [...root.querySelectorAll<HTMLElement>("[data-goto]")];
  const caps = [...root.querySelectorAll<HTMLElement>("[data-cap]")];
  const chips = [...root.querySelectorAll<HTMLElement>("[data-agent]")];
  const gw = root.querySelector<HTMLElement>("[data-gw]")!;
  const machines = [...root.querySelectorAll<HTMLElement>("[data-machine]")];
  const dev = (mi: number, si: number) => machines[mi]!.querySelectorAll<HTMLElement>("[data-dev]")[si]!;
  const fleetMachines = steps[1]!.machines;
  const machineOf = (a: Agent) => fleetMachines.findIndex((m) => m.name === a.worker);

  // why: a run checks its generation after every wait, so a click or the stage leaving the
  // viewport stops it between steps.
  let gen = 0;
  let current = 0;
  const waiter = (g: number) => async (ms: number) => {
    await sleep(ms);
    if (g !== gen) throw new Aborted();
  };
  type Wait = ReturnType<typeof waiter>;
  const quiet = (p: Promise<unknown>) =>
    void p.catch((e: unknown) => {
      if (!(e instanceof Aborted)) throw e;
    });

  // why: every line is built from text nodes, so no text is ever parsed as markup.
  const span = (text: string, cls = "") => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = text;
    return s;
  };
  const say = (el: HTMLElement, word: string, cls: string, rest = "") => {
    el.replaceChildren(span(word, cls), ...(rest ? [` ${rest}`] : []));
  };

  // why: wires are measured from the boxes, so they always start and end on an edge. Each box
  // spreads its wires along that edge, so no two wires meet at one point; with a gateway, every
  // agent goes through it.
  type End = { x: number; y: number };
  const edge = (el: Element, side: "l" | "r", i = 0, n = 1): End => {
    const r = el.getBoundingClientRect();
    return { x: side === "r" ? r.right : r.left, y: r.top + (r.height * (i + 1)) / (n + 1) };
  };
  let up: SVGPathElement[] = [];
  let down: SVGPathElement[] = [];
  const path = (a: End, b: End) => {
    const o = svg.getBoundingClientRect();
    const [x1, y1, x2, y2] = [a.x - o.left, a.y - o.top, b.x - o.left, b.y - o.top];
    const mx = Math.round((x1 + x2) / 2);
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", `M${x1} ${y1} H${mx} V${y2} H${x2}`);
    svg.append(p);
    return p;
  };
  const wired = () => getComputedStyle(svg).display !== "none";
  const draw = () => {
    svg.replaceChildren();
    up = [];
    down = [];
    if (!wired()) return;
    if (current === 0) {
      up = chips.map((c, i) => path(edge(c, "r"), edge(machines[0]!, "l", i, chips.length)));
      return;
    }
    up = chips.map((c, i) => path(edge(c, "r"), edge(gw, "l", i, chips.length)));
    down = machines.map((m, i) => path(edge(gw, "r", i, machines.length), edge(m, "l")));
  };
  const route = (a: Agent) => (current === 0 ? [up] : [up, down]).map((ps, k) => ps[k === 0 ? steps[current]!.agents.indexOf(a) : machineOf(a)]);

  // why: a packet hops along a wire at the dither's 12 fps, starting and stopping clear of the
  // boxes at its ends.
  const packet = async (p: SVGPathElement | undefined, back: boolean, ms: number, w: Wait) => {
    if (!p || !p.isConnected) return;
    const k = span("", back ? "st-pkt is-back" : "st-pkt");
    stage.append(k);
    p.classList.add("is-live");
    const len = p.getTotalLength();
    const n = Math.max(4, Math.round((ms / 1000) * FPS));
    try {
      for (let i = 0; i <= n; i++) {
        if (!p.isConnected) break;
        const f = back ? 1 - i / n : i / n;
        const pt = p.getPointAtLength(Math.min(len - 5, Math.max(5, len * f)));
        k.style.left = `${pt.x}px`;
        k.style.top = `${pt.y}px`;
        await w(ms / n);
      }
    } finally {
      k.remove();
      p.classList.remove("is-live");
    }
  };

  // why: the untyped rest stays in the line as an invisible ghost, so typing never reflows.
  const command = (el: HTMLElement, a: Agent, typed: number) => {
    const parts = tokens(a.cmd);
    const out: Node[] = [span(`${prompt(a.via)} `, "p")];
    let left = typed;
    for (const t of parts) {
      const shown = t.text.slice(0, Math.max(0, left));
      left -= t.text.length;
      if (shown) out.push(span(shown, t.cls));
    }
    out.push(span(a.cmd.slice(Math.max(0, typed)), "ghost"));
    el.replaceChildren(...out);
  };
  const type = async (el: HTMLElement, a: Agent, w: Wait) => {
    for (let i = 1; i <= a.cmd.length; i++) {
      command(el, a, i);
      await w(18);
    }
  };
  const granted = (a: Agent) => (a.via === "AGENT-DEVICE" ? "streaming" : "granted");

  const setDev = (d: HTMLElement, state: string, label?: [string, string]) => {
    d.querySelector<HTMLElement>(".st-phone")!.dataset.state = state;
    const l = d.querySelector<HTMLElement>("[data-dstate]")!;
    if (label) say(l, label[0], label[1]);
    else l.textContent = state;
  };
  const flash = async (el: HTMLElement, ms: number, w: Wait) => {
    el.classList.add("is-flash");
    try {
      await w(ms);
    } finally {
      el.classList.remove("is-flash");
    }
  };
  // why: the app the agent drives, as its screen streams: it opens, signs in and searches.
  const stream = (d: HTMLElement, view: "splash" | "signin" | "home", typed = 1) => {
    const s = d.querySelector<HTMLElement>(".st-stream");
    if (!s) return;
    s.dataset.view = view;
    const q = s.querySelector<HTMLElement>("[data-q]")!;
    q.classList.toggle("is-focus", typed > 0);
    q.style.setProperty("--typed", `${Math.round(typed * 45)}%`);
    for (const r of s.querySelectorAll<HTMLElement>("[data-f]")) r.classList.toggle("is-gone", typed >= 1);
  };
  const tap = async (d: HTMLElement, target: HTMLElement, w: Wait) => {
    const t = d.querySelector<HTMLElement>(".st-tap")!;
    const box = d.querySelector<HTMLElement>(".st-stream")!.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    t.style.left = `${r.left - box.left + r.width / 2}px`;
    t.style.top = `${r.top - box.top + r.height / 2}px`;
    t.classList.remove("is-on");
    void t.offsetWidth;
    t.classList.add("is-on");
    await w(400);
  };
  const live = async (d: HTMLElement, a: Agent, w: Wait, act: { on: boolean }) => {
    d.classList.add("is-live");
    stream(d, "splash", 0);
    // why: frames flow back to the agent along its route while the step lasts.
    const frames = async () => {
      while (act.on) {
        const r = route(a);
        await packet(r[r.length - 1], true, 400, w);
        if (r.length > 1) await packet(r[0], true, 400, w);
        await w(300);
      }
    };
    quiet(frames());
    await w(600);
    stream(d, "signin", 0);
    await w(1400);
    await tap(d, d.querySelector<HTMLElement>("[data-tap]")!, w);
    stream(d, "home", 0);
    await w(1000);
    for (let i = 1; i <= 5; i++) {
      stream(d, "home", i / 5 - 0.001);
      await w(110);
    }
    await w(300);
    stream(d, "home", 1);
  };

  const setAgents = (si: number, frame: boolean) => {
    steps[si]!.agents.forEach((a, i) => {
      const c = chips[i]!;
      c.querySelector<HTMLElement>("[data-via]")!.textContent = a.via;
      c.querySelector<HTMLElement>("[data-title]")!.textContent = `${a.agent} · ${a.where}`;
      command(c.querySelector<HTMLElement>("[data-cmd]")!, a, frame ? a.cmd.length : 0);
      const r = c.querySelector<HTMLElement>("[data-result]")!;
      if (frame) say(r, granted(a), "st-live", a.result);
      else r.replaceChildren(span(`${granted(a)} ${a.result}`, "ghost"));
    });
  };
  // why: a step's devices before anyone leases (start) or once every agent holds one (frame).
  const setDevices = (si: number, frame: boolean) => {
    fleetMachines.forEach((m, mi) =>
      m.devices.forEach((d, di) => {
        const el = dev(mi, di);
        el.classList.remove("is-live");
        const a = frame ? steps[si]!.agents.find((x) => machineOf(x) === mi && x.slot === di) : undefined;
        if (!a) return setDev(el, d.start);
        setDev(el, "leased", [a.agent, "st-live"]);
        if (a.via === "AGENT-DEVICE") {
          el.classList.add("is-live");
          stream(el, "home", 1);
        }
      }),
    );
  };
  const show = (si: number, frame: boolean, playing: boolean) => {
    current = si;
    stage.dataset.step = String(si);
    for (const m of machines) m.classList.remove("is-joining", "is-joined", "is-flash");
    buttons.forEach((b, i) => {
      b.classList.remove("is-on", "is-playing", "is-done");
      b.setAttribute("aria-pressed", String(i === si));
      if (i !== si) return;
      b.style.setProperty("--dur", `${DUR[si]}ms`);
      // why: reading layout between removing and adding the class restarts the fill.
      void b.offsetWidth;
      b.classList.add("is-on", playing ? "is-playing" : "is-done");
    });
    caps.forEach((c, i) => {
      c.classList.toggle("is-on", i === si);
      if (i === si) c.removeAttribute("aria-hidden");
      else c.setAttribute("aria-hidden", "true");
    });
    setAgents(si, frame);
    setDevices(si, frame);
    draw();
  };

  const lane = async (a: Agent, i: number, w: Wait, act: { on: boolean }) => {
    const c = chips[i]!;
    const result = c.querySelector<HTMLElement>("[data-result]")!;
    const d = dev(machineOf(a), a.slot);
    await type(c.querySelector<HTMLElement>("[data-cmd]")!, a, w);
    say(result, "waiting", "st-dim");
    for (const p of route(a)) await packet(p, false, 400, w);
    if (!a.warm) {
      setDev(d, "booting");
      say(result, "booting", "st-dim");
      await w(1300);
    }
    setDev(d, "leased", [a.agent, "st-live"]);
    quiet(flash(d.querySelector<HTMLElement>(".st-phone")!, 160, w));
    if (a.via === "AGENT-DEVICE") quiet(live(d, a, w, act));
    else for (const p of route(a).reverse()) await packet(p, true, 400, w);
    say(result, granted(a), "st-live", a.result);
  };

  // why: after step one, the fleet starts with your-mac's leases ending: each device is cleaned,
  // and only the iPhone is kept ready. Started by a click, they are simply ready.
  const play = async (si: number, w: Wait, after: boolean) => {
    const act = { on: true };
    const start = performance.now();
    show(si, false, true);
    try {
      if (si === 1) {
        if (after) {
          fleetMachines[0]!.devices.forEach((_, di) => setDev(dev(0, di), "cleaning"));
          quiet(
            w(1200).then(() => fleetMachines[0]!.devices.forEach((d, di) => setDev(dev(0, di), d.start))),
          );
        }
        machines.slice(1).forEach((m) => m.classList.add("is-joined", "is-joining"));
        for (const m of machines.slice(1)) {
          await w(650);
          m.classList.remove("is-joining");
          await flash(m, 240, w);
        }
      }
      await w(si === 0 ? 400 : 300);
      await Promise.all(steps[si]!.agents.map((a, i) => w(i * 1300).then(() => lane(a, i, w, act))));
      await w(Math.max(800, DUR[si]! - (performance.now() - start)));
    } finally {
      act.on = false;
    }
  };

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let visible = false;

  const run = (from: number) => {
    const w = waiter(++gen);
    if (still || !visible) {
      show(from, true, false);
      return;
    }
    quiet(
      (async () => {
        for (let si = from, after = false; ; si = (si + 1) % steps.length, after = true) {
          await play(si, w, after && si === 1);
        }
      })(),
    );
  };

  buttons.forEach((b, i) => b.addEventListener("click", () => run(i)));
  // why: boxes that fade in, fonts that load and a resized window all move the boxes, so the
  // wires are drawn again whenever the stage changes size or a box finishes appearing.
  stage.addEventListener("animationend", (e) => {
    if ((e.target as Element).matches(".st-gw, .st-machine")) draw();
  });
  new ResizeObserver(() => draw()).observe(stage);
  void document.fonts.ready.then(draw);
  new IntersectionObserver(([entry]) => {
    const now = !!entry?.isIntersecting;
    if (now === visible) return;
    visible = now;
    // why: off screen the run stops; back on screen, the step it was on plays again from the start.
    if (!visible) gen++;
    run(current);
  }).observe(root);
}
