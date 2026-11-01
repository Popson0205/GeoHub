// The collector's languages: complete, placeholders intact, and switching changes what is shown.
const store = new Map<string, string>();
(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
import { KEYS, LANGS, getLang, missing, setLang, t } from "../src/lib/i18n";
import { validateProperties } from "../src/lib/forms";

const ok = (c: boolean, m: string) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exitCode = 1; };
const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

ok(getLang() === "en", "English unless the phone or the person asks for another language");
for (const l of LANGS) {
  const gaps = missing(l.id);
  ok(gaps.length === 0, `${l.name} has every text${gaps.length ? ` (missing: ${gaps.join(", ")})` : ""}`);
}
// every translation keeps the same {placeholders} as the English, so no number or name goes missing
setLang("en");
const enText = new Map(KEYS.map((k) => [k, t(k)] as const));
for (const l of LANGS) {
  setLang(l.id);
  const bad = KEYS.filter((k) => holes(t(k)) !== holes(enText.get(k)!));
  ok(bad.length === 0, `${l.name} keeps every placeholder in all ${KEYS.length} texts${bad.length ? ` (wrong: ${bad.join(", ")})` : ""}`);
}

setLang("yo");
ok(t("collect.new", { name: "kànga" }) === "kànga tuntun" && store.get("geohub.lang") === "yo", "Yoruba fills in the name, and the choice is remembered");
const form: any = { id: "f", fields: [{ id: "name", label: "Orúkọ", type: "text", required: true }, { id: "beds", label: "Ibùsùn", type: "number", min: 0 }] };
ok(validateProperties(form, { beds: -1 }).name === "Orúkọ jẹ́ dandan." && validateProperties(form, { name: "x", beds: -1 }).beds === "Ibùsùn kò gbọdọ̀ kéré ju 0.", "validation messages follow the language");
setLang("ha");
ok(t("tab.sync") === "Aika" && t("form.yes") === "Ee", "Hausa");
setLang("pcm");
ok(t("returned.fix") === "Fix am, send again", "Pidgin");
setLang("en");
ok(t("val.required", { label: "Name" }) === "Name is required.", "and back to English");
