# Geohub design system

One visual language across web mapping, data collection, the data hub and the mobile collector.
Styles live in `frontend/src/styles/` and load in this order from `app.css`:

| File | What it holds |
|---|---|
| `tokens.css` | Every colour, size, radius, shadow and timing. Change the look here first. |
| `base.css` | Reset, typography, focus ring, utilities, reduced motion, high-contrast mode |
| `components.css` | Buttons, fields, switches, cards, badges, states, dialogs, tabs, tables, menus |
| `layout.css` | Top bar, page structure, map, editor, attribute table, form builder, collector |
| `pages.css` | Home, sign in, data hub, dataset page |

## Principles
1. **Calm and precise.** A deep forest chrome, white work surfaces, one brand green for actions. Warm accent only for emphasis.
2. **Normal-size type.** 14px for body and controls, 13px for secondary text, 12px for captions and table headers. Titles step up to 18, 22 and 28px. Numbers use tabular figures.
3. **Predictable shapes.** Controls 8px radius, cards 12px, dialogs 16px, pills fully round. One control height (40px, 44px on touch).
4. **Everything has states.** Hover, focus, active, disabled, loading, empty and error are all designed, not left to the browser.
5. **Accessible by default.** Visible focus on every control, no colour-only meaning, 44px touch targets on touch devices, reduced motion respected.

## Brand colour
| Token | Value | Use |
|---|---|---|
| `--ink-900` | `#10241f` | Text, top bar |
| `--green-600` | `#17634c` | Primary actions, links, selected states (7.1:1 on white) |
| `--green-700` | `#125040` | Hover and pressed |
| `--green-50` / `--green-100` | `#eef6f1` / `#dcebe3` | Tints for selected rows, badges, notes |
| `--n-50` … `--n-800` | green-tinted greys | Page background, borders, secondary text |
| `--accent-500` | `#b8431a` | Rare emphasis (unsaved marker) |
| status | success `#17634c`, warning `#8a5a00`, danger `#b42318`, info `#1a5fd0` | Each with a tinted background that keeps 4.5:1 text |

On wide-gamut (P3) displays the brand greens render in Display P3. The sRGB values are the fallback.

## Type
IBM Plex Sans for the interface, IBM Plex Mono for coordinates, codes and format chips. Both are bundled with the app (`@fontsource`), so nothing is fetched from a font server and the Android app looks identical offline.

## Spacing, shape, depth
- Spacing on a 4px grid: `--s-1` (4px) to `--s-16` (64px).
- Radii: `--r-sm` 6, `--r-md` 8, `--r-lg` 12, `--r-xl` 16.
- Shadows: `--sh-xs` to `--sh-lg`, tinted with the brand ink.

## Adding to the app
- Use the existing classes first (`btn`, `field`, `card`, `badge`, `state`, `tabs`, `data-table`, `menu`).
- New colours go in `tokens.css`, never inline. New components go in `components.css`.
- Give every icon-only button an accessible name. If it shows a caption, the caption must be part of that name.
- Put a map inside a fixed-height box with `.preview` or `.review-map` style rules (the map must have a real height or MapLibre falls back to 300px).
- Check a new page with the accessibility scan described in `docs/DESIGN_QA.md`.

Reference screenshots are in `docs/design/`.

## Form builder: arranging fields by dragging
Fields are arranged by dragging, not with move buttons.
- **Mouse:** drag a field by its grip, or by the card itself. Drag a field type from the left list onto the form to add it at that spot (clicking it still adds it at the end).
- **Touch:** drag by the grip. Touching the card body still scrolls the page.
- **Keyboard:** Tab to a grip, press Space to pick the field up, use the up and down arrow keys to move it, Space to drop it, Escape to cancel. Each step is announced to screen readers.
- A line shows where the field will land. Dropping into a group or repeat section nests it; the same rules as before apply (a repeat cannot sit inside another repeat, and nothing can go inside itself).
- Near the top or bottom of the list, dragging scrolls it.

The placement rules are plain functions in `src/lib/fieldSpec.ts` (`moveTo`, `canPlace`, `insertAt`) and `src/lib/dnd.ts`, tested by `npm run test:dnd`. The interaction is `src/components/useFieldDnd.tsx`.
