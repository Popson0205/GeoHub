import { useCallback } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ErrorState, Loading } from "../components/ui";
import { useAsync } from "../lib/hooks";
import CampaignTab from "./portal/CampaignTab";
import ContributorsTab from "./portal/ContributorsTab";
import PublishTab from "./portal/PublishTab";
import ReviewTab from "./portal/ReviewTab";
import TeamTab from "./portal/TeamTab";

type TabId = "contributors" | "review" | "team" | "campaign" | "publish";
const TABS: { id: TabId; label: string; owner?: boolean }[] = [
  { id: "contributors", label: "Contributors" }, { id: "review", label: "Review" }, { id: "team", label: "Team" },
  { id: "campaign", label: "Campaign", owner: true }, { id: "publish", label: "Publish", owner: true },
];

/** The organiser's portal for a shared map: who is contributing, review, the team, the campaign, and publishing to the Data hub. */
export default function MapPortalPage() {
  const { mapId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload, setData } = useAsync(async (api) => {
    const [map, features] = await Promise.all([api.getMap(mapId), api.listMapFeatures(mapId)]);
    return { map, features };
  }, [mapId]);

  /** Refresh without flashing the loading state. */
  const refresh = useCallback(async () => {
    const api = await (await import("../lib/api")).loadApi();
    const [map, features] = await Promise.all([api.getMap(mapId), api.listMapFeatures(mapId)]);
    setData({ map, features });
  }, [mapId, setData]);

  if (loading && !data) return <Loading label="Opening the portal…" />;
  if (error != null || !data) return <div className="container"><ErrorState error={error} onRetry={reload} /></div>;
  const { map, features } = data;
  const tabs = TABS.filter((t) => !t.owner || map.role === "owner");
  const asked = params.get("tab") as TabId | null;
  const tab: TabId = tabs.some((t) => t.id === asked) ? (asked as TabId) : "contributors";
  const setTab = (id: TabId) => setParams(id === "contributors" ? {} : { tab: id }, { replace: true });

  return (
    <div className="container" style={{ width: "100%" }}>
      <div className="page-head" style={{ marginBottom: 12 }}>
        <div>
          <div className="field-hint"><Link to="/maps">All maps</Link> / <Link to={`/maps/${map.id}`}>Open the map editor</Link></div>
          <h1 style={{ margin: "4px 0 0" }}>{map.name}</h1>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 6 }}>
            <span className="badge badge-ok">You are {map.role === "owner" ? "the owner" : `a ${map.role}`}</span>
            {map.is_campaign && map.campaign_status && <span className={`badge ${map.campaign_status === "open" ? "badge-ok" : map.campaign_status === "ended" ? "badge-bad" : "badge-warn"}`}>Campaign {map.campaign_status === "open" ? "open" : map.campaign_status === "ended" ? "ended" : "not started"}</span>}
            <span className="field-hint">Owner: {map.owner_name} · {map.member_count} {map.member_count === 1 ? "person" : "people"} · {map.feature_count} features</span>
          </div>
        </div>
        <span className="grow" />
        <Link className="btn btn-primary" to={`/maps/${map.id}`}>Open map editor</Link>
      </div>

      <div role="tablist" aria-label="Portal sections" className="tabs">
        {tabs.map((t) => <button key={t.id} type="button" role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`panel-${t.id}`} className="tab" onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} style={{ marginTop: 20 }}>
        {tab === "contributors" && <ContributorsTab map={map} />}
        {tab === "review" && <ReviewTab map={map} features={features} authorFilter={params.get("author") ?? ""} onAuthor={(id) => setParams(id ? { tab: "review", author: id } : { tab: "review" }, { replace: true })} onChanged={refresh} />}
        {tab === "team" && <TeamTab map={map} onChanged={refresh} />}
        {tab === "campaign" && map.role === "owner" && <CampaignTab map={map} onChanged={refresh} />}
        {tab === "publish" && map.role === "owner" && <PublishTab map={map} features={features} />}
      </div>
    </div>
  );
}
