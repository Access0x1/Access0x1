/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin output tracing to this app dir so Next doesn't infer a monorepo root.
  outputFileTracingRoot: import.meta.dirname,
};

export default nextConfig;
