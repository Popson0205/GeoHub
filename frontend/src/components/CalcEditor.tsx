import type { Calc, FormField, Operand } from "../lib/types";
import { Button } from "./ui";

type Fn = Calc["fn"];
const FN_LABEL: Record<Fn, string> = {
  sum: "Add up", product: "Multiply", min: "Smallest", max: "Largest", avg: "Average",
  diff: "First minus second", ratio: "First divided by second", concat: "Join as text",
  count_selected: "Count selected choices", today: "Today's date", now: "Current date and time",
};
const NUMERIC: Fn[] = ["sum", "product", "min", "max", "avg", "diff", "ratio"];

function withFn(fn: Fn, old: Calc | undefined): Calc {
  const args: Operand[] = old && "args" in old ? (old.args as Operand[]) : [];
  switch (fn) {
    case "diff": case "ratio": return { fn, args: [args[0] ?? { const: 0 }, args[1] ?? { const: 1 }] };
    case "count_selected": return { fn, args: [args[0] ?? { const: "" }] };
    case "concat": return { fn, args, sep: " " };
    case "today": case "now": return { fn };
    default: return { fn, args };
  }
}

interface Props { value: Calc | undefined; onChange: (c: Calc) => void; candidates: FormField[]; idBase: string }

export default function CalcEditor({ value, onChange, candidates, idBase }: Props) {
  const calc = value ?? { fn: "sum", args: [] } as Calc;
  const hasArgs = "args" in calc;
  const args: Operand[] = hasArgs ? (calc.args as Operand[]) : [];
  const fixed = calc.fn === "diff" || calc.fn === "ratio" || calc.fn === "count_selected";
  const numeric = NUMERIC.includes(calc.fn);
  const setArgs = (a: Operand[]) => onChange({ ...calc, args: a } as Calc);

  return (
    <div className="stack">
      <div className="field">
        <label htmlFor={`${idBase}-fn`}>What to calculate</label>
        <select id={`${idBase}-fn`} value={calc.fn} onChange={(e) => onChange(withFn(e.target.value as Fn, value))}>
          {(Object.keys(FN_LABEL) as Fn[]).map((f) => <option key={f} value={f}>{FN_LABEL[f]}</option>)}
        </select>
      </div>
      {hasArgs && args.map((a, i) => {
        const isField = "field" in a;
        const rid = `${idBase}-a${i}`;
        return (
          <div className="cond-rule" key={i}>
            <div className="field">
              <label htmlFor={`${rid}-k`}>{fixed ? (calc.fn === "count_selected" ? "Field" : i === 0 ? "First value" : "Second value") : `Value ${i + 1}`}</label>
              <select id={`${rid}-k`} value={isField ? "field" : "const"} disabled={calc.fn === "count_selected"}
                onChange={(e) => { const n = [...args]; n[i] = e.target.value === "field" ? { field: candidates[0]?.id ?? "" } : { const: numeric ? 0 : "" }; setArgs(n); }}>
                <option value="field">An answer</option>
                <option value="const">{numeric ? "A number" : "Fixed text"}</option>
              </select>
            </div>
            <div className="field">
              {isField ? (
                <select aria-label={`Answer for value ${i + 1}`} value={a.field} onChange={(e) => { const n = [...args]; n[i] = { field: e.target.value }; setArgs(n); }}>
                  {!candidates.some((c) => c.id === a.field) && <option value={a.field}>{a.field || "Choose…"}</option>}
                  {candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              ) : (
                <input aria-label={`Fixed value ${i + 1}`} type={numeric ? "number" : "text"} value={String(a.const)}
                  onChange={(e) => { const n = [...args]; n[i] = { const: numeric ? Number(e.target.value) : e.target.value }; setArgs(n); }} />
              )}
            </div>
            {!fixed && <Button small variant="danger" onClick={() => setArgs(args.filter((_, j) => j !== i))}>Remove value</Button>}
          </div>
        );
      })}
      {hasArgs && !fixed && (
        <div className="row"><Button small disabled={candidates.length === 0} onClick={() => setArgs([...args, { field: candidates[0]?.id ?? "" }])}>Add a value</Button></div>
      )}
      {calc.fn === "concat" && (
        <div className="field">
          <label htmlFor={`${idBase}-sep`}>Put this between values</label>
          <input id={`${idBase}-sep`} value={calc.sep ?? ""} onChange={(e) => onChange({ ...calc, sep: e.target.value })} />
        </div>
      )}
    </div>
  );
}
