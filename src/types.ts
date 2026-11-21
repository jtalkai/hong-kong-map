export interface LineRecord {
  id: string
  name_tc: string
  name_en: string
  color: string
  offset: number
  paths: string[][]
  tracks?: [number, number][][]
}

export interface StationRecord {
  code: string
  name_tc: string
  name_en: string
  lat: number
  lng: number
  lines: string[]
}

export interface NetworkData {
  lines: LineRecord[]
  stations: StationRecord[]
}

export interface CameraRecord {
  key: string
  description: string
  region: string
  district: string
  lat: number
  lng: number
}
