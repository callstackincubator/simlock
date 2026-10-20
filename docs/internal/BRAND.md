# Simlock brand

How Simlock looks outside the console: the website, the social card and the
README banner, slides, diagrams and videos. Near-black, one bright orange,
white type, light grotesk headlines, uppercase mono labels, square corners,
1px hairlines, no shadows or gradients, and dithered pixel art. It is the
Callstack product family's look: Apex is lime `#c6f432`, Appduct cyan
`#3ddcff`, agent-device violet `#a47bff`, Rozenite crimson-rose `#ff4f7b`, and
Simlock orange `#ff7a1a`, the web console's own accent.

**Scope.** This file governs every brand visual and the site in `website/`.
The web console has its own guide, [DESIGN.md](DESIGN.md). The two share the
orange and nothing else.

## Colour

| Token | Value | Use |
| --- | --- | --- |
| `bg` | `#0a0a0a` | the page, slide or frame background |
| `surface` | `#111111` | hovered cells, panels |
| `field` | `#161616` | inline code, chips, inputs |
| `line` | `rgb(255 255 255 / 0.08)` | hairlines: the frame, section rows, cell borders |
| `line-strong` | `rgb(255 255 255 / 0.16)` | window borders, outlined buttons |
| `text` | `#ffffff` | headlines, primary text |
| `muted` | `rgb(255 255 255 / 0.62)` | body copy, nav links |
| `faint` | `rgb(255 255 255 / 0.5)` | metadata, line numbers; the dimmest text allowed |
| `accent` | `#ff7a1a` | the wordmark, primary actions, second beats, strings in code, live state |
| `accent-hover` | `#ffb27a` | hover on accent fills |
| `accent-rgb` | `255 122 26` | the accent for `rgb()` and the dither palette |
| `on-accent` | `#0a0a0a` | text on an accent fill, always dark |
| `accent-deep` | `#b93d0b` | light-mode docs: links and accent text (5.6:1 on white) |
| `accent-rule` | `#cb5f10` | light-mode docs: rules and the current sidebar item |

- The accent is 7.6:1 on `bg`.
- Use the one accent sparingly. Never use it for status: an error in a
  pictured UI is white text with an `ERR` label, and a device state is grey,
  hatched or dashed, never green or red.
- Greys are neutral. Every piece of text meets 4.5:1 against its background.
- The values live in `website/src/site/brand.ts`, and nothing else in the
  site may hold an accent hex.

## Type

| Role | Font | Size | Weight | Tracking | Leading |
| --- | --- | --- | --- | --- | --- |
| Hero headline | Switzer | `clamp(2rem, 1.3rem + 2.6vw, 3.5rem)` | 500 | -0.035em | 1.08 |
| Section headline | Switzer | `clamp(1.75rem, 1.3rem + 1.6vw, 2.75rem)` | 500 | -0.03em | 1.1 |
| Card title | Switzer | 1.125rem | 500 | -0.01em | 1.3 |
| Lede, body | Switzer | 1–1.125rem, 0.9375rem | 400 | 0 | 1.55, `muted` |
| Label | Geist Mono | 0.75rem | 400 | 0.08em, uppercase | — |
| Code | Geist Mono | 0.8125rem | 400 | 0 | 1.75 |

- Switzer (ITF Free Font License) and Geist Mono (OFL) are self-hosted from
  `website/src/fonts/`.
- Headlines have two beats, the second in the accent, with no italics. The
  motto: "Your own simulator cloud. *One device per agent.*"
- Mono is for labels, commands, ids and metadata, never for sentences.
- Platforms always run iOS, then Android. Hosts run macOS, then Linux.

## Layout

- One centred frame, `min(100% - 2 × gutter, 75rem)`, its side hairlines
  running the full height. Gutter `clamp(1rem, 3vw, 2rem)`, inner padding
  `clamp(1.25rem, 3vw, 2.5rem)`.
- Sections open on a hairline row such as `[02]  FLEET`, with the number in
  `faint`.
- Equal cells divided by hairlines, with no gaps and no fills; counts that
  never leave a row half empty.
- Spacing steps in 4px. The radius is 0 everywhere, with no shadows.
- On a phone, one column with a 16px gutter and no sideways scroll.
- A 16:9 slide or video frame uses the same frame hairlines and section row,
  with type scaled from the hero headline.

## Components

- **Lockup:** the wordmark `SIMLOCK` in Switzer 500, `on-accent` on an
  `accent` block, then a `BY CALLSTACK` mono chip (dropped on phones). Simlock
  has no pixel mark.
- **Buttons:** mono uppercase, 2.5rem tall, square. Primary is an accent fill
  with dark text; dark is `#1a1a1a` with white text.
