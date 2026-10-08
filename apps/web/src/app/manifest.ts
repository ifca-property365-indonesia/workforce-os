import type { MetadataRoute } from "next";

/** Installable app (PWA). The name stays the brand in both languages. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Workforce OS",
    short_name: "Workforce OS",
    id: "/",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#f9fafb",
    theme_color: "#3a4bc4",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
