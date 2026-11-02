import { useEffect, useState } from "react";

/**
 * Languages for the collector (the phone app and shared forms). Question labels written by a project's
 * administrators are shown as written; this covers everything Geohub itself says.
 *
 * The Yoruba, Hausa, Igbo and Pidgin texts are drafts. Have a native speaker who knows the field teams
 * read them before relying on them; fix a text here and every screen picks it up.
 */
export type Lang = "en" | "yo" | "ha" | "ig" | "pcm";
export const LANGS: { id: Lang; name: string }[] = [
  { id: "en", name: "English" }, { id: "yo", name: "Yorùbá" }, { id: "ha", name: "Hausa" }, { id: "ig", name: "Igbo" }, { id: "pcm", name: "Naijá (Pidgin)" },
];

const en = {
  "sync.waitOne": "1 change waiting to send", "sync.waitMany": "{n} changes waiting to send", "sync.refusedOne": "1 record was not accepted", "sync.refusedMany": "{n} records were not accepted", "sync.refusedText": "The server refused them. Discard them and collect again.", "head.project": "Project", "head.shared": "Shared form", "head.back": "Back to projects", "head.online": "Online", "head.offline": "Offline", "head.language": "Language",
  "tab.collect": "Collect", "tab.data": "My data", "tab.sync": "Sync", "tab.sections": "Collector sections", "tab.returned": "returned for changes",
  "load.project": "Loading your project…", "load.cached": "Using saved forms from this device",
  "forms.none.title": "No published forms", "forms.none.text": "Ask the project admin to publish a form, then sync.",
  "collect.title": "Collect", "collect.form": "Form", "collect.new": "New {name}", "collect.edit": "Edit {name}", "collect.step1": "Step 1: set the location.",
  "collect.holdStill": "Holding still improves it. Now ±{m} m.",
  "collect.capture": "Capture at my location", "collect.place": "Place on the map", "collect.draw": "Draw the shape on the map",
  "collect.saveOnline": "Save record", "collect.saveOffline": "Save on this device", "cancel": "Cancel", "edit": "Edit", "delete": "Delete",
  "toast.fixFields": "Fix the highlighted fields first.", "toast.savedSyncing": "Saved. Syncing…", "toast.savedOffline": "Saved on this device. It will sync when you're online.",
  "toast.deleted": "“{name}” deleted.", "toast.syncDone": "Synced. Sent {sent}, received {got}.", "toast.syncDecide": "{n} need a decision.", "toast.syncError": "Couldn't sync. Your data is safe on this device.",
  "gps.noDevice": "This device can't provide a location. Place the point on the map instead.",
  "gps.denied": "Location permission is off. Allow it in settings, or place the point on the map.",
  "gps.noFix": "Couldn't get a location fix. Move to open sky and try again, or place the point on the map.",
  "gps.finding": "Finding GPS…", "gps.ready": "GPS ready ±{m} m", "gps.averaging": "averaging", "gps.readings": "{n} readings", "gps.elev": "{m} m elev.", "gps.standStill": "Stand still at the spot. It stops by itself when the reading is good.", "gps.useNow": "Use this location", "gps.again": "Measure again", "gps.moved": "You moved, so the reading started again. Stand still at the spot.", "gps.tip": "The location may be off. For a better reading, stand in the open away from walls and trees, hold the phone up, and measure again. On Android, turn on Google Location Accuracy in location settings.",
  "media.photo": "Take photo", "media.audio": "Record audio", "media.video": "Record video", "media.file": "Attach file", "media.cap": "You can add up to {n} here.", "media.remove": "Remove {name} {i}",
  "data.title": "My data", "data.empty.title": "Nothing collected yet", "data.empty.text": "Records you save appear here, even offline.",
  "status.synced": "Synced", "status.pending": "Waiting to sync", "status.conflict": "Needs a decision", "status.rejected": "Not accepted: {why}",
  "returned.title": "Returned for changes", "returned.one": "A reviewer sent this record back. Fix and save: it goes back for review.",
  "returned.many": "A reviewer sent these records back. Fix and save: they go back for review.", "returned.noteLabel": "Reviewer's note:",
  "returned.noNote": "The reviewer did not leave a note.", "returned.fix": "Fix and resend",
  "sync.title": "Sync", "sync.online": "You're online", "sync.offline": "You're offline", "sync.now": "Sync now",
  "sync.offlineText": "Connect to the internet to sync. Your records are safe on this device.", "sync.failed": "Last sync failed", "sync.last": "Last sync",
  "sync.report": "Sent {sent} · received {got} · photos {photos}", "sync.discard": "Discard",
  "conflict.title": "Someone else changed “{name}”", "conflict.hint": "You both edited it before syncing. Keep one version, or choose answer by answer.",
  "conflict.same": "The answers are the same; only the record's history differs.", "conflict.question": "Question", "conflict.theirs": "Theirs", "conflict.yours": "Yours",
  "conflict.location": "Location", "conflict.apart": "The two locations are {d}", "conflict.keepWhich": "Keep which {name}",
  "conflict.keepTheirs": "Keep all theirs", "conflict.keepMine": "Keep all mine", "conflict.save": "Save my choices", "conflict.notAnswered": "Not answered",
  "form.choose": "Choose…", "form.noneYet": "None added yet.", "form.back": "Back", "form.next": "Next", "form.keepOrder": "Keep this order", "form.scan": "Scan or type the code",
  "form.yes": "Yes", "form.no": "No",
  "sig.clear": "Clear", "sig.use": "Use signature",
  "val.required": "{label} is required.", "val.choice": "Choose one of the listed options.", "val.choices": "Choose only from the listed options.",
  "val.atLeast": "Choose at least {n}.", "val.atMost": "Choose at most {n}.", "val.number": "{label} must be a number.", "val.whole": "{label} must be a whole number.",
  "val.min": "{label} must be at least {n}.", "val.max": "{label} must be at most {n}.", "val.date": "{label} must be a valid date.", "val.yesNo": "{label} must be yes or no.",
  "val.accept": "{label} must be accepted to continue.", "val.filesMax": "{label} can have at most {n}.", "val.filesMin": "{label} needs at least {n}.",
};
export type Key = keyof typeof en;
export const KEYS = Object.keys(en) as Key[];
type Dict = Partial<Record<Key, string>>;

