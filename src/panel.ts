import type { LineSummary } from "./transit.ts"
import { CAMERA_ERROR, CAMERA_PLACEHOLDER, CAMERA_UNKNOWN } from "./transit.ts"
import type { CameraRecord, StationRecord } from "./types.ts"

export type LinePanelState =
  | { kind: "loading" }
  | { kind: "failure"; message: string }
  | {
      kind: "ready"
      summary: LineSummary
      updated: string
      delay: boolean
      notice: string | null
      infoUrl: string | null
    }

export interface StationPanel {
  setLine(lineId: string, state: LinePanelState): void
  setBusy(busy: boolean): void
}

export interface CameraPanel {
  setView(view: CameraView): void
  setBusy(busy: boolean): void
}

export type CameraView =
  | { kind: "loading" }
  | { kind: "photo"; objectUrl: string; taken: string | null }
  | { kind: "placeholder"; taken: string | null }
  | { kind: "unknown" }
  | { kind: "error" }

interface Handlers {
  onClose: () => void
  onRefresh: () => void
}

export function showIdle(root: HTMLElement): void {
  root.classList.add("is-idle")
  root.replaceChildren()
  const body = document.createElement("div")
  body.className = "panel-body"
  body.append(
    heading("從地圖選一個點"),
    paragraph(
      "點選彩色車站，查看即將到站的列車。點選橙色快拍點，查看該路段的最新照片。暫時沒有班次或照片時，這裡會寫明原因。",
    ),
  )
  root.append(body, footer(null))
}

export function showMissing(root: HTMLElement): void {
  root.classList.add("is-idle")
  root.replaceChildren()
  const body = document.createElement("div")
  body.className = "panel-body"
  body.append(heading("找不到這個地點"), paragraph("連結中的車站或快拍點不在目前的資料裡。請在地圖上另選一點。"))
  root.append(body, footer(null))
}

export function showStation(
  root: HTMLElement,
  station: StationRecord,
  lines: Array<{ id: string; name: string; color: string }>,
  handlers: Handlers,
): StationPanel {
  root.classList.remove("is-idle")
  root.replaceChildren()
  const head = document.createElement("div")
  head.className = "panel-head"
  const titles = document.createElement("div")
  titles.append(heading(station.name_tc), english(station.name_en))
  head.append(titles, closeButton(handlers.onClose))

  const body = document.createElement("div")
  body.className = "panel-body"
  if (lines.length > 1) body.append(paragraph("這是轉車站，下面按路綫分開列出。"))
  for (const line of lines) {
    const section = document.createElement("section")
    section.className = "line-block"
    section.id = `line-${line.id}`
    section.style.setProperty("--line-color", line.color)
    fillLine(section, line.name, { kind: "loading" })
    body.append(section)
  }

  const refresh = actionButton("更新班次", handlers.onRefresh)
  root.append(head, body, footer(refresh))
  return {
    setLine(lineId, state) {
      const section = root.querySelector<HTMLElement>(`#line-${CSS.escape(lineId)}`)
      const line = lines.find((item) => item.id === lineId)
      if (!section || !line) return
      fillLine(section, line.name, state)
    },
    setBusy(busy) {
      refresh.disabled = busy
    },
  }
}

export function showCamera(root: HTMLElement, camera: CameraRecord, handlers: Handlers): CameraPanel {
  root.classList.remove("is-idle")
  root.replaceChildren()
  const head = document.createElement("div")
  head.className = "panel-head"
  const titles = document.createElement("div")
  titles.append(heading(camera.description), english(`${camera.region} · ${camera.district}`))
  head.append(titles, closeButton(handlers.onClose))

  const frame = document.createElement("div")
  frame.className = "photo-frame"
  const body = document.createElement("div")
  body.className = "panel-body"
  body.append(frame)
  const refresh = actionButton("更新照片", handlers.onRefresh)
  root.append(head, body, footer(refresh))

  const panel: CameraPanel = {
    setView(view) {
      frame.replaceChildren()
      if (view.kind === "loading") {
        frame.append(paragraph("正在向運輸署讀取最新照片…"))
        return
      }
      if (view.kind === "photo") {
        const image = document.createElement("img")
        image.className = "photo"
        image.alt = camera.description
        image.src = view.objectUrl
        image.width = 320
        image.height = 240
        frame.append(image)
        if (view.taken) frame.append(meta(`照片時間 ${view.taken}`))
        return
      }
      if (view.kind === "placeholder") {
        frame.append(note(CAMERA_PLACEHOLDER))
        if (view.taken) frame.append(meta(`查詢時間參考 ${view.taken}`))
        return
      }
      frame.append(note(view.kind === "unknown" ? CAMERA_UNKNOWN : CAMERA_ERROR, true))
    },
    setBusy(busy) {
      refresh.disabled = busy
    },
  }
  panel.setView({ kind: "loading" })
  return panel
}

