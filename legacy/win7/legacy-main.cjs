"use strict";

// Set storage before importing any agent modules: many compute paths on import.
const { app } = require("electron");
const path = require("path");
app.setName("Kliovo Print Agent Win7");
app.setPath("userData", path.join(app.getPath("appData"), "Kliovo Print Agent Win7"));

require("./legacy-runtime.cjs").installLegacyFetch();
require("./dist/main.js");