const yo: Dict = {
  "sync.waitOne": "Àyípadà 1 ń dúró láti lọ", "sync.waitMany": "Àyípadà {n} ń dúró láti lọ", "sync.refusedOne": "A kò gba ìwé 1", "sync.refusedMany": "A kò gba ìwé {n}", "sync.refusedText": "Sáfà kọ̀ wọ́n. Pa wọ́n tì kí o sì tún kó jọ.", "tab.sections": "Àwọn apá olùkójọ", "head.project": "Iṣẹ́ àkànṣe", "head.shared": "Fọ́ọ̀mù tí a pín", "head.back": "Padà sí àwọn iṣẹ́", "head.online": "Lórí ayélujára", "head.offline": "Kò sí ayélujára", "head.language": "Èdè",
  "tab.collect": "Kó jọ", "tab.data": "Dátà mi", "tab.sync": "Fi ránṣẹ́", "tab.returned": "tí a dá padà fún àtúnṣe",
  "load.project": "À ń gbé iṣẹ́ rẹ wọlé…", "load.cached": "À ń lo fọ́ọ̀mù tí a fi pamọ́ sórí ẹ̀rọ yìí",
  "forms.none.title": "Kò sí fọ́ọ̀mù tí a tẹ̀ jáde", "forms.none.text": "Sọ fún alákòóso iṣẹ́ láti tẹ fọ́ọ̀mù jáde, lẹ́yìn náà fi ránṣẹ́.",
  "collect.title": "Kó jọ", "collect.form": "Fọ́ọ̀mù", "collect.new": "{name} tuntun", "collect.edit": "Ṣàtúnṣe {name}", "collect.step1": "Ìgbésẹ̀ 1: sàmì sí ibi tí ó wà.",
  "collect.holdStill": "Dúró jẹ́ẹ́ kí ó lè péye sí i. Ó ti di ±{m} m.",
  "collect.capture": "Mú ibi tí mo wà", "collect.place": "Fi sí orí máàpù", "collect.draw": "Ya àwòrán rẹ̀ sórí máàpù",
  "collect.saveOnline": "Fi pamọ́", "collect.saveOffline": "Fi pamọ́ sórí ẹ̀rọ yìí", "cancel": "Fagilé", "edit": "Ṣàtúnṣe", "delete": "Pa rẹ́",
  "toast.fixFields": "Kọ́kọ́ ṣàtúnṣe àwọn ibi tí a sàmì sí.", "toast.savedSyncing": "A ti fi pamọ́. À ń fi ránṣẹ́…", "toast.savedOffline": "A ti fi pamọ́ sórí ẹ̀rọ yìí. Yóò lọ nígbà tí o bá wà lórí ayélujára.",
  "toast.deleted": "A ti pa “{name}” rẹ́.", "toast.syncDone": "Ó ti lọ. A fi {sent} ránṣẹ́, a gba {got}.", "toast.syncDecide": "{n} nílò ìpinnu.", "toast.syncError": "Kò ṣeé ṣe láti fi ránṣẹ́. Dátà rẹ wà láìléwu lórí ẹ̀rọ yìí.",
  "gps.noDevice": "Ẹ̀rọ yìí kò lè rí ibi tí o wà. Fi ààmì sí orí máàpù dípò rẹ̀.",
  "gps.denied": "Ààyè ipò ti wà ní pípa. Ṣí i nínú ètò, tàbí fi ààmì sí orí máàpù.",
  "gps.noFix": "A kò rí ipò rẹ. Lọ sí ibi tí ojú ọ̀run ti hàn kí o tún gbìyànjú, tàbí fi ààmì sí orí máàpù.",
  "gps.finding": "Ń wá GPS…", "gps.ready": "GPS ti ṣetán ±{m} m", "gps.averaging": "ó ń ṣírò àròpọ̀", "gps.readings": "ìwọ̀n {n}", "gps.elev": "gíga {m} m", "gps.standStill": "Dúró jẹ́ẹ́ níbẹ̀. Yóò dá dúró fúnra rẹ̀ nígbà tí ìwọ̀n bá dára.", "gps.useNow": "Lo ibí yìí", "gps.again": "Tún wọ̀n", "gps.moved": "O ti rìn, nítorí náà ìwọ̀n ti bẹ̀rẹ̀ lẹ́ẹ̀kan sí i. Dúró jẹ́ẹ́ níbẹ̀.", "gps.tip": "Ibi náà lè má péye. Fún ìwọ̀n tó dára jù, dúró ní gbangba kúrò lẹ́gbẹ̀ẹ́ ògiri àti igi, gbé fóònù sókè, kí o tún wọ̀n. Lórí Android, tan Google Location Accuracy nínú ètò ipò.",
  "media.photo": "Ya fọ́tò", "media.audio": "Gba ohùn sílẹ̀", "media.video": "Ya fídíò", "media.file": "So fáìlì mọ́", "media.cap": "O lè fi tó {n} kún un níbí.", "media.remove": "Yọ {name} {i} kúrò",
  "data.title": "Dátà mi", "data.empty.title": "O kò tíì kó nǹkankan jọ", "data.empty.text": "Àwọn ohun tí o fi pamọ́ yóò hàn níbí, kódà láìsí ayélujára.",
  "status.synced": "Ó ti lọ", "status.pending": "Ó ń dúró láti lọ", "status.conflict": "Ó nílò ìpinnu", "status.rejected": "A kò gbà á: {why}",
  "returned.title": "Tí a dá padà fún àtúnṣe", "returned.one": "Olùyẹ̀wò dá ìwé yìí padà. Ṣàtúnṣe kí o sì fi pamọ́: yóò padà lọ fún àyẹ̀wò.",
  "returned.many": "Olùyẹ̀wò dá àwọn ìwé yìí padà. Ṣàtúnṣe kí o sì fi pamọ́: wọn yóò padà lọ fún àyẹ̀wò.", "returned.noteLabel": "Ọ̀rọ̀ olùyẹ̀wò:",
  "returned.noNote": "Olùyẹ̀wò kò fi ọ̀rọ̀ kankan sílẹ̀.", "returned.fix": "Ṣàtúnṣe kí o fi ránṣẹ́",
  "sync.title": "Fi ránṣẹ́", "sync.online": "O wà lórí ayélujára", "sync.offline": "O kò sí lórí ayélujára", "sync.now": "Fi ránṣẹ́ báyìí",
  "sync.offlineText": "Sopọ̀ mọ́ ayélujára láti fi ránṣẹ́. Àwọn ìwé rẹ wà láìléwu lórí ẹ̀rọ yìí.", "sync.failed": "Ìfiránṣẹ́ tó kẹ́yìn kùnà", "sync.last": "Ìfiránṣẹ́ tó kẹ́yìn",
  "sync.report": "A fi {sent} ránṣẹ́ · a gba {got} · fọ́tò {photos}", "sync.discard": "Pa tì",
  "conflict.title": "Ẹlòmíràn ti yí “{name}” padà", "conflict.hint": "Ẹ̀yin méjèèjì ló ṣàtúnṣe rẹ̀ kí ó tó lọ. Mú ẹ̀dà kan, tàbí yan ìdáhùn kọ̀ọ̀kan.",
  "conflict.same": "Ìdáhùn kan náà ni; ìtàn ìwé náà nìkan ló yàtọ̀.", "conflict.question": "Ìbéèrè", "conflict.theirs": "Tiwọn", "conflict.yours": "Tìrẹ",
  "conflict.location": "Ibi", "conflict.apart": "Àwọn ibi méjèèjì jìnnà síra wọn ní {d}", "conflict.keepWhich": "Èwo ni kí a mú fún {name}",
  "conflict.keepTheirs": "Mú gbogbo tiwọn", "conflict.keepMine": "Mú gbogbo tèmi", "conflict.save": "Fi àṣàyàn mi pamọ́", "conflict.notAnswered": "Kò dáhùn",
  "form.choose": "Yàn…", "form.noneYet": "Kò sí nǹkankan síbẹ̀.", "form.back": "Padà", "form.next": "Èyí tó kàn", "form.keepOrder": "Fi ètò yìí sílẹ̀", "form.scan": "Ṣàyẹ̀wò kóòdù tàbí tẹ̀ ẹ́",
  "form.yes": "Bẹ́ẹ̀ni", "form.no": "Bẹ́ẹ̀kọ́",
  "sig.clear": "Pa á rẹ́", "sig.use": "Lo ìbuwọ́lù yìí",
  "val.required": "{label} jẹ́ dandan.", "val.choice": "Yan ọ̀kan nínú àwọn àṣàyàn.", "val.choices": "Yàn láti inú àwọn àṣàyàn nìkan.",
  "val.atLeast": "Yan ó kéré tán {n}.", "val.atMost": "Yan ó pọ̀ jù {n}.", "val.number": "{label} gbọ́dọ̀ jẹ́ nọ́mbà.", "val.whole": "{label} gbọ́dọ̀ jẹ́ odidi nọ́mbà.",
  "val.min": "{label} kò gbọdọ̀ kéré ju {n}.", "val.max": "{label} kò gbọdọ̀ ju {n} lọ.", "val.date": "{label} gbọ́dọ̀ jẹ́ ọjọ́ tó tọ́.", "val.yesNo": "{label} gbọ́dọ̀ jẹ́ bẹ́ẹ̀ni tàbí bẹ́ẹ̀kọ́.",
  "val.accept": "O gbọ́dọ̀ gba {label} kí o tó tẹ̀síwájú.", "val.filesMax": "{label} kò lè ju {n} lọ.", "val.filesMin": "{label} nílò ó kéré tán {n}.",
};

