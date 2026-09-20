import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo contains multiple package.json/lockfiles (engine/, splato/).
  // Pin the Turbopack workspace root to this project so builds never resolve
  // to an ancestor directory.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
