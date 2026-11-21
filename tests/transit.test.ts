import assert from "node:assert/strict"
import { test } from "node:test"
import {
  failureMessage,
  formatApiTime,
  formatHttpTime,
  imageKind,
  minuteLabel,
  parseSchedule,
  snapshotUrl,
  summarizeLine,
} from "../src/transit.ts"

const names = { CHW: "柴灣", KET: "堅尼地城", LOW: "羅湖", LMC: "落馬洲" }

test("minute labels follow the API minute count", () => {
  assert.equal(minuteLabel("0"), "即將到站")
  assert.equal(minuteLabel("1"), "1 分鐘")
  assert.equal(minuteLabel("12"), "12 分鐘")
  assert.equal(minuteLabel(""), "時間待定")
})

test("API clock text is labelled as Hong Kong time without shifting the clock", () => {
  assert.equal(formatApiTime("2026-11-21 10:28:29"), "11月21日 10:28（香港時間）")
})

test("photo timestamps are converted from GMT to Hong Kong time", () => {
  assert.equal(formatHttpTime("Sat, 21 Nov 2026 02:26:00 GMT"), "11月21日 10:26（香港時間）")
})

test("a through station lists each direction by destination", () => {
  const summary = summarizeLine(
    [train("CHW", "1", "3")],
    [train("KET", "1", "4")],
    "CEN",
    names,
  )
  assert.equal(summary.empty, null)
  assert.equal(summary.footnote, null)
  assert.deepEqual(summary.groups.map((group) => group.title), ["往柴灣", "往堅尼地城"])
  assert.equal(summary.groups[0]?.rows[0]?.showDest, false)
})

test("Sheung Shui can show both Lo Wu and Lok Ma Chau in one direction", () => {
  const summary = summarizeLine(
    [train("LOW", "1", "1"), train("LMC", "2", "1"), train("LOW", "3", "1"), train("LMC", "4", "1")],
    [train("ADM", "1", "2")],
    "SHS",
    { ...names, ADM: "金鐘" },
  )
  assert.equal(summary.groups[0]?.title, "即將開出")
  assert.deepEqual(
    summary.groups[0]?.rows.map((row) => row.dest),
    ["羅湖", "落馬洲", "羅湖", "落馬洲"],
  )
  assert.equal(summary.groups[0]?.rows[0]?.showDest, true)
})

test("a terminus explains the empty direction and Racecourse explains an empty day", () => {
  const terminus = summarizeLine([train("CHW", "1", "1")], [], "KET", names)
  assert.equal(terminus.footnote, "另一方向目前沒有即將到站的列車。")
  const racecourse = summarizeLine([], [], "RAC", names)
  assert.match(racecourse.empty ?? "", /馬場站/)
})

test("schedule responses keep official empty results distinct from outages", () => {
  const live = parseSchedule(200, {
    status: 1,
    message: "successful",
    isdelay: "N",
    curr_time: "2026-11-21 10:28:29",
    data: { "ISL-CEN": { UP: [train("CHW", "1", "3")], DOWN: [] } },
    url: "javascript:alert(1)",
  })
  assert.equal(live.ok, true)
  if (live.ok) {
    assert.equal(live.up.length, 1)
    assert.equal(live.down.length, 0)
    assert.equal(live.notice, null)
    assert.equal(live.infoUrl, null)
  }
  assert.deepEqual(parseSchedule(200, { status: 0, message: "The contents are empty!" }), {
    ok: false,
    reason: "empty",
  })
  assert.equal(failureMessage("empty"), "暫時沒有這條綫的班次資料。")
  assert.deepEqual(parseSchedule(429, {}), { ok: false, reason: "rate" })
  assert.deepEqual(parseSchedule(500, {}), { ok: false, reason: "down" })
})

test("snapshot addresses follow the camera key, including the swapped pair", () => {
  assert.equal(snapshotUrl("AID09104"), "https://tdcctv.data.one.gov.hk/AID09104.JPG")
  assert.equal(snapshotUrl("AID09206"), "https://tdcctv.data.one.gov.hk/AID09206.JPG")
})

test("image bytes distinguish a real JPEG from the service GIF", () => {
  assert.equal(imageKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg")
  assert.equal(imageKind(new TextEncoder().encode("GIF89a-placeholder")), "placeholder")
  assert.equal(imageKind(Uint8Array.from([1, 2, 3, 4])), "unknown")
})

function train(dest: string, seq: string, plat = "1") {
  return { seq, dest, plat, time: "2026-11-21 10:28:00", ttnt: "1", valid: "Y" }
}
