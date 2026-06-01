import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";
// import tailwindcss from '@tailwindcss/vite';
import path from "path";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // Required frontend variables
  const requiredFrontend = [
    "PUBLIC_STELLAR_NETWORK",
    "PUBLIC_STELLAR_NETWORK_PASSPHRASE",
    "PUBLIC_STELLAR_RPC_URL",
    "PUBLIC_STELLAR_HORIZON_URL",
    "PUBLIC_PROMPT_HASH_CONTRACT_ID",
    "PUBLIC_STELLAR_NATIVE_ASSET_CONTRACT_ID",
    "PUBLIC_STELLAR_SIMULATION_ACCOUNT",
    "PUBLIC_UNLOCK_PUBLIC_KEY",
  ];

  const PLACEHOLDER_PATTERNS = [
    /^replace-with/i,
    /^BASE64_/i,
    /^[CG]X{10,}/,
    /^your-/i,
    /^<.*>$/,
  ];
  const isPlaceholder = (val: string) => PLACEHOLDER_PATTERNS.some((re) => re.test(val));

  const errors: string[] = [];
  for (const key of requiredFrontend) {
    const val = env[key] || process.env[key];
    if (!val) {
      errors.push(`${key} is not set.`);
    } else if (isPlaceholder(val)) {
      errors.push(`${key} has a placeholder value.`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `\n❌ [Vite Build/Startup Env Validation Failed]:\n  - ${errors.join("\n  - ")}\n\nPlease check your .env file and ensure correct configurations are loaded.\n`
    );
  }

  return {
    plugins: [
      react(),
      // tailwindcss(),
      nodePolyfills({
        include: ["buffer"],
        globals: {
          Buffer: true,
        },
      }),
      wasm(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["favicon.ico", "apple-touch-icon.png", "icons/*.png"],
        manifest: {
          name: "Prompt Hash",
          short_name: "PromptHash",
          description: "Discover, purchase, and manage AI prompts on Stellar",
          theme_color: "#0f172a",
          background_color: "#0f172a",
          display: "standalone",
          start_url: "/",
          icons: [
            {
              src: "/icons/pwa-192x192.png",
              sizes: "192x192",
              type: "image/png",
            },
            {
              src: "/icons/pwa-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "any maskable",
            },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,ico,png,svg,wasm}"],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: /^https:\/\/.*\.stellar\.org\/.*/i,
              handler: "NetworkFirst",
              options: { cacheName: "stellar-api", networkTimeoutSeconds: 10 },
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
        "libsodium-wrappers": path.resolve(
          __dirname,
          "./node_modules/libsodium-wrappers/dist/modules/libsodium-wrappers.js",
        ),
      },
    },
    build: {
      target: "esnext",
      rollupOptions: {
        output: {
          manualChunks(id: string) {
            if (
              id.includes("node_modules/@stellar") ||
              id.includes("node_modules/@creit.tech/stellar-wallets-kit")
            ) {
              return "vendor-stellar";
            }
            if (
              id.includes("node_modules/chart.js") ||
              id.includes("node_modules/react-chartjs-2")
            ) {
              return "vendor-charts";
            }
            if (id.includes("node_modules/framer-motion")) {
              return "vendor-motion";
            }
            if (id.includes("node_modules/libsodium")) {
              return "vendor-crypto";
            }
          },
        },
      },
    },
    define: {
      global: "window",
    },
    envPrefix: "PUBLIC_",
    test: {
      environment: "jsdom",
      setupFiles: "./src/test/setup.ts",
    },
    server: {
      proxy: {
        "/friendbot": {
          // target: "http://localhost:8000/friendbot",
          target: "https://friendbot.stellar.org",
          changeOrigin: true,
        },
      },
    },
  };
});
