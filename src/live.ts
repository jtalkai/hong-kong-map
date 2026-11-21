import { imageKind, parseSchedule, snapshotUrl, type ScheduleResult } from "./transit.ts"

export type SnapshotResult =
  | { kind: "jpeg"; bytes: Uint8Array; taken: string | null }
  | { kind: "placeholder"; taken: string | null }
  | { kind: "unknown" }
  | { kind: "error" }

const freshForMs = 10_000
const cache = new Map<string, { at: number; value: ScheduleResult }>()

export async function fetchSchedule(line: string, station: string, force = false): Promise<ScheduleResult> {
  const key = `${line}-${station}`
  const cached = cache.get(key)
  if (!force && cached && Date.now() - cached.at < freshForMs) return cached.value

  const url = `https://rt.data.gov.hk/v1/transport/mtr/getSchedule.php?line=${encodeURIComponent(line)}&sta=${encodeURIComponent(station)}&lang=TC`
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    const text = await response.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text) as unknown
      } catch {
        body = null
      }
    }
    const value = parseSchedule(response.status, body)
    if (value.ok || value.reason !== "down") cache.set(key, { at: Date.now(), value })
    return value
  } catch {
    return { ok: false, reason: "down" }
  } finally {
    window.clearTimeout(timer)
  }
}

export async function loadSnapshot(key: string): Promise<SnapshotResult> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(snapshotUrl(key), { cache: "no-store", signal: controller.signal })
    if (!response.ok) return { kind: "error" }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength === 0 || bytes.byteLength > 2_000_000) return { kind: "error" }
    const taken = response.headers.get("last-modified")
    const kind = imageKind(bytes)
    if (kind === "jpeg") return { kind: "jpeg", bytes, taken }
    if (kind === "placeholder") return { kind: "placeholder", taken }
    return { kind: "unknown" }
  } catch {
    return { kind: "error" }
  } finally {
    window.clearTimeout(timer)
  }
}
