import { AttributionControl, Map as MlMap, setWorkerUrl } from "maplibre-gl"
import type { FilterSpecification, GeoJSONSource, MapMouseEvent } from "maplibre-gl"
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url"
import "maplibre-gl/dist/maplibre-gl.css"

// Vite cannot follow MapLibre's dynamic sibling worker URL, so point at the real file.
setWorkerUrl(maplibreWorkerUrl)
import cameras from "./data/cameras.json" with { type: "json" }
import network from "./data/network.json" with { type: "json" }
import { fetchSchedule, loadSnapshot } from "./live.ts"
import { showCamera, showIdle, showMissing, showStation } from "./panel.ts"
import type { CameraPanel, StationPanel } from "./panel.ts"
import { failureMessage, formatApiTime, formatHttpTime, summarizeLine } from "./transit.ts"
import type { ScheduleResult } from "./transit.ts"
import type { CameraRecord, NetworkData, StationRecord } from "./types.ts"
import "./style.css"

const mapData = network as NetworkData
const cameraData = cameras as CameraRecord[]
const stationByCode = new Map(mapData.stations.map((station) => [station.code, station]))
const cameraByKey = new Map(cameraData.map((camera) => [camera.key, camera]))
const lineById = new Map(mapData.lines.map((line) => [line.id, line]))
const names = Object.fromEntries(mapData.stations.map((station) => [station.code, station.name_tc]))
const hiddenLines = new Set<string>()
const countFormat = new Intl.NumberFormat("zh-HK")

const panelRoot = requiredElement("#panel")
const legendList = requiredElement("#legend-list")
const banner = requiredElement("#map-banner")
const mtrToggle = requiredButton("#toggle-mtr")
const cameraToggle = requiredButton("#toggle-cameras")
const mtrCount = requiredElement("#mtr-count")
const cameraCount = requiredElement("#camera-count")

mtrCount.textContent = countFormat.format(mapData.stations.length)
cameraCount.textContent = countFormat.format(cameraData.length)

let mtrOn = true
let camerasOn = true
let token = 0
let photoUrl: string | null = null
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches

const hongKong = boundsOf(mapData.stations)
const map = new MlMap({
  container: "map",
  style: import.meta.env.DEV ? "/basemap/styles/liberty" : "https://tiles.openfreemap.org/styles/liberty",
  center: [114.15, 22.35],
  zoom: 10,
  attributionControl: false,
  dragRotate: false,
  pitchWithRotate: false,
  localIdeographFontFamily: '"Noto Sans TC", "PingFang HK", "Microsoft JhengHei", "WenQuanYi Micro Hei", sans-serif',
})

map.addControl(
  new AttributionControl({
    compact: true,
    customAttribution:
      '班次及快拍來自 <a href="https://data.gov.hk/" target="_blank" rel="noopener noreferrer">DATA.GOV.HK</a>',
  }),
  "bottom-left",
)

map.on("load", () => {
  banner.hidden = true
  addLayers()
  showHongKong(false)
  bindMapEvents()
  applyHash(true)
})

window.setTimeout(() => {
  if (!map.loaded()) {
    banner.hidden = false
    banner.textContent = "底圖載入時間較長。請檢查網絡後再重新整理。"
  }
}, 10_000)

buildLegend()
bindChrome()
showIdle(panelRoot)

