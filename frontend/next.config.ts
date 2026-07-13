import type { NextConfig } from "next";

// When building for the Tauri desktop shell (`npm run build:desktop`), Next
// is exported as static HTML/JS so Tauri can load it from disk with no Node
// server required - the FastAPI backend (spawned as a Tauri sidecar) is the
// only server that needs to run at that point.
const isDesktopBuild = process.env.BUILD_TARGET === "desktop";

const nextConfig: NextConfig = {
  // Allow dev assets/HMR to be served to the browser when the app is opened
  // through a forwarded/proxied origin (e.g. GitHub Codespaces'
  // *.app.github.dev tunnel). Without the accessing origin listed here, Next
  // blocks its own HMR client chunk cross-origin, which makes the page reload
  // in an endless loop.
  allowedDevOrigins: ["127.0.0.1", "localhost", "*.app.github.dev"],
  ...(isDesktopBuild
    ? {
        output: "export",
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
