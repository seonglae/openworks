import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProvider, ConvexReactClient, useQuery } from "convex/react";
import { ConvexProviderWithClerk } from "convex/react-clerk";
import { ClerkProvider, SignedIn, SignedOut, SignIn, SignOutButton, useAuth } from "@clerk/clerk-react";
import "./index.css";
import { api } from "../../convex/_generated/api";
import App from "./App.tsx";
import AutomationRunner from "./AutomationRunner.tsx";
import { bootGradientStrength } from "./SettingsModal.tsx";
import { bootReflective } from "./reflective.ts";

// Restore the device-local backdrop blob intensity before first paint.
bootGradientStrength();
// Restore the reflective camera backdrop if it was left on (no-op if denied).
bootReflective();

// iOS Safari (and an installed PWA) paint the top/bottom system bars from the
// `theme-color` meta. It was a static light cream, so in dark mode the app
// showed a white top+bottom while the page itself was dark. Keep theme-color in
// lockstep with the active theme: dark when the `.dark` class is on, light
// otherwise, near-black while the sign-in screen is up. A MutationObserver makes
// every theme toggle (and the post-login transition) update it automatically,
// so it is correct on the main view, not just the login screen.
const THEME_DARK = "#0a0a0a";
const THEME_LIGHT = "#ffffff";
const THEME_LOGIN = "#0a0a0a";
let loginActive = false;
function applyThemeColor() {
  const dark = document.documentElement.classList.contains("dark");
  const c = loginActive ? THEME_LOGIN : dark ? THEME_DARK : THEME_LIGHT;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", c);
}
// Apply the saved theme before first paint so the system bars are correct from
// the very first frame (no light flash), then track every later change.
try {
  if (localStorage.getItem("theme") === "dark") document.documentElement.classList.add("dark");
} catch {
  /* localStorage blocked (private mode) — default light is fine */
}
applyThemeColor();
new MutationObserver(applyThemeColor).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["class"],
});

const url = import.meta.env.VITE_CONVEX_URL;
if (!url) throw new Error("VITE_CONVEX_URL not set — check .env.local");

// Local-dev bypass: a production Clerk key is domain-locked to its own site
// and cannot run on localhost, so for local development we authenticate to the
// (owner-locked) backend with the worker's service key instead of Clerk. This
// key lives only in the gitignored .env.local. As defense in depth it is also
// hard-gated to a DEV build served from localhost, so even if the value ever
// leaked into a production / PWA / native bundle it can never activate the
// bypass: import.meta.env.DEV is statically false in prod builds, so this
// branch (and the env read) is dead-code-eliminated.
const isLocalDevHost =
  typeof location !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const devServiceKey =
  import.meta.env.DEV && isLocalDevHost
    ? (import.meta.env.VITE_OPENWORKS_SERVICE_KEY as string | undefined)
    : undefined;

