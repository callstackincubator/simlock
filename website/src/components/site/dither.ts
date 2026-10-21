// why: generated in the browser instead of shipped as an image, so it follows the accent. It runs
// in the dither worker and in the social card's page (og/og.html), so keep it free of DOM access.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((n) => (n + 0.5) / 16);

const hash = (x: number, y: number) => {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
const noise = (x: number, y: number, period = 0) => {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const x0 = period ? ((xi % period) + period) % period : xi;
  const x1 = period ? (x0 + 1) % period : xi + 1;
  const a = hash(x0, yi);
  const b = hash(x1, yi);
  const c = hash(x0, yi + 1);
  const d = hash(x1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
};
const fbm = (x: number, y: number, octaves = 4, period = 0) => {
  let sum = 0;
  let amp = 0.5;
  let p = period;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x, y, p);
    x *= 2;
    y *= 2;
    p *= 2;
    amp *= 0.5;
  }
  return sum / (1 - Math.pow(0.5, octaves));
};
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

type Scene = { frame: (t: number) => Float32Array };
type SceneBuilder = (cols: number, rows: number, focus: number, mark: readonly string[]) => Scene;

function mistTexture(cols: number, rows: number, scaleX: number, scaleY: number) {
  const tex = new Float32Array(cols * rows);
  const period = Math.max(1, Math.round(scaleX));
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      tex[y * cols + x] = fbm((x / cols) * period, (y / rows) * scaleY, 4, period);
    }
  }
  return tex;
}

export const PILLAR = ["..#..", ".###.", "#####", "#####", "#####", "#####", "#####", ".###."];

type Stone = {
  cx: number;
  base: number;
  step: number;
  depth: number;
  speed: number;
  phase: number;
  hollow?: boolean;
};

