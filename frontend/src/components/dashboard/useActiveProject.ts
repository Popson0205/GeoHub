import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useAsync } from "../../lib/hooks";

/**
 * The project the Dashboard app is showing. Collectors cannot see dashboards, so projects where that is all you are are left out.
 * The choice lives in the address (?project=…), so a link opens the same project and a refresh keeps it.
 */
export function useActiveProject() {
  const [params, setParams] = useSearchParams();
  const projects = useAsync((api) => api.listProjects(), []);
  const viewable = useMemo(() => (projects.data ?? []).filter((p) => p.role !== "collector"), [projects.data]);
  const active = viewable.find((p) => p.id === params.get("project")) ?? viewable[0];
  const choose = (id: string) => setParams({ project: id }, { replace: true });
  return { projects, viewable, active, choose };
}
