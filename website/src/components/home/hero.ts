import { sendPacket, sleep } from "../site/anim";
import { acts } from "./story";

// why: each act runs for a fixed time, so the tab's progress bar can fill in step with it.
const DUR = [9500, 14500];

class Aborted extends Error {}

export default function runHero(root: HTMLElement) {
  const actEls = [...root.querySelectorAll<HTMLElement>("[data-act]")];
  const tabs = [...root.querySelectorAll<HTMLElement>("[data-goto]")];
  // why: a run checks its generation after every wait, so a tab click or the stage leaving the
  // viewport stops it between steps.
  let gen = 0;
  let current = 0;

  const waiter = (g: number) => async (ms: number) => {
    await sleep(ms);
    if (g !== gen) throw new Aborted();
  };
  type Wait = ReturnType<typeof waiter>;

  // why: the untyped rest stays in the line as an invisible ghost, so typing never reflows.
  const ghost = (el: HTMLElement) => {
    const text = el.dataset.text ?? (el.dataset.text = el.textContent ?? "");
    el.innerHTML = `<span></span><span class="ghost">${text}</span>`;
    return text;
  };
  const type = async (el: HTMLElement, w: Wait, speed = 24) => {
    const text = ghost(el);
    const [typed, rest] = [...el.children] as HTMLElement[];
    for (let i = 1; i <= text.length; i++) {
      typed!.textContent = text.slice(0, i);
      rest!.textContent = text.slice(i);
      await w(speed);
    }
  };
  const pkt = async (duct: HTMLElement, back: boolean, w: Wait) => {
    const p = duct.querySelector<HTMLElement>(back ? ".pkt--back" : ".pkt:not(.pkt--back)")!;
    await sendPacket(duct, p, back, 480);
    await w(0);
  };

  const setSlot = (act: HTMLElement, n: number, state: string, holder = "") => {
    const dev = act.querySelector<HTMLElement>(`[data-slot="${n}"]`)!;
    dev.querySelector<HTMLElement>(".st-phone")!.dataset.state = state;
    dev.querySelector<HTMLElement>("[data-dstate]")!.innerHTML =
      state === "leased" ? `<span class="st-live">leased</span> ${holder}` : state;
  };
  const result = (act: HTMLElement, i: number, html: string) => {
    const r = act.querySelectorAll<HTMLElement>("[data-result]")[i]!;
    r.classList.remove("is-pending");
    r.innerHTML = html;
  };
  const workers = (act: HTMLElement, n: number) => {
    const foot = act.querySelector<HTMLElement>("[data-gw-foot]");
    if (foot) {
      foot.textContent =
        n === 1 ? "1 worker connected" : n === 3 ? "3 workers connected · one URL for every agent" : `${n} workers connected`;
    }
  };

  const reset = (ai: number) => {
    const act = actEls[ai]!;
    ghost(act.querySelector<HTMLElement>("[data-cmd]")!);
    for (const t of act.querySelectorAll<HTMLElement>("[data-t]")) ghost(t);
    for (const r of act.querySelectorAll<HTMLElement>("[data-result]")) r.classList.add("is-pending");
    for (const dev of act.querySelectorAll<HTMLElement>("[data-slot]")) {
      setSlot(act, Number(dev.dataset.slot), dev.dataset.start!);
    }
    for (const r of act.querySelectorAll<HTMLElement>("[data-route]")) r.classList.remove("is-on");
    if (act.querySelector("[data-gw-foot]")) {
      for (const m of act.querySelectorAll<HTMLElement>("[data-machine]")) {
        if (m.dataset.machine === "0") continue;
        m.classList.add("is-joining");
        m.querySelector<HTMLElement>("[data-mfoot]")!.textContent = "not joined yet";
      }
      workers(act, 1);
    }
  };

  const lane = async (ai: number, i: number, w: Wait) => {
    const act = actEls[ai]!;
    const a = acts[ai]!.agents[i]!;
    const up = act.querySelector<HTMLElement>(`[data-up="${i}"]`)!;
    const down = act.querySelector<HTMLElement>(`[data-down="${i}"]`);
    await type(act.querySelectorAll<HTMLElement>("[data-t]")[i]!, w, 22);
    result(act, i, '<span class="st-dim">waiting</span>');
    await pkt(up, false, w);
    if (down) {
      act.querySelector<HTMLElement>(`[data-route="${i}"]`)!.classList.add("is-on");
      await w(350);
      await pkt(down, false, w);
    }
    if (a.boots) {
      setSlot(act, a.slot, "booting");
      result(act, i, '<span class="st-dim">booting</span>');
      await w(1700);
    }
    setSlot(act, a.slot, "leased", a.agent);
    if (down) await pkt(down, true, w);
    await pkt(up, true, w);
    result(act, i, `<span class="st-live">granted</span> ${a.route?.worker ?? a.device}`);
  };

  const join = async (act: HTMLElement, mi: number, w: Wait) => {
    const m = act.querySelector<HTMLElement>(`[data-machine="${mi}"]`)!;
    m.classList.remove("is-joining");
    m.classList.add("is-flash");
    m.querySelector<HTMLElement>("[data-mfoot]")!.textContent = m.dataset.foot ?? "";
    workers(act, mi + 1);
    await w(300);
    m.classList.remove("is-flash");
  };

  const play = async (ai: number, w: Wait) => {
    const act = actEls[ai]!;
    const start = performance.now();
    reset(ai);
    await w(500);
    await type(act.querySelector<HTMLElement>("[data-cmd]")!, w);
    await w(400);
    const machines = act.querySelectorAll("[data-machine]").length;
    if (act.querySelector("[data-gw-foot]")) {
      for (let mi = 1; mi < machines; mi++) {
        await join(act, mi, w);
        await w(mi < machines - 1 ? 500 : 700);
      }
    }
    const gap = ai === 0 ? 900 : 1200;
    await Promise.all(acts[ai]!.agents.map((_, i) => w(i * gap).then(() => lane(ai, i, w))));
    await w(Math.max(1200, DUR[ai]! - (performance.now() - start)));
  };

  const show = (ai: number, progress: boolean) => {
    current = ai;
    actEls.forEach((a, i) => a.classList.toggle("is-on", i === ai));
    tabs.forEach((t, i) => {
      t.classList.remove("is-on", "is-playing");
      if (i !== ai) return;
      t.style.setProperty("--dur", `${DUR[ai]}ms`);
      // why: reading layout between removing and adding the class restarts the bar's animation.
      void t.offsetWidth;
      t.classList.add("is-on");
      if (progress) t.classList.add("is-playing");
    });
  };

  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let visible = false;

  const run = (from: number) => {
    const w = waiter(++gen);
    if (still || !visible) {
      show(from, false);
      return;
    }
    void (async () => {
      for (let ai = from; ; ai = (ai + 1) % actEls.length) {
        show(ai, true);
        await play(ai, w);
      }
    })().catch((e: unknown) => {
      if (!(e instanceof Aborted)) throw e;
    });
  };

  tabs.forEach((t, i) => t.addEventListener("click", () => run(i)));
  new IntersectionObserver(([entry]) => {
    const now = !!entry?.isIntersecting;
    if (now === visible) return;
    visible = now;
    // why: off screen the run stops; back on screen, the act it was on plays again from the start.
    if (!visible) gen++;
    run(current);
  }).observe(root);
}
