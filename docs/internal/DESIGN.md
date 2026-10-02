# Design guide

How Simlock looks. The web console follows it today, and the landing page will
follow it when it is built. The tokens live in `ui/src/styles.css`; change this
guide and that file together.

The style is Callstack's incubator style: plain, dense, square, quiet. Orange is
Simlock's accent.

## Type

- **Geist** for everything people read. **Geist Mono** for what people copy or
  compare: ids, tokens, commands, versions, timestamps, numbers in tables.
- Both are bundled with the console (`@fontsource-variable/geist`,
  `@fontsource-variable/geist-mono`, OFL-1.1). Nothing is loaded from a font
  service.
- One scale, in `rem`, from a 16px base:

  | Token | Size | Use |
  | --- | --- | --- |
  | `--text-xs` | 12px | badges, table footnotes |
  | `--text-sm` | 14px | navigation, labels, hints, table cells |
  | `--text-md` | 16px | body text |
  | `--text-lg` | 20px | the wordmark |
  | `--text-xl` | 24px | a page's heading (`h1`) |
  | `--text-2xl` | 32px | the landing page's headings only |

- Weights: 400 for text, 500 for labels and controls, 600 for headings.
- Headings get a small negative tracking (`-0.01em`). Body text has none.
- Line height 1.5 for text, 1.25 for headings.

## Colour

Every colour is a CSS custom property on `:root`. The light values apply by
default; the dark values replace them under `prefers-color-scheme: dark`. The
console has no theme switch of its own: it follows the system.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#0e0e0f` | the page |
| `--surface` | `#f5f5f4` | `#18181b` | panels, hovered rows |
| `--border` | `#d9d9d6` | `#2e2e33` | dividers, panel edges |
| `--text` | `#0e0e0f` | `#f2f2f0` | text |
| `--text-muted` | `#55555a` | `#a1a1a8` | secondary text, inactive nav |
| `--accent` | `#c2410c` | `#ff7a1a` | brand and interaction |
| `--accent-hover` | `#9a3412` | `#ff9442` | a hovered accent control |
| `--on-accent` | `#ffffff` | `#0e0e0f` | text on an accent fill |
| `--selection` | `#fed7aa` | `#7c2d12` | selected text |

The accent is a darker orange in the light theme so that it passes WCAG AA as
text and as a focus ring on white.

### Orange is for brand and interaction only

Use the accent for the wordmark's square, buttons, links, the focus ring, the
current page in the navigation, and selection. Never use it to say something
about state: not for "busy", not for "warning", not for "new". A reader who
sees orange should think "I can act here", nothing else.

### Status colours

| Token | Light | Dark | Means |
| --- | --- | --- | --- |
| `--status-ok` | `#15803d` | `#4ade80` | healthy, connected, ready |
| `--status-warn` | `#a16207` | `#facc15` | needs a look soon: drained, stalled, over a limit |
| `--status-error` | `#b91c1c` | `#f87171` | broken: disconnected, incompatible, quarantined, a refused sign-in |
| `--status-idle` | `#57534e` | `#a8a29e` | neither: shut down, waiting, unknown |

**A status always shows a word.** The colour is a second signal, never the only
one: `● connected`, not a green dot. Use the daemon's own word for the state
(`leased`, `quarantined`, `drained`), so the console and the CLI agree.

Every pair of text and background colour in both themes meets WCAG AA: 4.5:1
for text, and 3:1 for the focus ring and an input's border. The browser lane
checks text contrast with axe in both themes; a new token must pass it too.

## Shape

- **Square corners** everywhere: `--radius` is `0`. No rounded buttons, panels
  or inputs.
- Borders are 1px `--border`. Panels are `--surface` with a border, no shadow.
- No gradients, no illustrations. The one decoration is the wordmark's orange
  square.

## Spacing

A 4px grid: `--space-1` 4px, `--space-2` 8px, `--space-3` 12px, `--space-4`
16px, `--space-6` 24px, `--space-8` 32px, `--space-12` 48px. Pick from the
scale; never a value between.

- Controls are at least 40px tall, so they are easy to hit on a phone.
- A page has 16px side padding on a phone and 32px from 768px up.

## Layout

- Phone first. Every page works at 360px wide with no sideways scrolling of the
  page. A wide table scrolls inside its own box, never the page.
- Under 768px: the header, then the navigation as a wrapping row, then the
  page. From 768px: the header across the top, the navigation as a 200px
  column on the left, the page beside it.
- The navigation lists every view in a fixed order. The current one has an
  accent bar and `aria-current="page"`.

## Focus and keyboard

- Everything clickable is a real `<a>` or `<button>`, so it is reachable with
  Tab and works with Enter.
- The focus ring is a 2px `--accent` outline, 2px off the element. It shows for
  keyboard focus (`:focus-visible`), not on a mouse click.
- The first control on every signed-in page is "Skip to content", visible only
  when focused.

## Motion

Almost none. Colour changes on hover take 120ms (`--duration`). Nothing slides,
fades or bounces. With `prefers-reduced-motion: reduce`, there are no
transitions at all.

## Voice

- Short, plain sentences. Say what happened and what to do next.
- Name things the way the CLI does: worker, lease, device, token, gateway.
- Errors say what is wrong, not that something "went wrong": "The daemon
  cannot be reached." Never blame the reader.
- No exclamation marks, no emoji, no "please", no "oops".
- Buttons are verbs: "Sign in", "Sign out".
- An empty or unfinished page says so in one line: "Coming soon.", "No leases."
