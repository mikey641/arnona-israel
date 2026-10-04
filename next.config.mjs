/** @type {import('next').NextConfig} */
export default {
  outputFileTracingIncludes: { "/**": ["./data/**/*.json"] },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, OPTIONS" },
        ],
      },
    ];
  },
};
