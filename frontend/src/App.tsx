import { Link, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { lazy, Suspense, type ReactNode } from "react";
import Shell from "./components/Shell";
import ErrorBoundary from "./components/ErrorBoundary";
import { Loading } from "./components/ui";
import { RequireAuth, useAuth } from "./lib/auth";
import { isCollectorApp } from "./lib/pwa";

// Each page loads when it is first opened, so the first visit downloads only what that page needs.
// The service worker still caches every file, so the installed app works offline as before.
const LoginPage = lazy(() => import("./pages/LoginPage"));
const SetPasswordPage = lazy(() => import("./pages/PasswordPages").then((m) => ({ default: m.SetPasswordPage })));
const ForgotPasswordPage = lazy(() => import("./pages/PasswordPages").then((m) => ({ default: m.ForgotPasswordPage })));
const ChangePasswordPage = lazy(() => import("./pages/PasswordPages").then((m) => ({ default: m.ChangePasswordPage })));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const EditorPage = lazy(() => import("./pages/EditorPage"));
const FormsPage = lazy(() => import("./pages/FormsPage"));
const BuilderPage = lazy(() => import("./pages/BuilderPage"));
const HubPage = lazy(() => import("./pages/HubPage"));
const DatasetPage = lazy(() => import("./pages/DatasetPage"));
const CollectPage = lazy(() => import("./pages/CollectPage"));
const LandingPage = lazy(() => import("./pages/LandingPage"));
const HomePage = lazy(() => import("./pages/HomePage"));
const MapsPage = lazy(() => import("./pages/MapsPage"));
const MapEditorPage = lazy(() => import("./pages/MapEditorPage"));
const MapPortalPage = lazy(() => import("./pages/MapPortalPage"));
const JoinMapPage = lazy(() => import("./pages/JoinMapPage"));
const SharePage = lazy(() => import("./pages/SharePage"));
const PublicFormPage = lazy(() => import("./pages/PublicFormPage"));
const DataPage = lazy(() => import("./pages/DataPage"));
const ActivityPage = lazy(() => import("./pages/ActivityPage"));
const OrgSettingsPage = lazy(() => import("./pages/OrgSettingsPage"));
const DashboardApp = lazy(() => import("./pages/DashboardApp"));
const DashboardReports = lazy(() => import("./pages/DashboardReports"));
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const PublicDashboardPage = lazy(() => import("./pages/PublicDashboardPage"));
const CollectHomePage = lazy(() => import("./pages/CollectHomePage"));

/** What shows while a page's code arrives (usually a fraction of a second, longer on a weak signal). */
export function PageLoading() {
  return <div className="container" style={{ width: "100%" }}><Loading label="Opening…" /></div>;
}
/** Pages load on demand; a page that fails to draw shows a recovery screen instead of a blank one. */
function Page({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}><Suspense fallback={<PageLoading />}>{children}</Suspense></ErrorBoundary>;
}

/** Signed in: your work. Signed out: what Geohub is. The introduction stays at /about for everyone. */
function Home() {
  const { user, ready } = useAuth();
  if (!ready) return <PageLoading />;
  return user ? <HomePage /> : <LandingPage />;
}

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

/** Old /collect/:project/dashboards links keep working: dashboards are their own app now, with the project in the address. */
function LegacyDashboards() {
  const { projectId = "", dashboardId } = useParams();
  const { search } = useLocation();
  return <Navigate to={dashboardId ? `/dashboards/${dashboardId}${search}` : `/dashboards?project=${projectId}`} replace />;
}

/** The installed app: sign in, pick a project, collect. Everything else is on the website for administrators. */
function CollectorRoutes() {
  return (
    <Page><Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
      <Route path="/f/:token" element={<PublicFormPage />} />
      <Route path="/collect" element={<RequireAuth><CollectHomePage /></RequireAuth>} />
      <Route path="/collect/:projectId" element={<RequireAuth><CollectPage /></RequireAuth>} />
      <Route path="*" element={<Navigate to="/collect" replace />} />
    </Routes></Page>
  );
}

export default function App() {
  if (isCollectorApp()) return <CollectorRoutes />;
  return (
    <Page><Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/change-password" element={<RequireAuth><ChangePasswordPage /></RequireAuth>} />
      {/* A form shared by link: public links work without signing in */}
      <Route path="/f/:token" element={<PublicFormPage />} />
      {/* A dashboard shared by link: read-only, no sign-in */}
      <Route path="/d/:token" element={<PublicDashboardPage />} />
      <Route path="/collect/:projectId" element={<RequireAuth><CollectPage /></RequireAuth>} />
      {/* A dashboard opens in its own full-screen workspace, like the form builder */}
      <Route path="/dashboards/:dashboardId" element={<RequireAuth><DashboardPage /></RequireAuth>} />
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="/about" element={<LandingPage />} />
        {/* Web mapping: standalone maps, no forms or projects */}
        <Route path="/maps" element={<RequireAuth><MapsPage /></RequireAuth>} />
        <Route path="/maps/:mapId" element={<RequireAuth><MapEditorPage /></RequireAuth>} />
        <Route path="/maps/:mapId/portal" element={<RequireAuth><MapPortalPage /></RequireAuth>} />
        <Route path="/join/:code" element={<RequireAuth><JoinMapPage /></RequireAuth>} />
        <Route path="/hub" element={<HubPage />} />
        <Route path="/hub/:slug" element={<DatasetPage />} />
        {/* Data collection: projects, form builder, review */}
        <Route path="/collect" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
        <Route path="/collect/:projectId/review" element={<RequireAuth><EditorPage /></RequireAuth>} />
        <Route path="/collect/:projectId/forms" element={<RequireAuth><FormsPage /></RequireAuth>} />
        <Route path="/collect/:projectId/forms/:formId/share" element={<RequireAuth><SharePage /></RequireAuth>} />
        <Route path="/collect/:projectId/data" element={<RequireAuth><DataPage /></RequireAuth>} />
        <Route path="/collect/:projectId/activity" element={<RequireAuth><ActivityPage /></RequireAuth>} />
        <Route path="/settings/organization" element={<RequireAuth><OrgSettingsPage /></RequireAuth>} />
        {/* Dashboards: their own app. A gallery, a reports page, and the builder above */}
        <Route path="/dashboards" element={<RequireAuth><DashboardApp /></RequireAuth>} />
        <Route path="/dashboards/reports" element={<RequireAuth><DashboardReports /></RequireAuth>} />
        <Route path="/collect/:projectId/dashboards" element={<LegacyDashboards />} />
        <Route path="/collect/:projectId/dashboards/:dashboardId" element={<LegacyDashboards />} />
        <Route path="/collect/:projectId/forms/:formId" element={<RequireAuth><BuilderPage /></RequireAuth>} />
        <Route path="/projects" element={<LegacyProject to="collect" />} />
        <Route path="/projects/:projectId/editor" element={<LegacyProject to="review" />} />
        <Route path="/projects/:projectId/forms" element={<LegacyProject to="forms" />} />
        <Route path="/projects/:projectId/forms/:formId" element={<LegacyProject to="form" />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes></Page>
  );
}
