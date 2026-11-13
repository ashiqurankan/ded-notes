import type { NextConfig } from 'next';

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // This app lives in its own folder; don't let a stray lockfile higher up confuse tracing.
  outputFileTracingRoot: process.cwd(),
  env: {
    // Used to version the service worker cache. Vercel provides the commit SHA.
    NEXT_PUBLIC_BUILD_ID: (process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || `${Date.now()}`).slice(0, 12),
  },
  async rewrites() {
    // Serve Firebase Auth's helper pages from this domain. Together with
    // NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<your Vercel domain> this makes Google sign-in
    // work in Safari, iOS home-screen apps and other browsers that block third-party storage.
    if (!projectId) return [];
    return [
      { source: '/__/auth/:path*', destination: `https://${projectId}.firebaseapp.com/__/auth/:path*` },
      { source: '/__/firebase/:path*', destination: `https://${projectId}.firebaseapp.com/__/firebase/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      {
        source: '/manifest.json',
        headers: [
          { key: 'Content-Type', value: 'application/manifest+json' },
          { key: 'Cache-Control', value: 'public, max-age=3600' },
        ],
      },
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