- **Window:** a `bg` fill with a `line-strong` border. Its bar holds a small
  accent wordmark tag, a mono title in `faint` (`zsh`, `gateway ·
  gw.example`, `laptop · agent-1`) and three thin window controls.
- **Code:** keywords and punctuation in dimmed white, functions and types in
  white, strings and numbers in the accent, comments in `faint`. In shell, the
  command and its arguments are white, options are dimmed, and only quoted
  strings take the accent.
- **Command bar:** `$` in the accent, the command in mono, a `COPY` button.
- **Pictures of the product:** devices, the gateway table and the console are
  drawn as diagrams in this language, never screenshots. Phones are dark with
  pixel-stepped corners. Leased device slots are accent; ready is grey,
  booting is hatched, free is dashed.
- **Closing:** an accent CTA bar, the giant accent wordmark, then one footer
  row: `© YEAR SIMLOCK BY CALLSTACK` and mono links.

## Pixel imagery

All imagery is ordered dithering on 2px cells, in three tones: `bg`, a 30%
mix of the accent into `bg` (`#542c0f`), and the accent, with a 4×4 Bayer
threshold between neighbours. Text never sits on dither: windows and cards
on top of it have solid `bg` fills. Never use photos, gradients, landscapes or
3D.

- **Fleet (the signature scene).** Staggered rows of phones, each a tall
  rectangle about half as wide as it is high, with stepped corners, a lit rim
  along the top, a screen, a chin and a home bar. They are brightest around the
  focus (where the product picture sits) and fade into dim noise at the edges.
  A leased phone's screen shows app-like rows at full accent. A free phone's
  screen is dark. Slow waves move in toward the focus, leasing and releasing
  phones, and a phone flashes full accent for a moment as it boots. Phone size
  follows the scene's shorter side. It sits behind the hero, the social card
  and the banner.
- **Flow.** Soft diagonal bands, capped near the midtone. The quiet backdrop
  behind code, tabs and the drawn console.
- **Hollow.** The fleet with the phone at the focus missing: a dark socket
  with a dashed stepped outline that pulses. Only on the 404 page.

The scenes are generated in `website/src/components/site/dither.ts`.

## Motion

- Pixel motion moves in steps, with dither at about 12 fps. UI changes take
  120ms for hovers and about 300ms for screens.
- Typed text is laid out at full length first, so nothing reflows.
- Animations load when they near the viewport and run only while visible. The
  server HTML and `prefers-reduced-motion` get the finished frame.
- In video: the same stepped easing, and cuts rather than cross-fades.

## Words

- Short and plain, one colleague to another. Name the reader: "your agents",
  "you". No marketing adjectives, and no "just", "simply" or "easy".
- Lead with the self-hosted simulator cloud. One machine is where it starts.
- Page titles: `Simlock: Self-hosted simulator cloud for coding agents` on
  the home page, `Page title | Simlock` everywhere else, 60 characters at most.
  Built only by `website/src/site/meta.ts`.
- Every command, field and number comes from the user docs. Agents on other
  machines lease over the HTTP API; only the local daemon speaks to the CLI.

## Social card and banner

- `website/public/og-image.jpg` (1200×630): the lockup, the motto, and a band
  of the fleet scene with the gateway table in miniature (agent, device,
  worker, `granted`).
- `website/public/banner.jpg` (1660×512): the same pieces side by side, for the
  README.
- Both are rendered from `website/og/og.html` by `pnpm og` in `website/`,
  reading `content.ts`, `brand.ts` and the hero's `story.ts`. Re-run it after
  changing any of them.

## Website

`website/` is an Astro and Starlight site served from GitHub Pages at
`https://callstackincubator.github.io/simlock/`, under the base path
`/simlock` (`BASE` and `at()` in `website/src/site/content.ts`).

- **Home** (`src/pages/index.astro`): nav, hero, marquee, then [01] How it
  works, [02] Fleet, [03] Console, [04] What you get, [05] Safe by default,
  [06] FAQ, closing. The hero (`src/components/home/Hero.astro`, `hero.ts`,
  `story.ts`) shows three agents sending one lease request to one gateway URL,
  the gateway's table of where each went and why, and the three workers'
  phones lighting up. The console section draws the console's Overview
  (`ConsoleView.astro`).
- **404** (`src/pages/404.astro`): the hollow scene behind a card, "This
  device was never leased. *The rest of Simlock is.*"
- **Docs:** Starlight, dark by default. The reference pages are copied from
  `docs/*.md` at build time by `website/scripts/sync-docs.mjs`, so the repo's
  user docs stay the one source. `getting-started.mdx` is written for the
  site.
- All copy lives in `website/src/site/content.ts`.
