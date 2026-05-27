import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // Silence the workspace-root warning caused by a stray ~/package-lock.json.
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Native modules can't be bundled by Turbopack — load them at runtime from
  // node_modules instead. Without this, instrumentation fails with
  // "Cannot find module 'better-sqlite3-<hash>'" on dev startup.
  serverExternalPackages: [
    'better-sqlite3',
    '@grpc/grpc-js',
    '@grpc/proto-loader',
  ],
};

export default nextConfig;
