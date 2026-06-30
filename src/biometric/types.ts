export interface DevicePunch {
  deviceUserId: string;
  timestamp: string;
  direction?: "in" | "out";
}

export interface BiometricDeviceEntry {
  id: string;
  name: string;
  type: "zk-tcp" | "adms-http" | "usb-hid";
  host?: string;
  port?: number;
  pollIntervalMs?: number;
  enabled: boolean;
}

export interface PunchQueueItem {
  id: string;
  deviceUserId: string;
  timestamp: string;
  direction?: string;
  deviceId: string;
  synced: boolean;
  syncedAt?: string;
  createdAt: string;
}
