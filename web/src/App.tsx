import { lazy, Suspense, useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { LoginPage } from "./pages/LoginPage";
import { ChatPage } from "./pages/ChatPage";
import { bootstrapAuth, useAuth } from "./lib/auth-store";

// Secondary routes are lazy-loaded — they're not on the critical path for
// returning users (who land on /chat). This trims the initial JS bundle
// and lets each panel ship its own chunk.
const SetupPage = lazy(() =>
  import("./pages/SetupPage").then((m) => ({ default: m.SetupPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })),
);
const MetricsPage = lazy(() =>
  import("./pages/MetricsPage").then((m) => ({ default: m.MetricsPage })),
);
const CapabilitiesPage = lazy(() =>
  import("./pages/CapabilitiesPage").then((m) => ({ default: m.CapabilitiesPage })),
);
const JobsPage = lazy(() =>
  import("./pages/JobsPage").then((m) => ({ default: m.JobsPage })),
);

function RouteFallback() {
  return (
    <main className="container">
      <div className="tag">— hermes-van</div>
      <div className="probe-loading">…loading</div>
    </main>
  );
}

export function App() {
  const auth = useAuth();
  const [location, setLocation] = useLocation();

  useEffect(() => {
    bootstrapAuth();
  }, []);

  // Route guard
  useEffect(() => {
    if (auth.status === "loading") return;
    const isPublic = location === "/setup" || location === "/login";
    if (auth.status === "anonymous" && !isPublic) {
      setLocation("/login");
    } else if (auth.status === "authenticated" && location === "/login") {
      setLocation("/chat");
    } else if (auth.status === "authenticated" && location === "/") {
      setLocation("/chat");
    } else if (auth.status === "anonymous" && location === "/") {
      setLocation("/login");
    }
  }, [auth.status, location, setLocation]);

  if (auth.status === "loading") {
    return (
      <main className="container">
        <div className="tag">— hermes-van</div>
        <div className="probe-loading">…initializing</div>
      </main>
    );
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      <Switch>
        <Route path="/setup" component={SetupPage} />
        <Route path="/login" component={LoginPage} />
        <Route path="/chat" component={ChatPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/metrics" component={MetricsPage} />
        <Route path="/capabilities" component={CapabilitiesPage} />
        <Route path="/jobs" component={JobsPage} />
        <Route>
          <main className="container">
            <div className="tag">— 404</div>
            <h1>Not found.</h1>
            <p className="lead">
              Unknown route: <code>{location}</code>
            </p>
          </main>
        </Route>
      </Switch>
    </Suspense>
  );
}