function addLayers(): void {
  map.addSource("mtr-lines", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: mapData.lines.flatMap((line) =>
        line.paths.map((path) => ({
          type: "Feature" as const,
          properties: { lineId: line.id, color: line.color, offset: line.offset },
          geometry: {
            type: "LineString" as const,
            coordinates: path.map((code) => {
              const station = stationByCode.get(code)
              if (!station) throw new Error(`缺少車站座標 ${code}`)
              return [station.lng, station.lat] as [number, number]
            }),
          },
        })),
      ),
    },
  })

  map.addLayer({
    id: "mtr-lines",
    type: "line",
    source: "mtr-lines",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 9, 2.4, 13, 4.5, 16, 7],
      "line-offset": ["coalesce", ["get", "offset"], 0],
      "line-opacity": 0.95,
    },
  })

  map.addSource("cameras", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: cameraData.map((camera) => ({
        type: "Feature" as const,
        properties: {
          key: camera.key,
          description: camera.description,
          region: camera.region,
          district: camera.district,
        },
        geometry: { type: "Point" as const, coordinates: [camera.lng, camera.lat] },
      })),
    },
    cluster: true,
    clusterRadius: 48,
    clusterMaxZoom: 13,
  })

  map.addLayer({
    id: "camera-clusters",
    type: "circle",
    source: "cameras",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": ["step", ["coalesce", ["get", "point_count"], 0], "#e39a45", 20, "#d17a22", 80, "#b86112"],
      "circle-radius": ["step", ["coalesce", ["get", "point_count"], 0], 15, 20, 19, 80, 24],
      "circle-stroke-color": "#fffaf3",
      "circle-stroke-width": 2,
    },
  })

  map.addLayer({
    id: "camera-count",
    type: "symbol",
    source: "cameras",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-font": ["Noto Sans Bold"],
      "text-size": 12,
    },
    paint: { "text-color": "#fffaf3" },
  })

  map.addLayer({
    id: "camera-points",
    type: "circle",
    source: "cameras",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-color": "#e08a2c",
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 4, 14, 6],
      "circle-stroke-color": "#fffaf3",
      "circle-stroke-width": 1.5,
    },
  })

  map.addSource("stations", {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: mapData.stations.map((station) => ({
        type: "Feature" as const,
        properties: {
          code: station.code,
          name_tc: station.name_tc,
          lines: station.lines,
          color: stationColor(station),
        },
        geometry: { type: "Point" as const, coordinates: [station.lng, station.lat] },
      })),
    },
  })

  map.addLayer({
    id: "stations",
    type: "circle",
    source: "stations",
    paint: {
      "circle-color": ["get", "color"],
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 5, 13, 7, 16, 9],
      "circle-stroke-color": "#fffaf3",
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 9, 1.5, 14, 2.5],
    },
  })

  map.addLayer({
    id: "station-labels",
    type: "symbol",
    source: "stations",
    minzoom: 12,
    layout: {
      "text-field": ["get", "name_tc"],
      "text-font": ["Noto Sans Regular"],
      "text-size": 12,
      "text-offset": [0, 0.9],
      "text-anchor": "top",
      "text-optional": true,
    },
    paint: {
      "text-color": "#1c2420",
      "text-halo-color": "#fffaf3",
      "text-halo-width": 1.4,
    },
  })

  map.addSource("highlight", {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  })
  map.addLayer({
    id: "highlight",
    type: "circle",
    source: "highlight",
    paint: {
      "circle-color": "rgba(255, 250, 243, 0.15)",
      "circle-radius": 16,
      "circle-stroke-color": "#173027",
      "circle-stroke-width": 3,
    },
  })
  applyFilters()
}

function bindMapEvents(): void {
  const interactive = ["stations", "station-labels", "camera-clusters", "camera-points"]
  map.on("mousemove", (event) => {
    const hits = map.queryRenderedFeatures(event.point, { layers: interactive })
    map.getCanvas().style.cursor = hits.length > 0 ? "pointer" : ""
  })
  map.on("click", (event) => {
    const station = firstProperty(event, ["stations", "station-labels"], "code")
    if (station) {
      void openStation(station, true, false)
      return
    }
    const cluster = map.queryRenderedFeatures(event.point, { layers: ["camera-clusters"] })[0]
    if (cluster?.geometry.type === "Point") {
      const clusterId = cluster.properties?.cluster_id
      const source = map.getSource("cameras")
      if (source?.type === "geojson" && typeof clusterId === "number") {
        void expandCluster(source as GeoJSONSource, clusterId, cluster.geometry.coordinates)
      }
      return
    }
    const camera = firstProperty(event, ["camera-points"], "key")
    if (camera) void openCamera(camera, true)
  })
}

async function expandCluster(source: GeoJSONSource, clusterId: number, coordinates: number[]): Promise<void> {
  const zoom = await source.getClusterExpansionZoom(clusterId)
  const [lng, lat] = coordinates
  if (lng === undefined || lat === undefined) return
  map.easeTo({ center: [lng, lat], zoom, duration: reduceMotion ? 0 : 500 })
}