// A Convex client that injects the service key into every query/mutation/action
// so the owner gate (requireOwner) lets local-dev calls through. Every gated
// function already accepts an optional `serviceKey`, so this is universally safe.
class ServiceKeyConvexClient extends ConvexReactClient {
  #sk: string;
  constructor(deployment: string, sk: string) {
    super(deployment);
    this.#sk = sk;
  }
  #inject(args: unknown) {
    return { ...((args as Record<string, unknown>) ?? {}), serviceKey: this.#sk };
  }
  // @ts-expect-error widen the generic arg to inject serviceKey
  watchQuery(query, ...rest) {
    return super.watchQuery(query, this.#inject(rest[0]), rest[1]);
  }
  // @ts-expect-error widen the generic arg to inject serviceKey
  mutation(mutation, ...rest) {
    return super.mutation(mutation, this.#inject(rest[0]), rest[1]);
  }
  // Unlike watchQuery and mutation, action takes no options argument — the
  // third parameter was being forwarded into an overload that has no slot for
  // it.
  // @ts-expect-error widen the generic arg to inject serviceKey
  action(action, ...rest) {
    return super.action(action, this.#inject(rest[0]));
  }
}

const convex = devServiceKey ? new ServiceKeyConvexClient(url, devServiceKey) : new ConvexReactClient(url);

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
// Clerk only gates the UI when a key is present AND we are not on the local
// service-key bypass.
const authEnabled = Boolean(clerkPubKey) && !devServiceKey;

const isAutomation = new URL(window.location.href).searchParams.has("automation");

// Strip a stale automation result hash left in the address bar by a prior
// run so normal navigation URLs stay clean.
if (!isAutomation && window.location.hash.startsWith("#result=")) {
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}

const inner = isAutomation ? (
  <AutomationRunner />
) : (
  <>
    <App />
    <AutomationRunner />
  </>
);

// Openworks-branded dark sign-in. The Clerk widget is restyled to sit on a warm
// near-black gradient under the Openworks wordmark + pipeline tagline.
const clerkAppearance = {
  variables: {
    colorPrimary: "#e4e4e4",
    // Dark text ON the (light/cream) primary button. Without this Clerk auto-
    // picks white, which is invisible on the cream button (iOS Safari bug).
    colorTextOnPrimaryBackground: "#141414",
    colorBackground: "#141414",
    colorText: "#f4f4f4",
    colorTextSecondary: "#767676",
    colorInputBackground: "#1f1f1f",
    colorInputText: "#f4f4f4",
    colorNeutral: "#f4f4f4",
    borderRadius: "0.7rem",
    fontFamily: "inherit",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "shadow-2xl",
    card: "bg-[#141414]/95 border border-[#333333] backdrop-blur",
    headerTitle: "text-[#f4f4f4]",
    headerSubtitle: "text-[#767676]",
    socialButtonsBlockButton: "border-[#333333] text-[#f4f4f4] hover:bg-[#1f1f1f] transition-colors",
    socialButtonsBlockButtonText: "text-[#f4f4f4]",
    dividerLine: "bg-[#333333]",
    dividerText: "text-[#767676]",
    formFieldLabel: "text-[#767676]",
    formFieldInput: "bg-[#1f1f1f] border-[#333333] text-[#f4f4f4]",
    formButtonPrimary: "bg-[#e4e4e4] !text-[#141414] hover:bg-[#f4f4f4] transition-colors",
    footer: "hidden",
    identityPreviewText: "text-[#f4f4f4]",
    formFieldInputShowPasswordButton: "text-[#767676]",
    logoBox: "hidden",
  },
};

const SignInScreen = () => {
  useEffect(() => {
    loginActive = true;
    const html = document.documentElement;
    const prevBg = html.style.backgroundColor;
    html.style.backgroundColor = THEME_LOGIN;
    document.body.style.backgroundColor = THEME_LOGIN;
    applyThemeColor();
    return () => {
      loginActive = false;
      html.style.backgroundColor = prevBg;
      document.body.style.backgroundColor = "";
      applyThemeColor();
    };
  }, []);
  return (
    <div
      className="fixed inset-0 overflow-y-auto flex flex-col items-center justify-center gap-9 p-4 bg-[#0a0a0a] bg-[radial-gradient(ellipse_at_top,#141414_0%,#0a0a0a_60%,#050505_100%)]"
      style={{ minHeight: "100dvh" }}
    >
      <div className="text-center select-none">
        <h1 className="text-5xl font-semibold tracking-tight text-[#f4f4f4]">Openworks</h1>
        <p className="mt-3 text-[13px] tracking-wide text-[#8a8a8a]">
          read &rarr; summarize &rarr; internalize &rarr; organize &rarr; express
        </p>
      </div>
      <SignIn routing="hash" appearance={clerkAppearance} />
    </div>
  );
};

// Signed-in but maybe-not-the-owner gate. The backend is locked to a single
// owner (by email or Clerk subject); a signed-in non-owner would otherwise
// crash the app on the first `forbidden`. Instead we check identity via the
// ungated `whoami` and, when it is not the owner, show what their token carries
// (so the owner can be configured) rather than mounting the app.
const OwnerGate = ({ children }: { children: React.ReactNode }) => {
  const me = useQuery(api.settings.whoami, {});
  if (me === undefined) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#0a0a0a] text-[#8a8a8a] text-sm">
        Checking access&hellip;
      </div>
    );
  }
  if (me.authenticated && me.isOwner) return <>{children}</>;
  return (
    <div className="fixed inset-0 overflow-y-auto flex flex-col items-center justify-center gap-6 p-6 bg-[#0a0a0a] bg-[radial-gradient(ellipse_at_top,#141414_0%,#0a0a0a_60%,#050505_100%)] text-center">
      <h1 className="text-3xl font-semibold tracking-tight text-[#f4f4f4]">Openworks</h1>
      <div className="max-w-md rounded-xl border border-[#333333] bg-[#141414]/95 px-6 py-5 text-left text-[13px] text-[#b8b8b8]">
        <p className="mb-3 text-[#f4f4f4]">Signed in, but this account does not have access.</p>
        <p className="font-mono break-all text-[12px] leading-relaxed text-[#8a8a8a]">
          email: {me.authenticated ? (me.email ?? "(none in token)") : "(not signed in)"}
          <br />
          subject: {me.authenticated ? me.subject : "-"}
          <br />
          name: {me.authenticated ? (me.name ?? "-") : "-"}
        </p>
      </div>
      <SignOutButton>
        <button className="rounded-full bg-[#e4e4e4] px-5 py-1.5 text-[13px] font-medium text-[#141414] hover:bg-[#f4f4f4] transition-colors">
          Sign out
        </button>
      </SignOutButton>
    </div>
  );
};

// When Clerk is configured (production), the app is owner-only: an
// unauthenticated visitor gets the branded sign-in wall and never reaches
// Convex. On the local service-key bypass (or before auth is wired), fall back
// to a bare ConvexProvider so the app runs.
const app = authEnabled ? (
  <ClerkProvider publishableKey={clerkPubKey!} appearance={clerkAppearance}>
    <SignedOut>
      <SignInScreen />
    </SignedOut>
    <SignedIn>
      <ConvexProviderWithClerk client={convex} useAuth={useAuth}>
        <OwnerGate>{inner}</OwnerGate>
      </ConvexProviderWithClerk>
    </SignedIn>
  </ClerkProvider>
) : (
  <ConvexProvider client={convex}>{inner}</ConvexProvider>
);

createRoot(document.getElementById("root")!).render(isAutomation ? app : <StrictMode>{app}</StrictMode>);

// Register service worker for PWA (skip in dev/automation)
if ("serviceWorker" in navigator && !isAutomation && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
