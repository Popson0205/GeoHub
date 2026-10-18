import { Link, Navigate, Route, Routes } from "react-router-dom";
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

function NotFound() {
  return (
    <div className="container">
      <h1>Page not found</h1>
      <p><Link to="/hub">Go to the data hub</Link></p>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/collect/:projectId" element={<RequireAuth><CollectPage /></RequireAuth>} />
      <Route element={<Shell />}>
        <Route index element={<Navigate to="/projects" replace />} />
        <Route path="/hub" element={<HubPage />} />
        <Route path="/hub/:slug" element={<DatasetPage />} />
        <Route path="/projects" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
        <Route path="/projects/:projectId/editor" element={<RequireAuth><EditorPage /></RequireAuth>} />
        <Route path="/projects/:projectId/forms" element={<RequireAuth><FormsPage /></RequireAuth>} />
        <Route path="/projects/:projectId/forms/:formId" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
