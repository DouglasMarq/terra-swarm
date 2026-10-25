export type VoiceStatus = "idle" | "recording" | "transcribing";

export interface VoiceModelInfo {
  id: string;
  displayName: string;
  sizeLabel: string;
  description: string;
  isDownloaded: boolean;
  isActive: boolean;
}

export interface VoiceDownloadProgress {
  model_id: string;
  downloaded: number;
  total: number;
  percent: number;
}
