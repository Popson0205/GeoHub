import type { Condition, FormField } from "../lib/types";
import { Button } from "./ui";

type Leaf = Extract<Condition, { field: string }>;
type Op = Leaf["op"];

const OP_LABEL: Record<Op, string> = {
  eq: "is", ne: "is not", gt: "is more than", gte: "is at least", lt: "is less than", lte: "is at most",
  in: "is one of", not_in: "is none of", contains: "includes", filled: "has an answer", empty: "has no answer",
};
const LIST_OPS: Op[] = ["in", "not_in", "contains"];
const NO_VALUE: Op[] = ["filled", "empty"];

/** Which comparisons make sense for the field being asked about. */
function opsFor(f: FormField | undefined): Op[] {
  switch (f?.type) {
    case "choice": return ["eq", "ne", "in", "not_in", "filled", "empty"];
    case "multi_choice": case "ranking": return ["contains", "in", "not_in", "filled", "empty"];
    case "boolean": return ["eq", "filled", "empty"];
    case "number": case "calculation": case "date": case "time": case "datetime": return ["eq", "ne", "gt", "gte", "lt", "lte", "filled", "empty"];
    case "text": case "barcode": return ["eq", "ne", "contains", "filled", "empty"];
    default: return ["filled", "empty"];
  }
}
const inputType = (f: FormField | undefined): string => (f?.type === "number" || f?.type === "calculation" ? "number" : f?.type === "date" ? "date" : f?.type === "time" ? "time" : f?.type === "datetime" ? "datetime-local" : "text");

/** A condition this editor can show: one rule, or a list of rules joined by "all" or "any". Anything else is left alone. */
function parse(c: Condition | undefined): { mode: "all" | "any"; rules: Leaf[] } | "complex" | null {
  if (!c) return null;
  if ("field" in c) return { mode: "all", rules: [c] };
  const list = "all" in c ? c.all : "any" in c ? c.any : null;
  if (list && list.every((x): x is Leaf => "field" in x)) return { mode: "all" in c ? "all" : "any", rules: list };
  return "complex";
}
function build(mode: "all" | "any", rules: Leaf[]): Condition | undefined {
  if (rules.length === 0) return undefined;
  if (rules.length === 1) return rules[0];
  return mode === "all" ? { all: rules } : { any: rules };
}

interface Props {
  /** Visible name of the rule, e.g. "Show this field only when". */
  title: string;
  value: Condition | undefined;
  onChange: (c: Condition | undefined) => void;
  /** Fields the rule may look at (not the field itself). */
  candidates: FormField[];
  idBase: string;
}

