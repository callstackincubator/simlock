import { sendPacket, sleep, whenVisible } from "../site/anim";
import { lanes } from "./story";

type PhoneState = "idle" | "provisioning" | "booting" | "leased";

export default function runFleetHero(viz: HTMLElement) {
  const q = <T extends Element = HTMLElement>(sel: string) => viz.querySelector<T>(sel);
  const parts = lanes.map((lane, i) => {
    const term = q(`[data-lane="${i}"]`)!;
    const t = term.querySelector<HTMLElement>("[data-t]")!;
    const worker = q(`[data-worker="${i}"]`)!;
    const gw = q(`[data-gw="${i}"]`)!;
    const up = q(`[data-up="${i}"]`)!;
    const down = q(`[data-down="${i}"]`)!;
    return {
      lane,
      text: t.textContent ?? "",
      t,
      steps: [...term.querySelectorAll<HTMLElement>("[data-step]")],
      state: term.querySelector<HTMLElement>("[data-state]")!,
      phone: worker.querySelector<HTMLElement>("[data-phone]")!,
      wstate: worker.querySelector<HTMLElement>("[data-wstate]")!,
      gw,
      gwState: gw.querySelector<HTMLElement>("[data-gw-state]")!,
      up,
      down,
    };
  });
  if (parts.some((p) => !p.t)) return;

  const setPhone = (p: (typeof parts)[number], s: PhoneState) => {
    p.phone.dataset.state = s;
    p.wstate.innerHTML =
      s === "leased"
        ? `<span class="va-live">leased</span> ${p.lane.agent}`
        : s === "idle"
          ? '<span class="va-idle">idle</span>'
          : s;
  };

  const reset = () => {
    for (const p of parts) {
      p.t.innerHTML = `<span></span><span class="ghost">${p.text}</span>`;
      for (const s of p.steps) s.classList.add("is-pending");
      p.gw.classList.remove("is-on");
      setPhone(p, "idle");
    }
  };

  const type = async (p: (typeof parts)[number]) => {
    const [typed, rest] = [...p.t.children] as HTMLElement[];
    for (let i = 1; i <= p.text.length; i++) {
      typed!.textContent = p.text.slice(0, i);
      rest!.textContent = p.text.slice(i);
      await sleep(26);
    }
  };

  const setState = (p: (typeof parts)[number], s: string) => {
    p.state.textContent = s;
    p.gwState.textContent = s;
  };

  const run = async (p: (typeof parts)[number]) => {
    await type(p);
    p.steps[0]!.classList.remove("is-pending");
    await sendPacket(p.up, p.up.querySelector(".pkt")!, false, 520);
    setState(p, p.lane.stages[0] ?? "granted");
    p.gw.classList.add("is-on");
    await sendPacket(p.down, p.down.querySelector(".pkt")!, false, 520);
    for (const stage of p.lane.stages) {
      setState(p, stage);
      p.steps[1]!.classList.remove("is-pending");
      setPhone(p, stage);
      await sleep(stage === "provisioning" ? 2200 : 1300);
    }
    setPhone(p, "leased");
    await sendPacket(p.down, p.down.querySelector(".pkt--back")!, true, 520);
    await sendPacket(p.up, p.up.querySelector(".pkt--back")!, true, 520);
    setState(p, "granted");
    for (const s of p.steps) s.classList.remove("is-pending");
  };

  const play = async () => {
    reset();
    await sleep(700);
    await Promise.all(parts.map((p, i) => sleep(i * 1500).then(() => run(p))));
    await sleep(4200);
  };

  whenVisible(viz, play, () => {});
}
