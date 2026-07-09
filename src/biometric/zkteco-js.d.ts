declare module "zkteco-js" {
  interface AttendanceRecord {
    id?: string;
    sn?: number;
    deviceUserId?: string;
    timestamp?: string;
    ip?: string;
  }

  interface AttendanceResult {
    data?: AttendanceRecord[];
  }

  class ZKLib {
    constructor(ip: string, port: number, timeout?: number, inport?: number);
    createSocket(): Promise<boolean>;
    getAttendances(): Promise<AttendanceResult>;
    getSerialNumber(): Promise<string>;
    setTime(t: Date): Promise<unknown>;
    disconnect(): Promise<boolean>;
  }

  export default ZKLib;
}
