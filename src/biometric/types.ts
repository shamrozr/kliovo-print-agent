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
  /**
   * The terminal's real hardware serial number (from zk.getSerialNumber()),
   * cached after the first successful connect. This — NOT `id` (an agent-local
   * config key) — is what identifies the device to Dine: it's what gets
   * registered via POST /api/attendance/devices/register and what scopes
   * DeviceUserMapping PINs so two K70s on the same branch can safely reuse
   * the same PIN number for two different people.
   */
  serial?: string;
}

export interface PunchQueueItem {
  id: string;
  deviceUserId: string;
  timestamp: string;
  direction?: string;
  /** The terminal's serial number (see BiometricDeviceEntry.serial). */
  deviceId: string;
  synced: boolean;
  syncedAt?: string;
  createdAt: string;
}
