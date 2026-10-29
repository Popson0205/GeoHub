[33m4d07203[m[33m ([m[1;31morigin/main[m[33m, [m[1;31morigin/HEAD[m[33m)[m Collect: zoom the map to the captured location
 frontend/scripts/gps-test.ts        | 13 [32m+++++++++++++[m
 frontend/src/components/MapView.tsx |  2 [32m+[m[31m-[m
 frontend/src/lib/gps.ts             | 12 [32m++++++++++++[m
 frontend/src/pages/CollectPage.tsx  | 14 [32m++++++++++[m[31m----[m
 4 files changed, 36 insertions(+), 5 deletions(-)
[33mb6b57b3[m Data import: skip questions that have no column in the CSV instead of holding rows back
 backend/app/services/forms.py              | 14 [32m+++++++++[m[31m-----[m
 backend/app/worker/tasks.py                | 10 [32m+++++++++[m[31m-[m
 backend/tests/test_form_fields.py          | 12 [32m++++++++++++[m
 frontend/scripts/csv-import-test.ts        | 14 [32m+++++++++++++[m[31m-[m
 frontend/scripts/ui/csv-import.test.tsx    |  2 [32m+[m[31m-[m
 frontend/src/components/CsvImportPanel.tsx |  2 [32m+[m[31m-[m
 frontend/src/lib/csvImport.ts              |  7 [32m+++++[m[31m--[m
 frontend/src/mock/mockApi.ts               |  3 [32m++[m[31m-[m
 8 files changed, 52 insertions(+), 12 deletions(-)
[33m2f88c48[m Form builder: CSV import and auto-generated IDs (short code, UUID); dashboard widget gear settings
 FORM_FIELDS.md                         |  5 [32m++++[m
 backend/app/services/forms.py          | 24 [32m++++++++++++[m[31m-----[m
 backend/tests/test_form_fields.py      | 20 [32m++++++++++++++[m
 frontend/scripts/form-import-test.ts   |  9 [32m++++++[m[31m-[m
 frontend/scripts/forms-test.ts         | 22 [32m++++++++++++++[m[31m--[m
 frontend/src/components/CalcEditor.tsx | 12 [32m++++++++[m[31m-[m
 frontend/src/lib/fieldSpec.ts          |  4 [32m++[m[31m-[m
 frontend/src/lib/formImport.ts         | 48 [32m++++++++++++++++++++++[m[31m------------[m
 frontend/src/lib/forms.ts              |  5 [32m++[m[31m--[m
 frontend/src/lib/logic.ts              | 26 [32m+++++++++++++++++[m[31m-[m
 frontend/src/lib/types.ts              |  5 [32m+++[m[31m-[m
 11 files changed, 149 insertions(+), 31 deletions(-)
[33m2f0a49d[m Form builder CSV import; dashboard widget gear settings
 frontend/package.json                              |   3 [32m+[m[31m-[m
 frontend/scripts/form-import-test.ts               |  39 [32m+++[m
 frontend/scripts/ui/dashboard-gear.test.tsx        |  68 [32m+++++[m
 frontend/src/components/dashboard/Elements.tsx     |   2 [32m+[m[31m-[m
 frontend/src/components/dashboard/WidgetCard.tsx   |  27 [32m+[m[31m-[m
 .../src/components/dashboard/WidgetSettings.tsx    | 308 [32m++++++++++++[m[31m---------[m
 frontend/src/lib/formImport.ts                     | 213 [32m++++++++++++++[m
 frontend/src/pages/BuilderPage.tsx                 |  34 [32m++[m[31m-[m
 frontend/src/pages/DashboardPage.tsx               |  39 [32m+[m[31m--[m
 frontend/src/styles/dashboard-app.css              |  56 [32m++++[m
 10 files changed, 628 insertions(+), 161 deletions(-)
