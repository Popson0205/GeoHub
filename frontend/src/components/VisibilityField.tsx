import { useAuth } from "../lib/auth";
import type { DatasetVisibility, License } from "../lib/types";

/** Who can see a Data hub dataset. "Your organization" comes with Organization plans; a Private licence is never public. */
export default function VisibilityField({ id, value, onChange, license, membersLabel }: {
  id: string; value: DatasetVisibility; onChange: (v: DatasetVisibility) => void; license: License; membersLabel: string;
}) {
  const { user } = useAuth();
  const orgPlan = !!user?.org && user.org.plan !== "individual";
  const effective: DatasetVisibility = license === "Private" && value === "public" ? "private" : !orgPlan && value === "organization" ? "private" : value;
  return (
    <div className="field">
      <label htmlFor={id}>Who can see it</label>
      <select id={id} value={effective} onChange={(e) => onChange(e.target.value as DatasetVisibility)} aria-describedby={`${id}-hint`}>
        <option value="public" disabled={license === "Private"}>Everyone{license === "Private" ? " (not with a Private licence)" : ""}</option>
        {orgPlan && <option value="organization">Everyone in {user!.org!.name}</option>}
        <option value="private">{membersLabel}</option>
      </select>
      <span id={`${id}-hint`} className="field-hint">
        {effective === "public" ? "Listed on the public Data hub; anyone can view and download it."
          : effective === "organization" ? "Only people signed in to your organization see it on the Data hub."
          : "Only people in it can see it."}
      </span>
    </div>
  );
}

export const VISIBILITY_WORDS: Record<DatasetVisibility, string> = { public: "public", organization: "your organization", private: "members only" };
