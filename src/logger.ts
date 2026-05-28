import log from "electron-log";
import path from "path";
import { app } from "electron";

const LOG_PATH = path.join(app.getPath("userData"), "logs", "agent.log");

log.transports.file.resolvePathFn = () => LOG_PATH;
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB rolling
log.transports.file.archiveLog = (oldLogFile) => {
  const oldPath = typeof oldLogFile === "string" ? oldLogFile : oldLogFile.toString();
  const parts = oldPath.split(".");
  parts.splice(-1, 0, "old");
  // archiveLog return value is ignored in v5; rename side-effect is handled by electron-log
};

export const logger = log;
