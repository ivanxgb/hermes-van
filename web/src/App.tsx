import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { SetupPage } from "./pages/SetupPage";
import { LoginPage } from "./pages/LoginPage";
import { ChatPage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { CapabilitiesPage } from "./pages/CapabilitiesPage";
import { bootstrapAuth, useAuth } from "./lib/auth-store";

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
    <Switch>
      <Route path="/setup" component={SetupPage} />
      <Route path="/login" component={LoginPage} />
      <Route path="/chat" component={ChatPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/capabilities" component={CapabilitiesPage} />
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
  );
}
