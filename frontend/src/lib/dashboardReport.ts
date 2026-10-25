// A report is a printable snapshot of a project's dashboards: every element worked out from the records as they are now.
// It reuses the same calculation as the dashboards themselves (widgetData), so a report can never disagree with the screen.
import {
  buildSources, defaultTitle, inSidebar, noFilters, pageFormIds, placeAll, timeLabel, timeRange, widgetData, withTimeRange,
  type WidgetData,
} from "./dashboard";
import type { Dashboard, Feature, Form, Widget, WidgetType } from "./types";

export interface ReportElement { id: string; title: string; type: WidgetType; data: WidgetData }
export interface ReportPage { id: string; title: string; formName?: string; records: number; elements: ReportElement[] }
export interface ReportDashboard { id: string; name: string; description?: string; range: string; pages: ReportPage[] }
export interface Report {
  projectName: string; generatedAt: string;
  dashboards: ReportDashboard[];
  totals: { dashboards: number; pages: number; elements: number; records: number };
}
export interface ReportOptions {
  /** Table, list and details elements print whole records. Leave them out for a short report of numbers and charts. */
  includeRecords: boolean;
}
const RECORD_TYPES: WidgetType[] = ["table", "list", "details"];

export function buildReport(args: { projectName: string; dashboards: Dashboard[]; forms: Form[]; features: Feature[]; now?: Date; options?: Partial<ReportOptions> }): Report {
  const now = args.now ?? new Date(), includeRecords = args.options?.includeRecords ?? true;
  const dashboards = args.dashboards.map((d): ReportDashboard => {
    // The dashboard's own date range applies; a report has no viewer filters.
    const filters = withTimeRange(noFilters(), timeRange(d.config.time_filter, now));
    const pages = d.config.pages.map((p): ReportPage => {
      const sources = buildSources(pageFormIds(p), args.forms, args.features, filters);
      const sourceOf = (w: Widget) => sources.get(w.form_id ?? p.form_id ?? "");
      // Reading order of the grid, then the side column.
      const ordered = [...placeAll(p.widgets).map((x) => x.w), ...p.widgets.filter(inSidebar)];
      const elements = ordered.filter((w) => includeRecords || !RECORD_TYPES.includes(w.type)).map((w): ReportElement => {
        const src = sourceOf(w);
        return { id: w.id, title: defaultTitle(w, src?.defs ?? []), type: w.type, data: widgetData(w, src, !!(w.form_id ?? p.form_id)) };
      });
      return { id: p.id, title: p.title || "Untitled page", formName: args.forms.find((f) => f.id === p.form_id)?.name, records: [...sources.values()].reduce((n, s) => n + s.rows.length, 0), elements };
    });
    return { id: d.id, name: d.name, description: d.config.description, range: timeLabel(d.config.time_filter), pages };
  });
  const pages = dashboards.reduce((n, d) => n + d.pages.length, 0);
  const elements = dashboards.reduce((n, d) => n + d.pages.reduce((m, p) => m + p.elements.length, 0), 0);
  // Records are counted once per form, however many pages draw on it.
  const formsUsed = new Set(args.dashboards.flatMap((d) => d.config.pages.flatMap(pageFormIds)));
  const records = args.features.filter((f) => formsUsed.has(f.form_id) && !f.deleted).length;
  return { projectName: args.projectName, generatedAt: now.toISOString(), dashboards, totals: { dashboards: dashboards.length, pages, elements, records } };
}