const ha: Dict = {
  "sync.waitOne": "Canji 1 yana jiran aikawa", "sync.waitMany": "Canje-canje {n} suna jiran aikawa", "sync.refusedOne": "Ba a karɓi bayani 1 ba", "sync.refusedMany": "Ba a karɓi bayanai {n} ba", "sync.refusedText": "Sabar ta ƙi su. Ka watsar da su ka sake tattarawa.", "tab.sections": "Sassan mai tattarawa", "head.project": "Aiki", "head.shared": "Fom da aka raba", "head.back": "Koma ga ayyuka", "head.online": "Kan layi", "head.offline": "Babu layi", "head.language": "Harshe",
  "tab.collect": "Tattara", "tab.data": "Bayanaina", "tab.sync": "Aika", "tab.returned": "da aka dawo don gyara",
  "load.project": "Ana loda aikinka…", "load.cached": "Ana amfani da fom da aka ajiye a wannan na'ura",
  "forms.none.title": "Babu fom da aka wallafa", "forms.none.text": "Ka roƙi mai kula da aikin ya wallafa fom, sannan ka aika.",
  "collect.title": "Tattara", "collect.form": "Fom", "collect.new": "Sabon {name}", "collect.edit": "Gyara {name}", "collect.step1": "Mataki na 1: saita wurin.",
  "collect.holdStill": "Ka tsaya cik don ya ƙara daidai. Yanzu ±{m} m.",
  "collect.capture": "Ɗauki wurin da nake", "collect.place": "Sanya a kan taswira", "collect.draw": "Zana siffar a kan taswira",
  "collect.saveOnline": "Ajiye bayani", "collect.saveOffline": "Ajiye a wannan na'ura", "cancel": "Soke", "edit": "Gyara", "delete": "Goge",
  "toast.fixFields": "Ka gyara wuraren da aka haskaka tukuna.", "toast.savedSyncing": "An ajiye. Ana aikawa…", "toast.savedOffline": "An ajiye a wannan na'ura. Za a aika idan ka sami layi.",
  "toast.deleted": "An goge “{name}”.", "toast.syncDone": "An aika. An tura {sent}, an karɓi {got}.", "toast.syncDecide": "{n} na bukatar zaɓi.", "toast.syncError": "Ba a iya aikawa ba. Bayananka suna nan lafiya a wannan na'ura.",
  "gps.noDevice": "Wannan na'ura ba ta iya gano wuri. Ka sanya alamar a kan taswira maimakon haka.",
  "gps.denied": "An kashe izinin wuri. Ka kunna shi a saituna, ko ka sanya alamar a kan taswira.",
  "gps.noFix": "Ba a sami wurinka ba. Ka matsa zuwa fili ka sake gwadawa, ko ka sanya alamar a kan taswira.",
  "gps.finding": "Ana neman GPS…", "gps.ready": "GPS ya shirya ±{m} m", "gps.averaging": "ana lissafin matsakaici", "gps.readings": "karatu {n}", "gps.elev": "tsayi {m} m", "gps.standStill": "Ka tsaya cik a wurin. Zai tsaya da kansa idan karatun ya yi kyau.", "gps.useNow": "Yi amfani da wannan wurin", "gps.again": "Sake aunawa", "gps.moved": "Ka motsa, don haka karatun ya sake farawa. Ka tsaya cik a wurin.", "gps.tip": "Wurin bazai yi daidai ba. Don karatu mafi kyau, ka tsaya a fili nesa da bango da bishiyoyi, ka ɗaga wayar sama, ka sake aunawa. A Android, ka kunna Google Location Accuracy a saitunan wuri.",
  "media.photo": "Ɗauki hoto", "media.audio": "Naɗi murya", "media.video": "Naɗi bidiyo", "media.file": "Haɗa fayil", "media.cap": "Za ka iya ƙara har {n} a nan.", "media.remove": "Cire {name} {i}",
  "data.title": "Bayanaina", "data.empty.title": "Ba a tattara komai ba tukuna", "data.empty.text": "Bayanan da ka ajiye za su bayyana a nan, ko babu layi.",
  "status.synced": "An aika", "status.pending": "Yana jiran aikawa", "status.conflict": "Yana bukatar zaɓi", "status.rejected": "Ba a karɓa ba: {why}",
  "returned.title": "An dawo da su don gyara", "returned.one": "Mai dubawa ya dawo da wannan bayani. Ka gyara ka ajiye: zai koma don dubawa.",
  "returned.many": "Mai dubawa ya dawo da waɗannan bayanai. Ka gyara ka ajiye: za su koma don dubawa.", "returned.noteLabel": "Bayanin mai dubawa:",
  "returned.noNote": "Mai dubawa bai bar bayani ba.", "returned.fix": "Gyara ka sake aikawa",
  "sync.title": "Aika", "sync.online": "Kana kan layi", "sync.offline": "Ba ka kan layi", "sync.now": "Aika yanzu",
  "sync.offlineText": "Ka haɗa da intanet don aikawa. Bayananka suna nan lafiya a wannan na'ura.", "sync.failed": "Aikawa ta ƙarshe ta gaza", "sync.last": "Aikawa ta ƙarshe",
  "sync.report": "An tura {sent} · an karɓi {got} · hotuna {photos}", "sync.discard": "Watsar",
  "conflict.title": "Wani ya canza “{name}”", "conflict.hint": "Ku biyu kun gyara shi kafin aikawa. Ka riƙe ɗaya, ko ka zaɓi amsa ɗaya bayan ɗaya.",
  "conflict.same": "Amsoshin iri ɗaya ne; tarihin bayanin ne kaɗai ya bambanta.", "conflict.question": "Tambaya", "conflict.theirs": "Nasu", "conflict.yours": "Naka",
  "conflict.location": "Wuri", "conflict.apart": "Tazarar wuraren biyu {d}", "conflict.keepWhich": "Wanne za a riƙe don {name}",
  "conflict.keepTheirs": "Riƙe duk nasu", "conflict.keepMine": "Riƙe duk nawa", "conflict.save": "Ajiye zaɓuɓɓukana", "conflict.notAnswered": "Ba a amsa ba",
  "form.choose": "Zaɓi…", "form.noneYet": "Ba a ƙara komai ba tukuna.", "form.back": "Baya", "form.next": "Gaba", "form.keepOrder": "Riƙe wannan tsari", "form.scan": "Duba lambar ko ka rubuta ta",
  "form.yes": "Ee", "form.no": "A'a",
  "sig.clear": "Share", "sig.use": "Yi amfani da sa hannu",
  "val.required": "{label} dole ne.", "val.choice": "Zaɓi ɗaya daga cikin zaɓuɓɓukan.", "val.choices": "Zaɓi daga cikin zaɓuɓɓukan kaɗai.",
  "val.atLeast": "Zaɓi aƙalla {n}.", "val.atMost": "Zaɓi bai wuce {n} ba.", "val.number": "{label} dole ya zama lamba.", "val.whole": "{label} dole ya zama cikakkiyar lamba.",
  "val.min": "{label} dole ya kai aƙalla {n}.", "val.max": "{label} kada ya wuce {n}.", "val.date": "{label} dole ya zama kwanan wata mai inganci.", "val.yesNo": "{label} dole ya zama ee ko a'a.",
  "val.accept": "Dole ka amince da {label} kafin ka ci gaba.", "val.filesMax": "{label} ba zai wuce {n} ba.", "val.filesMin": "{label} na bukatar aƙalla {n}.",
};