function markScene(
  cols: number,
  rows: number,
  focus: number,
  bitmap: readonly string[],
  hollow = false,
): Scene {
  const shape = bitmap.length ? bitmap : PILLAR;
  const H = shape.length;
  const W = Math.max(...shape.map((r) => r.length));
  const filled = (c: number, r: number) => r >= 0 && r < H && shape[r]![c] === "#";
  const reach = shape.map((row) => {
    let m = 0;
    for (let c = 0; c < row.length; c++)
      if (row[c] === "#") m = Math.max(m, Math.abs(c + 0.5 - W / 2) + 0.5);
    return Math.max(m, 0.5);
  });

  const out = new Float32Array(cols * rows);
  const aspect = cols / rows;
  const owner = new Int16Array(cols * rows).fill(-1);
  const shade = new Float32Array(cols * rows);
  const height = new Float32Array(cols * rows);
  const rock = new Float32Array(cols * rows);
  const diag = new Float32Array(cols * rows);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const d = Math.hypot((x / cols - focus) * aspect, (y / rows - 0.62) * 1.2);
      const grain = fbm((x / cols) * 9 * aspect * 0.5, (y / rows) * 9, 4);
      rock[i] = 0.12 * smooth(0.52, 0.85, grain) + 0.12 * Math.exp(-d * d * 4.5);
      diag[i] = (x / cols) * aspect * 0.55 + y / rows;
    }
  }

  // why: sizes follow the shorter side, so a tall phone-width scene doesn't get huge steps, and
  // are capped (280 cells tall at most), so the steps keep reading as pixels instead of a city
  // skyline.
  const size = Math.min(rows, cols * 0.8);
  const unit = Math.min(size, 280) / H;
  const stones: Stone[] = [];
  const add = (u: number, baseFromBottom: number, h: number, depth: number, seed: number) =>
    stones.push({
      cx: Math.round(u * cols),
      base: Math.round(rows + baseFromBottom * size),
      step: Math.max(1, Math.round(h * unit)),
      depth,
      speed: 0.12 + 0.1 * hash(seed, 3),
      phase: hash(seed, 9) * 3,
    });
  const bed = Math.max(8, Math.round(aspect * 7));
  for (let k = 0; k < bed; k++) {
    const u = (k + 0.2 + 0.6 * hash(k, 1)) / bed;
    const near = Math.exp(-(((u - focus) / 0.28) ** 2));
    const h = 0.1 + 0.12 * hash(k, 2) + 0.12 * near;
    add(u, 0.04 + 0.06 * hash(k, 5), h, 0.42 + 0.3 * near, k + 10);
  }
  for (let k = 0; k < Math.round(aspect * 3); k++) {
    const u = hash(k, 21);
    if (Math.abs(u - focus) < 0.12) continue;
    add(u, -0.35 - 0.5 * hash(k, 22), 0.025 + 0.03 * hash(k, 23), 0.38, k + 40);
  }
  const n = 13;
  for (let k = 0; k < n; k++) {
    const o = (k / (n - 1) - 0.5) * 2 + (hash(k, 61) - 0.5) * 0.12;
    const h = 0.5 * (1 - 0.6 * Math.abs(o) ** 1.2) * (0.78 + 0.3 * hash(k, 62));
    add(
      focus + (o * 0.8 * size) / cols,
      0.03 + 0.12 * hash(k, 63),
      h,
      0.62 + 0.38 * (1 - Math.abs(o)),
      k + 70,
    );
    if (hollow && k === (n - 1) / 2) {
      // why: taller than the rest and uncapped: an outline does not turn into a skyline.
      const c = stones[stones.length - 1]!;
      c.hollow = true;
      c.step = Math.max(2, Math.round((0.82 * size) / H));
      c.base = Math.round(rows + 0.04 * size);
    }
  }

  // why: back to front, smaller (further) stones first, so the cluster sits in front.
  stones.sort((a, b) => a.depth - b.depth);
  stones.forEach((c, k) => {
    const s = c.step;
    const left = c.cx - Math.floor((W * s) / 2);
    const top = c.base - H * s;
    const mid = left + (W * s) / 2;
    const rim = Math.max(1, Math.round(s * 0.2));
    // why: a dark gap around the silhouette, so a stone in front reads against the ones behind.
    const gap = Math.max(1, Math.round(s * 0.18));
    for (let r = 0; r < H; r++) {
      for (let col = 0; col < W; col++) {
        if (!filled(col, r)) continue;
        for (let y = top + r * s - gap; y < top + (r + 1) * s + gap; y++) {
          if (y < 0 || y >= rows) continue;
          for (let x = left + col * s - gap; x < left + (col + 1) * s + gap; x++) {
            if (x < 0 || x >= cols) continue;
            const i = y * cols + x;
            if (owner[i]! >= 0) {
              owner[i] = -1;
              rock[i] = 0;
            }
          }
        }
      }
    }
    const inside = (x: number, y: number) =>
      x >= left && y >= top && filled(Math.floor((x - left) / s), Math.floor((y - top) / s));
    if (c.hollow) {
      const w = Math.max(1, Math.round(s * 0.08));
      for (let y = Math.max(0, top); y < Math.min(rows, c.base); y++) {
        for (let x = Math.max(0, left); x < Math.min(cols, left + W * s); x++) {
          if (!inside(x, y)) continue;
          const i = y * cols + x;
          const edge =
            !inside(x - w, y) || !inside(x + w, y) || !inside(x, y - w) || !inside(x, y + w);
          owner[i] = edge && (x + y) % 8 < 4 ? -2 : -3;
          rock[i] = 0;
        }
      }
      return;
    }
    for (let y = Math.max(0, top); y < Math.min(rows, c.base); y++) {
      const r = Math.floor((y - top) / s);
      const v = (y - top) / (H * s);
      for (let x = Math.max(0, left); x < Math.min(cols, left + W * s); x++) {
        const col = Math.floor((x - left) / s);
        if (!filled(col, r)) continue;
        const i = y * cols + x;
        const u = (x - mid + 0.5) / (reach[r]! * s);
        let tone = u < 0 ? 0.86 : 0.58;
        if (Math.abs(x - mid + 0.5) < Math.max(0.6, s * 0.12)) tone = 0.5;
        if (!filled(col, r - 1) && y - (top + r * s) < rim) tone = 1;
        tone *= 1 - 0.42 * v;
        if (u > 0.6) tone *= 0.85;
        owner[i] = k;
        shade[i] = tone * c.depth;
        height[i] = v;
      }
    }
  });

  return {
    frame: (t) => {
      const sweep = ((t * 0.09) % 1.9) - 0.3;
      for (let i = 0; i < out.length; i++) {
        const k = owner[i]!;
        if (k === -2) {
          const g = (diag[i]! - sweep * (1 + aspect * 0.55)) / 0.08;
          out[i] = clamp01(0.36 + Math.exp(-g * g) * 0.7);
          continue;
        }
        if (k < 0) {
          out[i] = rock[i]!;
          continue;
        }
        const c = stones[k]!;
        const g = (diag[i]! - sweep * (1 + aspect * 0.55)) / 0.06;
        const glint = Math.exp(-g * g) * 0.4 * c.depth;
        const p = (t * c.speed + c.phase) % 1.6;
        const dv = (height[i]! - (1 - p)) / 0.05;
        const pulse = p < 1 ? Math.exp(-dv * dv) * 0.3 * c.depth : 0;
        out[i] = clamp01(Math.max(rock[i]!, shade[i]! + glint + pulse));
      }
      return out;
    },
  };
}

