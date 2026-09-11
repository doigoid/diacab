# DiaCab

A server-cabinet diagram builder that runs entirely in the browser. No build step, no
dependencies, no server — three static files.

```
open index.html
```

(or serve the folder: `python3 -m http.server 8000`)

## Shapes

| Shape    | Heights  | Default draw (idle → peak) |
|----------|----------|----------------------------|
| Server   | 1U – 20U | 120 W → 350 W at 1U, +60 W / +150 W per extra U |
| Switch   | 1U – 2U  | 60 W → 150 W per U |
| Firewall | 1U – 2U  | 45 W → 120 W per U |

Every device carries its own editable idle–peak range; the defaults are just starting
points. Change a device's type or height and the range follows the new default — unless
you've customised it, in which case your numbers are kept.

## Cabinets and the canvas

Cabinets are placed freely on a snap-to-grid canvas (24px steps), each with its own name,
height (4–60U) and power budget.

- **+ Cabinet** (toolbar) or the **Add cabinet** tile beside the last cabinet adds one in
  the first free column; it inherits the active cabinet's height and budget.
- **Drag a cabinet by its header** to position it. It snaps to the grid, clamps at the
  canvas origin, and refuses a drop that would cover another cabinet (the outline turns
  red while the position is invalid) — the same rule devices follow inside a rack.
- **Drag the empty canvas** to pan; the grid dots mark the step. Scroll and trackpad
  gestures work too.
- **Arrange in a row** (Diagram section) reflows every cabinet into one evenly spaced row,
  in its current left-to-right order.
- Click a cabinet to make it **active** (accent bar on its header). The *Active cabinet*
  panel and palette clicks apply to it.
- **Duplicate** copies a cabinet with all its devices into the first free column;
  **Delete** removes it (the last cabinet can't be deleted).
- **Double-click a cabinet's name** to rename it in place.

Lists and sequences that show cabinets — the occupancy panel, the Cabinet dropdown,
`Tab` cycling, `←`/`→`, and the exports — follow canvas reading order (left to right, then
top to bottom), not the order cabinets were created.

## Using it

- **Drag** a shape from the left palette into any cabinet. It snaps to the nearest rack
  unit; the outline turns red when the slot is taken, and the drop is rejected.
- **Click** a palette shape to drop it into the active cabinet's lowest free slot.
- **Drag** a placed device anywhere, including **into another cabinet**. Collisions are
  blocked, not stacked.
- **Double-click** a device to rename it in place (`Enter` commits, `Esc` cancels).
- **Duplicate** (`⌘D`) names the copy the way you'd expect: a label ending in a number
  increments it and keeps the zero-padding (`spine-01` → `spine-02`), anything else gains
  ` copy` (`core-sw` → `core-sw copy`), and a label already ending in "copy" gets a number
  instead (`core-sw copy` → `core-sw copy 1`). Labels already in use are skipped, so
  duplicating `web-01` next to an existing `web-02` gives `web-03`.
- The **Properties** panel edits label, sub-label (model / IP / owner), power range,
  cabinet, type, height, exact U position, and colour.
- The **Diagram** section flips U numbering between bottom-up (default) and top-down, and
  sets the zoom (defaults to fitting the tallest cabinet in the window).

## Preview mode

**Preview** in the toolbar (or `P`) hides every control — toolbar, palette, inspector,
and the add-cabinet tile — leaving just the cabinets, re-fitted to the full window. Good
for screenshots, presenting, or a wall display.

Preview is read-only: selection, dragging, rename-in-place, palette clicks and every
keyboard edit (including undo) are inert, and a drag interrupted by switching to preview
is abandoned rather than applied. Leave it with `Esc`, `P`, or the faint **Exit preview**
button in the corner. It's a view mode, so it isn't saved with the diagram and doesn't
touch undo history.

### Keyboard

| Key | Action |
|-----|--------|
| `↑` / `↓` | move the selection one U |
| `←` / `→` | move the selection to the previous / next cabinet |
| `Tab` / `⇧Tab` | cycle the selection bottom → top, cabinet by cabinet |
| `Enter` | rename the selection |
| `⌫` / `Del` | delete the selection |
| `⌘D` / `Ctrl+D` | duplicate into the lowest free slot |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| `P` | toggle preview mode |
| `Esc` | deselect (or leave preview mode) |

## Power

Each cabinet has a **Max power (W)** budget — set it to `0` for no limit. The cabinet
header shows the budget, the footer shows the current idle–peak draw against it, and the
*Occupancy* panel totals both per cabinet and across the diagram.

Power is treated as a budget, not a hard constraint: a device that pushes a cabinet over
its limit is still placed, but the cabinet's footer and stats row turn red and a toast
names the overage. Space in U remains a hard constraint — overlapping drops are always
rejected.

## Saving and export

The diagram autosaves to `localStorage` on every change, so a reload picks up where you
left off.

- **Save JSON** / **Load JSON** — portable diagram file (`{ format: "diacab/3",
  numberFromTop, racks }`). Imports are validated: unknown types fall back to Server,
  heights and watts are clamped to their limits, missing power ranges are filled from the
  defaults, and devices that overlap or hang off the top of a cabinet are dropped.
  Older files still load — single-cabinet `diacab/1` as one cabinet, and `diacab/2` files
  (which predate canvas positions) laid out in a tidy row.
- **Export SVG** — vector diagram mirroring the canvas layout, including cabinets
  staggered on the grid, drawn independently of the DOM.
- **Export PNG** — the same drawing rasterised at 2×.

## Files

| File | Contents |
|------|----------|
| `index.html` | layout: palette, stage, inspector |
| `styles.css` | dark theme; `--uh` is the pixel height of one rack unit, `--grid` the canvas step |
| `app.js` | state, drag-and-drop, undo/redo, persistence, SVG/PNG export |

State lives in `state`:

```js
{ numberFromTop,
  racks: [{ id, name, u, maxW, x, y,
            devices: [{ id, type, u, pos, label, sub, color, idle, peak }] }],
  activeRackId, selectedId }
```

`x`/`y` are the cabinet's canvas position in grid units (`GRID` = 24px, mirrored by the
`--grid` CSS variable).

Every mutation goes through `commit()`, which records undo history, persists, re-renders,
and reports any cabinet that has just gone over its power budget. A device's `pos` is the
1-based rack unit of its **bottom** edge, independent of which way the rails are numbered;
device ids are unique across all cabinets.
