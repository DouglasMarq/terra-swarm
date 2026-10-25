export type VoiceStatus = "idle" | "recording" | "transcribing";

export interface VoiceModelInfo {
  id: string;
  display_name: string;
  size_label: string;
  description: string;
  downloaded: boolean;
  active: boolean;
}

export interface VoiceDownloadProgress {
  model_id: string;
  downloaded: number;
  total: number;
  percent: number;
}