// why: Simlock's own metaphor, a wall of phones whose screens light while leased and go dark when
// released, in waves toward the focus; a phone flashes full accent as it boots.
function fleetScene(cols: number, rows: number, focus: number, hollow = false): Scene {
  const out = new Float32Array(cols * rows);
  const aspect = cols / rows;
  const size = Math.min(rows, cols * 0.8, 420);
  const th = Math.max(18, Math.round(size / 3.3));
  const tw = Math.round(th * 0.52);
  const gx = Math.max(4, Math.round(tw * 0.45));
  const gy = Math.max(4, Math.round(th * 0.2));
  const step = Math.max(1, Math.round(tw / 14));
  const b = Math.max(1, Math.round(tw * 0.1));
  const fx = focus * cols;
  const fy = rows * 0.5;
  const tile = new Int32Array(cols * rows).fill(-1);
  const litTone = new Float32Array(cols * rows);
  const darkTone = new Float32Array(cols * rows);
  const screen = new Uint8Array(cols * rows);
  const rock = new Float32Array(cols * rows);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const d = Math.hypot(((x - fx) / cols) * aspect, (y - fy) / rows);
      rock[i] =
        0.1 * smooth(0.5, 0.85, fbm((x / cols) * 5 * aspect, (y / rows) * 5, 4)) +
        0.1 * Math.exp(-d * d * 5);
    }
  }
  type Tile = { d: number; seed: number; depth: number; hollow: boolean };
  const tiles: Tile[] = [];
  let nearest = -1;
  let nearestD = Infinity;
  const pitchX = tw + gx;
  const pitchY = th + gy;
  const rowsN = Math.ceil(rows / pitchY) + 1;
  const place: { x0: number; y0: number }[] = [];
  for (let r = -1; r < rowsN; r++) {
    const off = ((r & 1) * pitchX) / 2 + ((fx % pitchX) - tw / 2);
    for (let x0 = Math.round(off - pitchX * 2); x0 < cols + pitchX; x0 += pitchX) {
      const y0 = Math.round(fy - th / 2 + r * pitchY - Math.floor(rowsN / 2) * pitchY);
      const cx = x0 + tw / 2;
      const cy = y0 + th / 2;
      const d = Math.hypot((cx - fx) / (size * 1.25), (cy - fy) / (size * 0.75));
      const k = tiles.length;
      tiles.push({
        d,
        seed: hash(x0 + 1000, y0 + 1000),
        depth: 0.3 + 0.7 * Math.exp(-d * d * 0.7),
        hollow: false,
      });
      place.push({ x0, y0 });
      if (d < nearestD) {
        nearestD = d;
        nearest = k;
      }
    }
  }
  if (hollow && nearest >= 0) tiles[nearest]!.hollow = true;
  const cut = (lx: number, ly: number) => {
    const ex = Math.min(lx, tw - 1 - lx);
    const ey = Math.min(ly, th - 1 - ly);
    return (ex < step && ey < 2 * step) || (ex < 2 * step && ey < step);
  };
  tiles.forEach((tl, k) => {
    const { x0, y0 } = place[k]!;
    for (let ly = 0; ly < th; ly++) {
      const y = y0 + ly;
      if (y < 0 || y >= rows) continue;
      for (let lx = 0; lx < tw; lx++) {
        const x = x0 + lx;
        if (x < 0 || x >= cols || cut(lx, ly)) continue;
        const i = y * cols + x;
        rock[i] = 0;
        if (tl.hollow) {
          const edge =
            cut(lx - 1, ly) ||
            cut(lx + 1, ly) ||
            cut(lx, ly - 1) ||
            cut(lx, ly + 1) ||
            lx === 0 ||
            ly === 0 ||
            lx === tw - 1 ||
            ly === th - 1;
          tile[i] = edge && (x + y) % 6 < 3 ? -2 : -3;
          continue;
        }
        tile[i] = k;
        const inScreen = lx >= b && lx < tw - b && ly >= b * 2 && ly < th - b * 3;
        if (inScreen) {
          screen[i] = 1;
          const sy = ly - b * 2;
          const sx = lx - b;
          const line = Math.floor(sy / (step * 2));
          const filled = line % 2 === 0 && sx < (tw - 2 * b) * (0.35 + 0.55 * hash(k, line));
          litTone[i] = (filled ? 0.92 : 0.5) * tl.depth;
          darkTone[i] = 0.08 * tl.depth;
        } else {
          let tone = lx < tw / 2 ? 0.62 : 0.46;
          if (ly < Math.max(1, Math.round(step * 0.7)) || cut(lx, ly - 1)) tone = 0.95;
          if (ly >= th - b * 2 && Math.abs(lx - tw / 2) < tw * 0.12 && ly < th - b) tone = 0.25;
          litTone[i] = darkTone[i] = tone * tl.depth;
        }
      }
    }
  });
  const lit = new Uint8Array(tiles.length);
  const flash = new Uint8Array(tiles.length);
  return {
    frame: (t) => {
      for (let k = 0; k < tiles.length; k++) {
        const tl = tiles[k]!;
        const w = (((t * 0.11 + tl.d * 0.45 + tl.seed * 0.3) % 1) + 1) % 1;
        lit[k] = w < 0.62 ? 1 : 0;
        flash[k] = w < 0.035 ? 1 : 0;
      }
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.4);
      for (let i = 0; i < out.length; i++) {
        const k = tile[i]!;
        if (k === -2) {
          out[i] = 0.3 + 0.45 * pulse;
          continue;
        }
        if (k < 0) {
          out[i] = rock[i]!;
          continue;
        }
        if (screen[i] && flash[k]) out[i] = tiles[k]!.depth;
        else out[i] = lit[k] ? litTone[i]! : darkTone[i]!;
      }
      return out;
    },
  };
}