const ig: Dict = {
  "sync.waitOne": "Mgbanwe 1 na-eche ka ezipu", "sync.waitMany": "Mgbanwe {n} na-eche ka ezipu", "sync.refusedOne": "Anabataghị ndekọ 1", "sync.refusedMany": "Anabataghị ndekọ {n}", "sync.refusedText": "Sava jụrụ ha. Tụfuo ha wee chịkọta ọzọ.", "tab.sections": "Ngalaba onye nchịkọta", "head.project": "Ọrụ", "head.shared": "Fọm e kesara", "head.back": "Laghachi na ọrụ niile", "head.online": "Nọ n'ịntanetị", "head.offline": "Enweghị ịntanetị", "head.language": "Asụsụ",
  "tab.collect": "Chịkọta", "tab.data": "Data m", "tab.sync": "Zipu", "tab.returned": "e weghachiri ka a dozie",
  "load.project": "Na-ebuli ọrụ gị…", "load.cached": "Na-eji fọm echekwara na ngwaọrụ a",
  "forms.none.title": "Enweghị fọm e bipụtara", "forms.none.text": "Gwa onye na-elekọta ọrụ ka o bipụta fọm, wee zipu.",
  "collect.title": "Chịkọta", "collect.form": "Fọm", "collect.new": "{name} ọhụrụ", "collect.edit": "Dezie {name}", "collect.step1": "Nzọụkwụ 1: debe ebe ọ dị.",
  "collect.holdStill": "Guzosie ike ka ọ ka zie ezie. Ugbu a ±{m} m.",
  "collect.capture": "Were ebe m nọ", "collect.place": "Debe ya na maapụ", "collect.draw": "See ọdịdị ya na maapụ",
  "collect.saveOnline": "Chekwaa", "collect.saveOffline": "Chekwaa na ngwaọrụ a", "cancel": "Kagbuo", "edit": "Dezie", "delete": "Hichapụ",
  "toast.fixFields": "Buru ụzọ dozie ebe ndị a kara akara.", "toast.savedSyncing": "Echekwala. Na-ezipu…", "toast.savedOffline": "Echekwala na ngwaọrụ a. Ọ ga-aga mgbe ị nọ n'ịntanetị.",
  "toast.deleted": "Ehichapụla “{name}”.", "toast.syncDone": "Ezipụla. Ezipụrụ {sent}, nata {got}.", "toast.syncDecide": "{n} chọrọ mkpebi.", "toast.syncError": "Enweghị ike ịzipu. Data gị dị mma na ngwaọrụ a.",
  "gps.noDevice": "Ngwaọrụ a enweghị ike ịchọta ebe ị nọ. Debe akara na maapụ kama.",
  "gps.denied": "Ikike ọnọdụ gbanyụrụ. Kwe ya na ntọala, ma ọ bụ debe akara na maapụ.",
  "gps.noFix": "Achọtaghị ebe ị nọ. Gaa ebe mbara igwe na-egosi wee nwaa ọzọ, ma ọ bụ debe akara na maapụ.",
  "gps.finding": "Na-achọ GPS…", "gps.ready": "GPS adịla njikere ±{m} m", "gps.averaging": "na-agbakọ nkezi", "gps.readings": "ọgụgụ {n}", "gps.elev": "ịdị elu {m} m", "gps.standStill": "Guzoro ebe ahụ. Ọ ga-akwụsị n'onwe ya mgbe ọgụgụ dị mma.", "gps.useNow": "Jiri ebe a", "gps.again": "Tụọ ọzọ", "gps.moved": "Ị kwagharịrị, ya mere ọgụgụ amalitere ọzọ. Guzoro ebe ahụ.", "gps.tip": "Ebe ahụ nwere ike ọ gaghị ezi ezi. Maka ọgụgụ ka mma, guzo n'ebe mepere emepe pụọ na mgbidi na osisi, welie ekwentị elu, ma tụọ ọzọ. Na Android, gbanye Google Location Accuracy na ntọala ọnọdụ.",
  "media.photo": "See foto", "media.audio": "Dekọọ olu", "media.video": "Dekọọ vidiyo", "media.file": "Tinye faịlụ", "media.cap": "Ị nwere ike itinye ruo {n} ebe a.", "media.remove": "Wepụ {name} {i}",
  "data.title": "Data m", "data.empty.title": "Ọ dịbeghị ihe ị chịkọtara", "data.empty.text": "Ihe ị chekwara ga-apụta ebe a, ọbụna na-enweghị ịntanetị.",
  "status.synced": "Ezipụla", "status.pending": "Na-eche ka ezipu", "status.conflict": "Chọrọ mkpebi", "status.rejected": "Anabataghị ya: {why}",
  "returned.title": "E weghachiri ka a dozie", "returned.one": "Onye nyocha weghachiri ndekọ a. Dozie ya wee chekwaa: ọ ga-alaghachi maka nyocha.",
  "returned.many": "Onye nyocha weghachiri ndekọ ndị a. Dozie ha wee chekwaa: ha ga-alaghachi maka nyocha.", "returned.noteLabel": "Okwu onye nyocha:",
  "returned.noNote": "Onye nyocha ahapụghị okwu ọ bụla.", "returned.fix": "Dozie ma zipu ọzọ",
  "sync.title": "Zipu", "sync.online": "Ị nọ n'ịntanetị", "sync.offline": "Ị nọghị n'ịntanetị", "sync.now": "Zipu ugbu a",
  "sync.offlineText": "Jikọọ na ịntanetị iji zipu. Ndekọ gị dị mma na ngwaọrụ a.", "sync.failed": "Nziputa ikpeazụ dara", "sync.last": "Nziputa ikpeazụ",
  "sync.report": "Ezipụrụ {sent} · nata {got} · foto {photos}", "sync.discard": "Tụfuo",
  "conflict.title": "Onye ọzọ gbanwere “{name}”", "conflict.hint": "Unu abụọ dezịrị ya tupu ezipu ya. Debe otu, ma ọ bụ họrọ azịza n'otu n'otu.",
  "conflict.same": "Azịza ndị ahụ bụ otu; naanị akụkọ ndekọ ahụ dị iche.", "conflict.question": "Ajụjụ", "conflict.theirs": "Nke ha", "conflict.yours": "Nke gị",
  "conflict.location": "Ebe", "conflict.apart": "Ebe abụọ ahụ dị anya {d}", "conflict.keepWhich": "Kedu nke a ga-edebe maka {name}",
  "conflict.keepTheirs": "Debe nke ha niile", "conflict.keepMine": "Debe nke m niile", "conflict.save": "Chekwaa nhọrọ m", "conflict.notAnswered": "Azaghị ya",
  "form.choose": "Họrọ…", "form.noneYet": "Ọ dịbeghị ihe agbakwunyere.", "form.back": "Azụ", "form.next": "Ọzọ", "form.keepOrder": "Debe usoro a", "form.scan": "Nyochaa koodu ma ọ bụ dee ya",
  "form.yes": "Ee", "form.no": "Mba",
  "sig.clear": "Hichapụ", "sig.use": "Jiri mbinye aka a",
  "val.required": "{label} dị mkpa.", "val.choice": "Họrọ otu n'ime nhọrọ ndị ahụ.", "val.choices": "Họrọ naanị site na nhọrọ ndị ahụ.",
  "val.atLeast": "Họrọ opekata mpe {n}.", "val.atMost": "Họrọ ihe na-erughị {n}.", "val.number": "{label} ga-abụ nọmba.", "val.whole": "{label} ga-abụ nọmba zuru ezu.",
  "val.min": "{label} ga-adị opekata mpe {n}.", "val.max": "{label} agaghị agafe {n}.", "val.date": "{label} ga-abụ ụbọchị ziri ezi.", "val.yesNo": "{label} ga-abụ ee ma ọ bụ mba.",
  "val.accept": "Ị ga-anabata {label} tupu ị gaa n'ihu.", "val.filesMax": "{label} agaghị agafe {n}.", "val.filesMin": "{label} chọrọ opekata mpe {n}.",
};

