import type { NextConfig } from "next";

// No Server Actions are used; request-size limits for route handlers arrive with rate limiting in M2.
const nextConfig: NextConfig = {
  poweredByHeader: false
};

export default nextConfig;