function bindChrome(): void {
  mtrToggle.addEventListener("click", () => {
    mtrOn = !mtrOn
    mtrToggle.setAttribute("aria-pressed", String(mtrOn))
    for (const chip of legendList.querySelectorAll<HTMLButtonElement>(".line-chip")) chip.disabled = !mtrOn
    applyFilters()
  })
  cameraToggle.addEventListener("click", () => {
    camerasOn = !camerasOn
    cameraToggle.setAttribute("aria-pressed", String(camerasOn))
    if (!map.getLayer("camera-clusters")) return
    const visibility = camerasOn ? "visible" : "none"
    for (const id of ["camera-clusters", "camera-count", "camera-points"]) {
      map.setLayoutProperty(id, "visibility", visibility)
    }
  })
  document.querySelector<HTMLButtonElement>("#zoom-in")?.addEventListener("click", () => map.zoomIn())
  document.querySelector<HTMLButtonElement>("#zoom-out")?.addEventListener("click", () => map.zoomOut())
  document.querySelector<HTMLButtonElement>("#zoom-home")?.addEventListener("click", () => showHongKong(true))
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel()
  })
  window.addEventListener("hashchange", () => applyHash(true))
}

function buildLegend(): void {
  for (const line of mapData.lines) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "line-chip"
    button.setAttribute("aria-pressed", "true")
    const swatch = document.createElement("span")
    swatch.className = "swatch"
    swatch.style.background = line.color
    const label = document.createElement("span")
    label.textContent = line.name_tc
    button.append(swatch, label)
    button.addEventListener("click", () => {
      if (hiddenLines.has(line.id)) hiddenLines.delete(line.id)
      else hiddenLines.add(line.id)
      button.setAttribute("aria-pressed", String(!hiddenLines.has(line.id)))
      applyFilters()
    })
    legendList.append(button)
  }
}

function applyFilters(): void {
  if (!map.getLayer("mtr-lines")) return
  const visible = mapData.lines.map((line) => line.id).filter((id) => mtrOn && !hiddenLines.has(id))
  const lineFilter = (
    visible.length === 0 ? ["==", ["get", "lineId"], ""] : ["match", ["get", "lineId"], visible, true, false]
  ) as FilterSpecification
  map.setFilter("mtr-lines", lineFilter)
  map.setFilter("stations", stationFilter(visible))
  map.setFilter("station-labels", stationFilter(visible))
}

function stationFilter(visible: string[]): FilterSpecification {
  if (visible.length === 0) return ["==", ["get", "code"], ""]
  return ["any", ...visible.map((id) => ["in", id, ["get", "lines"]])] as FilterSpecification
}

async function openStation(code: string, move: boolean, force: boolean): Promise<void> {
  const station = stationByCode.get(code)
  if (!station) {
    showMissing(panelRoot)
    return
  }
  const my = ++token
  releasePhoto()
  writeHash(`#station=${code}`)
  focusPoint(station.lng, station.lat, move)
  const lines = station.lines.flatMap((id) => {
    const line = lineById.get(id)
    return line ? [{ id, name: line.name_tc, color: line.color }] : []
  })
  const panel: StationPanel = showStation(panelRoot, station, lines, {
    onClose: closePanel,
    onRefresh: () => {
      void openStation(code, false, true)
    },
  })
  panel.setBusy(true)
  await Promise.all(
    lines.map(async (line) => {
      const result = await fetchSchedule(line.id, code, force)
      if (my !== token) return
      panel.setLine(line.id, lineState(result, code))
    }),
  )
  if (my === token) panel.setBusy(false)
}

async function openCamera(key: string, move: boolean): Promise<void> {
  const camera = cameraByKey.get(key)
  if (!camera) {
    showMissing(panelRoot)
    return
  }
  const my = ++token
  writeHash(`#camera=${encodeURIComponent(key)}`)
  focusPoint(camera.lng, camera.lat, move)
  const panel: CameraPanel = showCamera(panelRoot, camera, {
    onClose: closePanel,
    onRefresh: () => {
      void openCamera(key, false)
    },
  })
  releasePhoto()
  panel.setBusy(true)
  const result = await loadSnapshot(key)
  if (my !== token) return
  panel.setBusy(false)
  if (result.kind === "jpeg") {
    const buffer = new ArrayBuffer(result.bytes.byteLength)
    new Uint8Array(buffer).set(result.bytes)
    photoUrl = URL.createObjectURL(new Blob([buffer], { type: "image/jpeg" }))
    panel.setView({ kind: "photo", objectUrl: photoUrl, taken: formatHttpTime(result.taken) })
    return
  }
  if (result.kind === "placeholder") {
    panel.setView({ kind: "placeholder", taken: formatHttpTime(result.taken) })
    return
  }
  panel.setView({ kind: result.kind === "unknown" ? "unknown" : "error" })
}