const pcm: Dict = {
  "sync.waitOne": "1 change dey wait to send", "sync.waitMany": "{n} changes dey wait to send", "sync.refusedOne": "Dem no accept 1 record", "sync.refusedMany": "Dem no accept {n} records", "sync.refusedText": "Server refuse dem. Comot dem, collect again.", "tab.sections": "Collector sections", "head.project": "Project", "head.shared": "Form wey dem share", "head.back": "Go back to projects", "head.online": "Online", "head.offline": "No network", "head.language": "Language",
  "tab.collect": "Collect", "tab.data": "My data", "tab.sync": "Send", "tab.returned": "wey dem return make you fix",
  "load.project": "Dey load your project…", "load.cached": "Dey use forms wey dey this phone",
  "forms.none.title": "No form never comot", "forms.none.text": "Tell the project admin make e publish form, then send again.",
  "collect.title": "Collect", "collect.form": "Form", "collect.new": "New {name}", "collect.edit": "Change {name}", "collect.step1": "Step 1: put where e dey.",
  "collect.holdStill": "Stand one place make e correct well. Now na ±{m} m.",
  "collect.capture": "Take where I dey", "collect.place": "Put am for map", "collect.draw": "Draw the shape for map",
  "collect.saveOnline": "Save am", "collect.saveOffline": "Save am for this phone", "cancel": "Cancel", "edit": "Change", "delete": "Delete",
  "toast.fixFields": "Fix the places wey dem mark first.", "toast.savedSyncing": "E don save. E dey send…", "toast.savedOffline": "E don save for this phone. E go send when network come.",
  "toast.deleted": "“{name}” don delete.", "toast.syncDone": "E don send. You send {sent}, you collect {got}.", "toast.syncDecide": "{n} need make you choose.", "toast.syncError": "E no fit send. Your data still dey safe for this phone.",
  "gps.noDevice": "This phone no fit find where you dey. Put the point for map instead.",
  "gps.denied": "Location permission don off. On am for settings, or put the point for map.",
  "gps.noFix": "We no fit find where you dey. Waka go open place try again, or put the point for map.",
  "gps.finding": "Dey find GPS…", "gps.ready": "GPS don ready ±{m} m", "gps.averaging": "e dey average am", "gps.readings": "{n} readings", "gps.elev": "{m} m high", "gps.standStill": "Stand for one place. E go stop by itself when di reading don correct.", "gps.useNow": "Use dis place", "gps.again": "Measure am again", "gps.moved": "You waka comot, so di reading don start again. Stand for di place.", "gps.tip": "Di location fit no correct. Make e better: stand for open place far from wall and tree, raise di phone up, then measure again. For Android, on Google Location Accuracy for location settings.",
  "media.photo": "Snap picture", "media.audio": "Record voice", "media.video": "Record video", "media.file": "Add file", "media.cap": "You fit add reach {n} for here.", "media.remove": "Remove {name} {i}",
  "data.title": "My data", "data.empty.title": "You never collect anything", "data.empty.text": "Wetin you save go show here, even without network.",
  "status.synced": "E don send", "status.pending": "E dey wait to send", "status.conflict": "You need choose", "status.rejected": "Dem no accept am: {why}",
  "returned.title": "Dem return am make you fix", "returned.one": "Reviewer send this record back. Fix am, save am: e go go back for check.",
  "returned.many": "Reviewer send these records back. Fix dem, save dem: dem go go back for check.", "returned.noteLabel": "Wetin reviewer talk:",
  "returned.noNote": "Reviewer no leave any message.", "returned.fix": "Fix am, send again",
  "sync.title": "Send", "sync.online": "You dey online", "sync.offline": "You no get network", "sync.now": "Send now",
  "sync.offlineText": "Connect to internet to send. Your records dey safe for this phone.", "sync.failed": "Last send no work", "sync.last": "Last send",
  "sync.report": "You send {sent} · you collect {got} · pictures {photos}", "sync.discard": "Comot am",
  "conflict.title": "Another person don change “{name}”", "conflict.hint": "Una two change am before e send. Keep one, or choose answer by answer.",
  "conflict.same": "The answers na the same; na only the record history different.", "conflict.question": "Question", "conflict.theirs": "Their own", "conflict.yours": "Your own",
  "conflict.location": "Place", "conflict.apart": "The two places far {d}", "conflict.keepWhich": "Which one to keep for {name}",
  "conflict.keepTheirs": "Keep all their own", "conflict.keepMine": "Keep all my own", "conflict.save": "Save wetin I choose", "conflict.notAnswered": "No answer",
  "form.choose": "Choose…", "form.noneYet": "Nothing never dey.", "form.back": "Back", "form.next": "Next", "form.keepOrder": "Keep this arrangement", "form.scan": "Scan the code or type am",
  "form.yes": "Yes", "form.no": "No",
  "sig.clear": "Clear am", "sig.use": "Use this signature",
  "val.required": "You must answer {label}.", "val.choice": "Choose one from the options.", "val.choices": "Choose only from the options.",
  "val.atLeast": "Choose at least {n}.", "val.atMost": "No choose pass {n}.", "val.number": "{label} must be number.", "val.whole": "{label} must be full number.",
  "val.min": "{label} no fit small pass {n}.", "val.max": "{label} no fit pass {n}.", "val.date": "{label} must be correct date.", "val.yesNo": "{label} must be yes or no.",
  "val.accept": "You must accept {label} before you continue.", "val.filesMax": "{label} no fit pass {n}.", "val.filesMin": "{label} need at least {n}.",
};

