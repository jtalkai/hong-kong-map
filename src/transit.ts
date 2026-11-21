export interface Train {
  seq: number
  dest: string
  plat: string
  time: string
  ttnt: string
  valid: string
}

export interface TrainRow {
  minute: string
  dest: string
  showDest: boolean
  platform: string
  clock: string
  uncertain: boolean
}

export interface TrainGroup {
  title: string
  rows: TrainRow[]
}

export interface LineSummary {
  groups: TrainGroup[]
  empty: string | null
  footnote: string | null
}

export type ScheduleResult =
  | {
      ok: true
      delay: boolean
      updated: string
      up: Train[]
      down: Train[]
      notice: string | null
      infoUrl: string | null
    }
  | { ok: false; reason: "empty" | "rate" | "down" | "bad" }

export const OTHER_DIRECTION_EMPTY = "另一方向目前沒有即將到站的列車。"
export const CAMERA_PLACEHOLDER = "運輸署暫時未能提供這個快拍點的照片。"
export const CAMERA_ERROR = "暫時取不到這張照片，請稍後再試。"
export const CAMERA_UNKNOWN = "這張照片的格式未能辨認，暫時不能顯示。"

export function minuteLabel(ttnt: string): string {
  if (ttnt.trim() === "") return "時間待定"
  const minutes = Number(ttnt)
  if (!Number.isFinite(minutes)) return "時間待定"
  if (minutes <= 0) return "即將到站"
  if (minutes === 1) return "1 分鐘"
  return `${Math.round(minutes)} 分鐘`
}

export function clockLabel(value: string): string {
  const match = /(?:\d{4}-\d{2}-\d{2} )?(\d{2}:\d{2})/.exec(value)
  return match?.[1] ?? value
}

export function formatApiTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(value)
  if (!match) return value
  return `${Number(match[2])}月${Number(match[3])}日 ${match[4]}:${match[5]}（香港時間）`
}

export function formatHttpTime(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "numeric",
    hourCycle: "h23",
  }).formatToParts(date)
  const pick = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value
  const month = pick("month")
  const day = pick("day")
  const hour = pick("hour")
  const minute = pick("minute")
  if (!month || !day || !hour || !minute) return null
  return `${Number(month)}月${Number(day)}日 ${hour}:${minute}（香港時間）`
}

export function emptyTrainsCopy(stationCode: string): string {
  if (stationCode === "RAC") {
    return "此站目前沒有即將到站的列車。賽馬日以外，馬場站通常沒有班次。"
  }
  return "此站目前沒有即將到站的列車。"
}

export function failureMessage(reason: "empty" | "rate" | "down" | "bad"): string {
  if (reason === "empty") return "暫時沒有這條綫的班次資料。"
  if (reason === "rate") return "查詢過於頻密，請稍候再試。"
  if (reason === "down") return "暫時連不上港鐵班次服務，請稍後再試。"
  return "班次資料的格式未能辨認。"
}

export function snapshotUrl(key: string): string {
  return `https://tdcctv.data.one.gov.hk/${encodeURIComponent(key)}.JPG`
}

export function imageKind(bytes: Uint8Array): "jpeg" | "placeholder" | "unknown" {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  if (bytes.length >= 6) {
    const head = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0, bytes[5] ?? 0)
    if (head === "GIF87a" || head === "GIF89a") return "placeholder"
  }
  return "unknown"
}

export function summarizeLine(
  up: Train[],
  down: Train[],
  stationCode: string,
  names: Readonly<Record<string, string>>,
): LineSummary {
  const groups = [up, down].filter((trains) => trains.length > 0).map((trains) => makeGroup(trains, names))
  if (groups.length === 0) {
    return { groups, empty: emptyTrainsCopy(stationCode), footnote: null }
  }
  return {
    groups,
    empty: null,
    footnote: up.length === 0 || down.length === 0 ? OTHER_DIRECTION_EMPTY : null,
  }
}

export function parseSchedule(status: number, body: unknown): ScheduleResult {
  if (status === 429) return { ok: false, reason: "rate" }
  if (status < 200 || status >= 300) return { ok: false, reason: "down" }
  if (!isRecord(body)) return { ok: false, reason: "bad" }
  if (body.status === 0 || body.status === "0") return { ok: false, reason: "empty" }
  if (body.status !== 1 && body.status !== "1") return { ok: false, reason: "bad" }

  const data = isRecord(body.data) ? Object.values(body.data).find(isRecord) : undefined
  const up = readTrains(data?.UP)
  const down = readTrains(data?.DOWN)
  const message = typeof body.message === "string" ? body.message.trim() : ""
  return {
    ok: true,
    delay: body.isdelay === "Y",
    updated: typeof body.curr_time === "string" ? body.curr_time : "",
    up,
    down,
    notice: message !== "" && message.toLowerCase() !== "successful" ? message : null,
    infoUrl: httpUrl(body.url),
  }
}

function makeGroup(trains: Train[], names: Readonly<Record<string, string>>): TrainGroup {
  const destinations = [...new Set(trains.map((train) => train.dest))]
  const showDest = destinations.length > 1
  const title = destinations.length === 1 ? `往${names[destinations[0] ?? ""] ?? destinations[0]}` : "即將開出"
  return {
    title,
    rows: trains.map((train) => ({
      minute: minuteLabel(train.ttnt),
      dest: names[train.dest] ?? train.dest,
      showDest,
      platform: train.plat.trim(),
      clock: clockLabel(train.time),
      uncertain: train.valid === "N",
    })),
  }
}

function readTrains(value: unknown): Train[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item, index) => {
    if (!isRecord(item) || typeof item.dest !== "string") return []
    const seq = Number(item.seq)
    return [
      {
        seq: Number.isFinite(seq) ? seq : index + 1,
        dest: item.dest,
        plat: typeof item.plat === "string" ? item.plat : "",
        time: typeof item.time === "string" ? item.time : "",
        ttnt: typeof item.ttnt === "string" ? item.ttnt : "",
        valid: typeof item.valid === "string" ? item.valid : "Y",
      },
    ]
  }).sort((a, b) => a.seq - b.seq)
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
