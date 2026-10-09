/** Headers for the owner's console. It holds the admin token for the length of a tab, so it may only run its own scripts and can never be framed. */
export const consoleHeaders = [
  { key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Cache-Control', value: 'no-cache' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async rewrites() {
    // /console is one static page (public/console/index.html) that draws every screen itself.
    return [{ source: '/console', destination: '/console/index.html' }];
  },
  async headers() {
    return [
      {
        // The one-line tag loads this file on every page of the customer's site. Short cache so a fix reaches people within minutes.
        source: '/agent.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=300, stale-while-revalidate=86400' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
      { source: '/console', headers: consoleHeaders },
      { source: '/console/:path*', headers: consoleHeaders },
    ];
  },
};

export default nextConfig;
