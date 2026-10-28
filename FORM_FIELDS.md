# Form fields

A form is a **tree of fields**. Each field has three layers:

| Layer | Question it answers | Where |
|---|---|---|
| `type` | What is it? Decides what is stored and how it is validated. | 19 types |
| `appearance` | How is it drawn? | per type, first entry is the default |
| rules | When does it apply, and what must be true? | flat properties: `visible`, `required`, `required_if`, `readonly`, `default`, `min`, `max`, `min_length`, `max_length`, `min_items`, `max_items`, `pattern` |

The single source of truth is `frontend/src/lib/fieldSpec.ts` (`TYPE_SPECS`), mirrored in `backend/app/services/forms.py`.
`backend/tests/test_form_fields.py` fails if the two tables disagree.

## The 26 requested elements

| Requested element | Becomes |
|---|---|
| Text, Date, Time, Date and Time, Barcode / QR | `text`, `date`, `time`, `datetime`, `barcode` |
| Multiline Text | `text` + appearance `multiline` |
| Integer, Decimal | `number` + `integer: true` / `decimals` |
| Single Choice, Dropdown | `choice` + appearance `buttons`, `radio` or `dropdown` |
| Multiple Choice | `multi_choice` |
| Switch / Toggle | `boolean` + appearance `switch` |
| Acknowledgement | `boolean` + `must_be_true` + `required` |
| Ranking | `ranking` |
| Image, Audio, Video, File, Signature | `photo`, `audio`, `video`, `file`, `signature` |
| Note / Instructions | `note` |
| Calculation | `calculation` |
| Group / Section, Repeat Section | `group`, `repeat` |
| GPS Point, Line, Area | **not fields**: the form's `geometry_type`, drawn on the map |

Settings that are rules, not elements: Required, Default, Hint, Placeholder, Validation, Conditional Visibility (= Relevant = Skip logic),
Read-only, Min/Max, Min/Max Length, Automatic Calculations (= the `calculation` element).

## How values are stored (`feature.properties`)

| Type | Stored as |
|---|---|
| text, barcode, choice | string |
| number | number |
| date | `YYYY-MM-DD` |
| time | `HH:MM` |
| datetime | ISO 8601 |
| boolean | true / false |
| multi_choice, ranking | list of choice strings |
| photo, audio, video, file, signature | list of media ids |
| calculation | number or text (not saved when `store: false`) |
| note, group | nothing. A group's children are stored **flat**, next to its siblings |
| repeat | list of row objects under the repeat's id |

## Rules

Conditions are data, never code:

```json
{ "field": "has_power", "op": "eq", "value": true }
{ "all": [ { "field": "type", "op": "in", "value": ["Clinic", "Hospital"] }, { "not": { "field": "notes", "op": "filled" } } ] }
```
Operators: `eq ne gt gte lt lte in not_in contains filled empty`.

Calculations are a closed set: `sum product min max avg diff ratio concat count_selected today now`, with operands `{field}` or `{const}`.

**Generated values** are calculations with no operands that make a new value instead of working one out: `uuid` (a UUID) and `short_id` (8 characters from an alphabet without 0 O 1 I L, with an optional `prefix` such as `WP-`).
They are made once, when a record (or a repeat row) is started, and then kept: typing in other fields, editing the record later and saving never change them.
If a record arrives without one, the server makes it. In the builder they are the "Auto ID" and "Unique ID (UUID)" entries under Computed.
In a form CSV: `auto_id`, `uuid` or `calculate` with `once(uuid())`.

Behaviour that matters:

- A hidden field is not validated, not required, and its answer is dropped on save (`pruneProperties`). Children of a hidden group are hidden.
- The server ignores a hidden answer instead of rejecting it, so an older client keeps working.
- `required_if` makes a field required only when its condition holds.
- A rule can read answers on its own level and the form's top-level answers. A field inside a repeat can read its sibling fields in the same row.
- Rules inside a repeat use error keys like `rooms.0.ward_beds`.
- Calculations are computed by the client and checked for type by the server; the server does not recompute them.

## Limits

500 fields per form, 3 levels of nesting, no repeat inside a repeat, patterns up to 200 characters (nested quantifiers such as `(a+)+` are refused).

## Publishing a dataset

Datasets are flat tables. Groups are looked through; media, repeat sections, notes and unsaved calculations are **not** published.
Multiple choice and ranking are joined with `; ` in CSV and Shapefile. Repeat sections would need a related table, which is not built.

## Media

Photos are resized in the worker as before. Audio, video, files and signatures (PNG) are stored as uploaded, up to `MAX_MEDIA_BYTES` (100 MB). Photos stay at `MAX_PHOTO_BYTES`.

## Upgrading existing forms

Nothing to migrate. Published versions that use only `id`, `label`, `type`, `required`, `choices` and `max_items` stay valid.