const scenes = {
  fleet: (cols, rows, focus) => fleetScene(cols, rows, focus),

  mark: (cols, rows, focus, mark) => markScene(cols, rows, focus, mark),

  hollow: (cols, rows, focus) => fleetScene(cols, rows, focus, true),

  flow: (cols, rows) => {
    const out = new Float32Array(cols * rows);
    const aspect = cols / rows;
    const warp = mistTexture(cols, rows, 2 * aspect, 2);
    return {
      frame: (t) => {
        const shift = Math.floor(t * 4) % cols;
        for (let y = 0; y < rows; y++) {
          const v = y / rows;
          const row = y * cols;
          for (let x = 0; x < cols; x++) {
            const u = x / cols;
            const w = warp[row + ((x + shift) % cols)]! * 3.2;
            const band =
              0.5 + 0.5 * Math.sin((u * 1.6 * aspect * 0.35 + v * 1.3) * Math.PI + w + t * 0.15);
            const edges = smooth(0, 0.3, u) * smooth(1, 0.7, u) * 0.4 + 0.6;
            // why: capped just above the midtone, so the bands stay the dark accent mix with only a
            // few accent pixels at their crests: quiet enough to sit behind code.
            out[row + x] = smooth(0.35, 1, band) * edges * (1 - Math.abs(u - 0.5) * 0.6) * 0.55;
          }
        }
        return out;
      },
    };
  },
} satisfies Record<string, SceneBuilder>;

