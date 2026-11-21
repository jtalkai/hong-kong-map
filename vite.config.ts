import type { Connect, Plugin } from "vite"
import { defineConfig } from "vite"

const basemapUpstream = "https://tiles.openfreemap.org"
const basemapPrefix = "/basemap"

// Chrome follows the HTTPS DNS record and tries HTTP/3 first. QUIC to this host
// does not complete here, so the style request stalls for about 10 seconds and
// the page shows the slow-basemap banner. Node fetches over HTTP/2 immediately.
function basemapProxy(): Plugin {
  const serve: Connect.NextHandleFunction = async (req, res, next) => {
    const url = req.url ?? ""
    if (!url.startsWith(`${basemapPrefix}/`)) {
      next()
      return
    }
    try {
      const upstream = await fetch(basemapUpstream + url.slice(basemapPrefix.length))
      const type = upstream.headers.get("content-type") ?? "application/octet-stream"
      res.statusCode = upstream.status
      res.setHeader("content-type", type)
      if (type.includes("json")) {
        res.setHeader("cache-control", "no-cache")
        const forwarded = req.headers["x-forwarded-proto"]
        const proto = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "http"
        const host = req.headers.host ?? "127.0.0.1:4731"
        const text = (await upstream.text()).replaceAll(basemapUpstream, `${proto}://${host}${basemapPrefix}`)
        res.end(text)
        return
      }
      res.setHeader("cache-control", "public, max-age=300")
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch {
      res.statusCode = 502
      res.end("basemap upstream failed")
    }
  }
  return {
    name: "basemap-proxy",
    configureServer(server) {
      server.middlewares.use(serve)
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve)
    },
  }
}

export default defineConfig({
  plugins: [basemapProxy()],
  server: {
    host: "0.0.0.0",
    port: 4731,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 4731,
    strictPort: true,
  },
})