function lineState(result: ScheduleResult, code: string) {
  if (!result.ok) return { kind: "failure" as const, message: failureMessage(result.reason) }
  return {
    kind: "ready" as const,
    summary: summarizeLine(result.up, result.down, code, names),
    updated: result.updated ? formatApiTime(result.updated) : "",
    delay: result.delay,
    notice: result.notice,
    infoUrl: result.infoUrl,
  }
}

function closePanel(): void {
  token += 1
  releasePhoto()
  clearHighlight()
  writeHash("")
  showIdle(panelRoot)
}

function applyHash(move: boolean): void {
  const raw = location.hash.replace(/^#/, "")
  if (!raw) return
  const [kind, idPart] = raw.split("=")
  const id = idPart ? decodeURIComponent(idPart) : ""
  if (kind === "station" && stationByCode.has(id)) {
    void openStation(id, move, false)
    return
  }
  if (kind === "camera" && cameraByKey.has(id)) {
    void openCamera(id, move)
    return
  }
  showMissing(panelRoot)
}

function focusPoint(lng: number, lat: number, move: boolean): void {
  const source = map.getSource("highlight")
  if (source?.type === "geojson") {
    ;(source as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: [lng, lat] },
        },
      ],
    })
  }
  if (!move) return
  const wide = window.innerWidth >= 801
  map.easeTo({
    center: [lng, lat],
    zoom: Math.max(map.getZoom(), 13),
    padding: wide
      ? { top: 90, left: 250, right: 430, bottom: 40 }
      : { top: 150, left: 20, right: 20, bottom: 260 },
    duration: reduceMotion ? 0 : 650,
  })
}

function clearHighlight(): void {
  const source = map.getSource("highlight")
  if (source?.type === "geojson") {
    ;(source as GeoJSONSource).setData({ type: "FeatureCollection", features: [] })
  }
}

function requiredElement(id: string): HTMLElement {
  const node = document.querySelector(id)
  if (!(node instanceof HTMLElement)) throw new Error("地圖版面未完成")
  return node
}

function requiredButton(id: string): HTMLButtonElement {
  const node = document.querySelector(id)
  if (!(node instanceof HTMLButtonElement)) throw new Error("地圖版面未完成")
  return node
}

function showHongKong(animate: boolean): void {
  const wide = window.innerWidth >= 801
  map.fitBounds(hongKong, {
    padding: wide
      ? { top: 100, left: 250, right: 430, bottom: 36 }
      : { top: 230, left: 16, right: 16, bottom: 230 },
    maxZoom: 11.2,
    duration: animate && !reduceMotion ? 700 : 0,
  })
}

function firstProperty(event: MapMouseEvent, layers: string[], name: string): string | null {
  const feature = map.queryRenderedFeatures(event.point, { layers })[0]
  const value = feature?.properties?.[name]
  return typeof value === "string" && value !== "" ? value : null
}

function stationColor(station: StationRecord): string {
  if (station.lines.length !== 1) return "#243028"
  return lineById.get(station.lines[0] ?? "")?.color ?? "#243028"
}

function boundsOf(stations: StationRecord[]): [[number, number], [number, number]] {
  const lngs = stations.map((station) => station.lng)
  const lats = stations.map((station) => station.lat)
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ]
}

function writeHash(hash: string): void {
  const next = `${location.pathname}${location.search}${hash}`
  const current = `${location.pathname}${location.search}${location.hash}`
  if (next !== current) history.replaceState(null, "", next)
}

function releasePhoto(): void {
  if (!photoUrl) return
  URL.revokeObjectURL(photoUrl)
  photoUrl = null
}