export default function ConditionEditor({ title, value, onChange, candidates, idBase }: Props) {
  const parsed = parse(value);
  const byId = (id: string) => candidates.find((c) => c.id === id);
  const fresh = (): Leaf => ({ field: candidates[0].id, op: "filled" });

  if (parsed === "complex") {
    return (
      <div className="field">
        <span>{title}</span>
        <span className="field-hint">This rule is too detailed to edit here. You can replace it.</span>
        <div className="row"><Button small onClick={() => onChange(undefined)}>Remove rule</Button></div>
      </div>
    );
  }
  if (!parsed) {
    return (
      <div className="field">
        <span>{title}</span>
        <div className="row"><Button small disabled={candidates.length === 0} onClick={() => onChange(fresh())}>Add a rule</Button></div>
        {candidates.length === 0 && <span className="field-hint">Add another field first.</span>}
      </div>
    );
  }
  const { mode, rules } = parsed;
  const setRule = (i: number, r: Leaf) => onChange(build(mode, rules.map((x, j) => (j === i ? r : x))));

  return (
    <fieldset className="cond" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <legend className="cond-title">{title}</legend>
      {rules.length > 1 && (
        <div className="field">
          <label htmlFor={`${idBase}-mode`}>Match</label>
          <select id={`${idBase}-mode`} value={mode} onChange={(e) => onChange(build(e.target.value as "all" | "any", rules))}>
            <option value="all">all of the rules</option>
            <option value="any">any of the rules</option>
          </select>
        </div>
      )}
      {rules.map((r, i) => {
        const ref = byId(r.field);
        const ops = opsFor(ref);
        const rid = `${idBase}-${i}`;
        const listVal = (Array.isArray((r as { value?: unknown }).value) ? (r as { value: (string | number)[] }).value : (r as { value?: unknown }).value !== undefined ? [(r as { value: string | number }).value] : []).map(String);
        return (
          <div className="cond-rule" key={i}>
            <div className="field">
              <label htmlFor={`${rid}-f`}>Field</label>
              <select id={`${rid}-f`} value={r.field} onChange={(e) => setRule(i, { field: e.target.value, op: "filled" })}>
                {!ref && <option value={r.field}>{r.field} (missing)</option>}
                {candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${rid}-o`}>Condition</label>
              <select id={`${rid}-o`} value={r.op} onChange={(e) => {
                const op = e.target.value as Op;
                if (NO_VALUE.includes(op)) setRule(i, { field: r.field, op } as Leaf);
                else if (LIST_OPS.includes(op)) setRule(i, { field: r.field, op, value: listVal } as Leaf);
                else setRule(i, { field: r.field, op, value: ref?.type === "boolean" ? true : ref?.choices?.[0] ?? "" } as Leaf);
              }}>
                {ops.map((o) => <option key={o} value={o}>{ref?.type === "boolean" && o === "eq" ? "is" : OP_LABEL[o]}</option>)}
              </select>
            </div>
            {!NO_VALUE.includes(r.op) && (
              <div className="field">
                <label htmlFor={`${rid}-v`}>Value</label>
                {ref?.type === "boolean" ? (
                  <select id={`${rid}-v`} value={String((r as { value: unknown }).value === true)} onChange={(e) => setRule(i, { field: r.field, op: r.op, value: e.target.value === "true" } as Leaf)}>
                    <option value="true">{ref.true_label || "Yes"}</option><option value="false">{ref.false_label || "No"}</option>
                  </select>
                ) : ref?.choices && LIST_OPS.includes(r.op) ? (
                  <div id={`${rid}-v`}>
                    {(ref?.choices ?? []).map((c) => (
                      <label className="check" key={c}>
                        <input type="checkbox" checked={listVal.includes(c)} onChange={(e) => setRule(i, { field: r.field, op: r.op, value: e.target.checked ? [...listVal, c] : listVal.filter((x) => x !== c) } as Leaf)} />{c}
                      </label>
                    ))}
                  </div>
                ) : ref?.choices ? (
                  <select id={`${rid}-v`} value={String((r as { value: unknown }).value ?? "")} onChange={(e) => setRule(i, { field: r.field, op: r.op, value: e.target.value } as Leaf)}>
                    {ref.choices.map((c) => <option key={c}>{c}</option>)}
                  </select>
                ) : LIST_OPS.includes(r.op) && r.op !== "contains" ? (
                  <input id={`${rid}-v`} value={listVal.join(", ")} placeholder="a, b, c" onChange={(e) => setRule(i, { field: r.field, op: r.op, value: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) } as Leaf)} />
                ) : (
                  <input id={`${rid}-v`} type={inputType(ref)} value={String((r as { value: unknown }).value ?? "")}
                    onChange={(e) => setRule(i, { field: r.field, op: r.op, value: inputType(ref) === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value } as Leaf)} />
                )}
              </div>
            )}
            <Button small variant="danger" onClick={() => onChange(build(mode, rules.filter((_, j) => j !== i)))}>Remove rule</Button>
          </div>
        );
      })}
      <div className="row"><Button small onClick={() => onChange(build(mode, [...rules, fresh()]))}>Add another rule</Button></div>
    </fieldset>
  );
}