const DICTS: Record<Lang, Dict> = { en, yo, ha, ig, pcm };
const KEY = "geohub.lang";
const listeners = new Set<(l: Lang) => void>();

function initial(): Lang {
  try { const saved = localStorage.getItem(KEY) as Lang | null; if (saved && saved in DICTS) return saved; } catch { /* private mode */ }
  const nav = typeof navigator !== "undefined" && typeof navigator.language === "string" ? navigator.language.toLowerCase() : "";
  const two = nav.slice(0, 3) === "pcm" ? "pcm" : nav.slice(0, 2);
  return (two in DICTS ? two : "en") as Lang;
}
let current: Lang = initial();

export const getLang = (): Lang => current;
export function setLang(l: Lang): void {
  current = l;
  try { localStorage.setItem(KEY, l); } catch { /* private mode: still changes for this visit */ }
  if (typeof document !== "undefined") document.documentElement.lang = l === "pcm" ? "pcm" : l;
  for (const fn of listeners) fn(l);
}

/** The text for `key` in the current language (English where a translation is missing), with {placeholders} filled in. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const s = DICTS[current][key] ?? en[key];
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Re-render when the language changes. Returns the current language. */
export function useLang(): Lang {
  const [l, setL] = useState(current);
  useEffect(() => { listeners.add(setL); return () => { listeners.delete(setL); }; }, []);
  return l;
}

/** For tests: every key each language is missing. */
export const missing = (l: Lang): Key[] => (Object.keys(en) as Key[]).filter((k) => !(k in DICTS[l]));
