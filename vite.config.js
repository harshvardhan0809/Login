import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

const root = dirname(fileURLToPath(import.meta.url));
const page = name => resolve(root, name);

/**
 * Anything named VITE_* is inlined into the bundle and served to every visitor.
 * Fail the build rather than ship a secret that was given the prefix by
 * mistake — a leaked service_role key bypasses every RLS policy.
 */
const SECRET_PATTERN = /^VITE_.*(SERVICE_ROLE|SECRET|PRIVATE|_PASSWORD|ADMIN_EMAILS)/i;

function assertNoPublishedSecrets(mode) {
  const leaked = Object.keys(loadEnv(mode, process.cwd(), "VITE_")).filter(key =>
    SECRET_PATTERN.test(key)
  );

  if (leaked.length) {
    throw new Error(
      `Refusing to build: ${leaked.join(", ")} would be published to the browser. ` +
        "Remove the VITE_ prefix — see .env.example."
    );
  }
}

export default defineConfig(({ mode }) => {
  assertNoPublishedSecrets(mode);

  return {
    // Multi-page app: every HTML file is its own entry point, so Vite hashes and
    // bundles the modules each page imports instead of shipping one giant bundle.
    build: {
      outDir: "dist",
      sourcemap: true,
      rollupOptions: {
        input: {
          login: page("index.html"),
          signup: page("signup.html"),
          dashboard: page("dashboard.html"),
          profile: page("profile.html"),
          admin: page("admin.html"),
          resetPassword: page("reset-password.html"),
          exam: page("exam.html"),
          results: page("results.html"),
        },
        output: {
          // Without this, Rollup names the shared vendor chunk after whichever
          // module it happened to hoist first (e.g. "snow-*.js").
          manualChunks(id) {
            // KaTeX is bigger than everything else put together and is only
            // needed where formulas are written or answered. Left in `vendor`
            // it would be downloaded by the login page too.
            if (id.includes("node_modules/katex")) return "katex";
            if (id.includes("node_modules")) return "vendor";
          },
        },
      },
    },
    server: {
      port: 5173,
      open: true,
    },
  };
});
