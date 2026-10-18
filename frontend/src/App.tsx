import { Link, Navigate, Route, Routes, useParams } from "react-router-dom";
import Shell from "./components/Shell";
import { RequireAuth } from "./lib/auth";
import LoginPage from "./pages/LoginPage";
import ProjectsPage from "./pages/ProjectsPage";
import EditorPage from "./pages/EditorPage";
import FormsPage from "./pages/FormsPage";
import BuilderPage from "./pages/BuilderPage";
import HubPage from "./pages/HubPage";
import DatasetPage from "./pages/DatasetPage";
import CollectPage from "./pages/CollectPage";
import LandingPage from "./pages/LandingPage";
import MapsPage from "./pages/MapsPage";
import MapEditorPage from "./pages/MapEditorPage";

function NotFound() {
  return (
    <div className="container">
      <h1>Page not found</h1>
      <p><Link to="/">Back to Geohub home</Link></p>
    </div>
  );
}

/** Old /projects/... links keep working: projects now live under Data collection. */
function LegacyProject({ to }: { to: "collect" | "forms" | "review" | "form" }) {
  const { projectId = "", formId = "" } = useParams();
  const path = to === "collect" ? "/collect" : to === "forms" ? `/collect/${projectId}/forms` : to === "form" ? `/collect/${projectId}/forms/${formId}` : `/collect/${projectId}/review`;
  return <Navigate to={path} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/collect/:projectId" element={<RequireAuth><CollectPage /></RequireAuth>} />
      <Route element={<Shell />}>
        <Route index element={<LandingPage />} />
        {/* Web mapping: standalone maps, no forms or projects */}
        <Route path="/maps" element={<RequireAuth><MapsPage /></RequireAuth>} />
        <Route path="/maps/:mapId" element={<RequireAuth><MapEditorPage /></RequireAuth>} />
        <Route path="/hub" element={<HubPage />} />
        <Route path="/hub/:slug" element={<DatasetPage />} />
        {/* Data collection: projects, form builder, review */}
        <Route path="/collect" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
        <Route path="/collect/:projectId/review" element={<RequireAuth><EditorPage /></RequireAuth>} />
        <Route path="/collect/:projectId/forms" element={<RequireAuth><FormsPage /></RequireAuth>} />
        <Route path="/collect/:projectId/forms/:formId" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        <Route path="/projects" element={<LegacyProject to="collect" />} />
        <Route path="/projects/:projectId/editor" element={<LegacyProject to="review" />} />
        <Route path="/projects/:projectId/forms" element={<LegacyProject to="forms" />} />
        <Route path="/projects/:projectId/forms/:formId" element={<LegacyProject to="form" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
