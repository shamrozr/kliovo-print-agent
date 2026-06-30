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
    disconnect(): Promise<boolean>;
  }

  export default ZKLib;
}