function fillLine(section: HTMLElement, name: string, state: LinePanelState): void {
  section.replaceChildren(lineTitle(name))
  if (state.kind === "loading") {
    section.append(paragraph("正在向港鐵查詢到站班次…"))
    return
  }
  if (state.kind === "failure") {
    section.append(note(state.message, true))
    return
  }
  if (state.updated) section.append(meta(`班次時間 ${state.updated}`))
  if (state.delay) section.append(note("港鐵表示列車有延誤，到站時間可能改變。", true))
  if (state.notice) section.append(note(`港鐵提示：${state.notice}`))
  if (state.infoUrl) {
    const link = document.createElement("a")
    link.href = state.infoUrl
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    link.textContent = "查看港鐵的特別車務安排"
    link.className = "info-link"
    section.append(link)
  }
  if (state.summary.empty) {
    section.append(note(state.summary.empty))
    return
  }
  for (const group of state.summary.groups) {
    const block = document.createElement("div")
    block.className = "train-group"
    const title = document.createElement("h4")
    title.textContent = group.title
    block.append(title)
    for (const row of group.rows) {
      const item = document.createElement("div")
      item.className = "train"
      const minute = document.createElement("span")
      minute.className = "minute"
      minute.textContent = row.minute
      const middle = document.createElement("span")
      const parts = [row.showDest ? `往${row.dest}` : "", row.platform ? `月台 ${row.platform}` : ""].filter(Boolean)
      middle.textContent = parts.join(" · ")
      const clock = document.createElement("span")
      clock.className = "clock"
      clock.textContent = row.uncertain ? `${row.clock} 未確定` : row.clock
      item.append(minute, middle, clock)
      block.append(item)
    }
    section.append(block)
  }
  if (state.summary.footnote) section.append(meta(state.summary.footnote))
}

function heading(text: string): HTMLHeadingElement {
  const node = document.createElement("h2")
  node.textContent = text
  return node
}

function english(text: string): HTMLParagraphElement {
  const node = document.createElement("p")
  node.className = "en"
  node.textContent = text
  return node
}

function paragraph(text: string): HTMLParagraphElement {
  const node = document.createElement("p")
  node.className = "lead"
  node.textContent = text
  return node
}

function meta(text: string): HTMLParagraphElement {
  const node = document.createElement("p")
  node.className = "meta"
  node.textContent = text
  return node
}

function note(text: string, warn = false): HTMLParagraphElement {
  const node = document.createElement("p")
  node.className = warn ? "note warn" : "note"
  node.textContent = text
  return node
}

function lineTitle(text: string): HTMLHeadingElement {
  const node = document.createElement("h3")
  node.textContent = text
  return node
}

function closeButton(onClose: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "close"
  button.setAttribute("aria-label", "關閉資料")
  button.textContent = "關閉"
  button.addEventListener("click", onClose)
  return button
}

function actionButton(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "action"
  button.textContent = label
  button.addEventListener("click", onClick)
  return button
}

function footer(action: HTMLButtonElement | null): HTMLElement {
  const foot = document.createElement("div")
  foot.className = "panel-foot"
  if (action) {
    const row = document.createElement("div")
    row.className = "actions"
    row.append(action)
    foot.append(row)
  }
  const details = document.createElement("details")
  details.className = "sources"
  const summary = document.createElement("summary")
  summary.textContent = "資料出處"
  const copy = document.createElement("p")
  copy.append(
    "底圖由 ",
    anchor("https://openfreemap.org/", "OpenFreeMap"),
    " 提供，地圖資料來自 OpenMapTiles 與 OpenStreetMap。到站班次來自 ",
    anchor("https://data.gov.hk/tc-data/dataset/mtr-data2-nexttrain-data", "港鐵實時列車服務資訊"),
    "，交通快拍來自 ",
    anchor("https://data.gov.hk/tc-data/dataset/hk-td-tis_2-traffic-snapshot-images", "運輸署交通情況快拍圖像"),
    "。兩者經 DATA.GOV.HK 發放，知識產權分別屬香港鐵路有限公司及香港特別行政區政府。",
  )
  details.append(summary, copy)
  foot.append(details)
  return foot
}

function anchor(href: string, text: string): HTMLAnchorElement {
  const link = document.createElement("a")
  link.href = href
  link.target = "_blank"
  link.rel = "noopener noreferrer"
  link.textContent = text
  return link
}
