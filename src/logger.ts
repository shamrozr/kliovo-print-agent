import log from "electron-log";
import path from "path";
import { app } from "electron";

const LOG_PATH = path.join(app.getPath("userData"), "logs", "agent.log");

log.transports.file.resolvePathFn = () => LOG_PATH;
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB rolling
log.transports.file.archiveLog = (oldPath: string) => {
  const parts = oldPath.split(".");
  parts.splice(-1, 0, "old");
  return parts.join(".");
};

export const logger = log;