export type SceneName = keyof typeof scenes;

type Surface = HTMLCanvasElement | OffscreenCanvas;
type Painted = { key: string; scene: Scene; image: ImageData; px: Uint32Array; palette: number[] };
const cache = new WeakMap<Surface, Painted>();

function palette(rgb: number[]) {
  const [r, g, b] = rgb as [number, number, number];
  const pack = (cr: number, cg: number, cb: number) =>
    (255 << 24) | (Math.round(cb) << 16) | (Math.round(cg) << 8) | Math.round(cr);
  const mix = (c: number) => 10 + (c - 10) * 0.3;
  return [pack(10, 10, 10), pack(mix(r), mix(g), mix(b)), pack(r, g, b)];
}

// why: the canvas is one pixel per cell and CSS scales it up with `image-rendering: pixelated`,
// so every cell stays a sharp square.
export function drawDither(
  canvas: Surface,
  name: string,
  t: number,
  rgb: number[],
  cols: number,
  rows: number,
  focus: number,
  mark: readonly string[] = [],
) {
  // why: only the scene table's own keys: a name like `constructor` must not reach Object.prototype.
  const build: SceneBuilder | undefined = Object.hasOwn(scenes, name)
    ? scenes[name as SceneName]
    : undefined;
  const ctx = canvas.getContext("2d") as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!build || !ctx || cols < 2 || rows < 2) return;
  const key = `${name}:${cols}x${rows}:${focus}`;
  let entry = cache.get(canvas);
  if (!entry || entry.key !== key) {
    canvas.width = cols;
    canvas.height = rows;
    const image = ctx.createImageData(cols, rows);
    entry = {
      key,
      scene: build(cols, rows, focus, mark),
      image,
      px: new Uint32Array(image.data.buffer),
      palette: palette(rgb),
    };
    cache.set(canvas, entry);
  }
  const tones = entry.scene.frame(t);
  const { px, palette: colours } = entry;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const scaled = tones[i]! * 2;
      const low = Math.min(1, Math.floor(scaled));
      const step = scaled - low > BAYER[(y & 3) * 4 + (x & 3)]! ? 1 : 0;
      px[i] = colours[low + step]!;
    }
  }
  ctx.putImageData(entry.image, 0, 0);
}

const FRAME_MS = 1000 / 12; // why: a low frame rate keeps the pixels reading as pixels

export type DitherOptions = {
  scene: string;
  focus: number;
  cell: number;
  rgb: number[];
  still: boolean;
  mark: string[];
};

export function animate(canvas: Surface, o: DitherOptions) {
  const start = performance.now() - Math.random() * 20000;
  let width = 0;
  let height = 0;
  let visible = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const draw = () => {
    const cols = Math.ceil(width / o.cell);
    const rows = Math.ceil(height / o.cell);
    // why: the still frame is taken nine seconds in, when the glint is on the cluster.
    const t = o.still ? 9 : (performance.now() - start) / 1000;
    drawDither(canvas, o.scene, t, o.rgb, cols, rows, o.focus, o.mark);
  };
  const loop = () => {
    timer = undefined;
    if (!visible || !width) return;
    draw();
    if (!o.still) timer = setTimeout(loop, FRAME_MS);
  };

  return {
    setSize(w: number, h: number) {
      width = w;
      height = h;
      if (visible && !timer) loop();
    },
    setVisible(on: boolean) {
      visible = on;
      if (on && !timer) loop();
      if (!on && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
