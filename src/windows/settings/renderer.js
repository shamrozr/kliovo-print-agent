// Settings window renderer — loaded as external script so CSP 'self' allows it

let cfg = { serverUrl: "", printers: [] };
let systemPrinters = [];   // OS-detected print-queue names (USB etc.)

const SELECT_CSS = "width:100%;padding:9px 11px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#1f2937;font-size:13px;";

function setText(el, val) { el.textContent = String(val ?? ""); }
function setVal(el, val)  { el.value = String(val ?? ""); }

function buildPrinterCard(printer, index) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.index = String(index);

  const connType = printer.connection === "system" ? "system" : "network";
  const printerMode = printer.printerMode === "label" ? "label" : "receipt";

  const header = document.createElement("div");
  header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:6px;";
  const headerName = document.createElement("div");
  headerName.style.cssText = "font-weight:600;color:#1f2937;font-size:13px;flex:1;";
  setText(headerName, printer.name || "Untitled printer");
  const modeBadge = document.createElement("span");
  modeBadge.style.cssText = "font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;"
    + (printerMode === "label"
      ? "background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;"
      : "background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;");
  setText(modeBadge, printerMode);
  header.append(headerName, modeBadge);

  const nameLabel = document.createElement("label");
  setText(nameLabel, "Name");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "e.g. Main Floor";
  setVal(nameInput, printer.name);
  nameInput.dataset.field = "name";
  nameInput.addEventListener("input", function() { setText(headerName, nameInput.value || "Untitled printer"); });

  const connLabel = document.createElement("label");
  setText(connLabel, "Connection");
  const connSelect = document.createElement("select");
  connSelect.style.cssText = SELECT_CSS;
  [["Network (Ethernet / Wi-Fi)", "network"], ["USB (this PC's printer)", "system"]].forEach(function(opt) {
    const o = document.createElement("option");
    o.value = opt[1];
    setText(o, opt[0]);
    if (connType === opt[1]) o.selected = true;
    connSelect.appendChild(o);
  });
  connSelect.addEventListener("change", function() {
    cfg.printers[index].connection = connSelect.value;
    renderPrinters();
  });

  const row = document.createElement("div");
  row.className = "row";

  const ipWrap = document.createElement("div");
  ipWrap.style.flex = "2";
  const ipLabel = document.createElement("label");
  setText(ipLabel, "IP Address");
  const ipInput = document.createElement("input");
  ipInput.type = "text";
  ipInput.placeholder = "192.168.1.50";
  setVal(ipInput, printer.host);
  ipInput.dataset.field = "host";
  ipWrap.append(ipLabel, ipInput);

  const portWrap = document.createElement("div");
  portWrap.style.flex = "1";
  const portLabel = document.createElement("label");
  setText(portLabel, "Port");
  const portInput = document.createElement("input");
  portInput.type = "number";
  setVal(portInput, printer.port || 9100);
  portInput.dataset.field = "port";
  portWrap.append(portLabel, portInput);

  row.append(ipWrap, portWrap);

  const sysWrap = document.createElement("div");
  const sysLabel = document.createElement("label");
  setText(sysLabel, "Windows / System Printer");
  const sysInput = document.createElement("input");
  sysInput.type = "text";
  sysInput.placeholder = "e.g. XP-58  (or pick from the list)";
  setVal(sysInput, printer.systemPrinterName);
  sysInput.dataset.field = "systemPrinterName";
  const listId = "syslist" + index;
  sysInput.setAttribute("list", listId);
  const dataList = document.createElement("datalist");
  dataList.id = listId;
  systemPrinters.forEach(function(nm) {
    const o = document.createElement("option");
    o.value = nm;
    dataList.appendChild(o);
  });
  const sysHint = document.createElement("div");
  sysHint.className = "status";
  setText(sysHint, systemPrinters.length
    ? "Detected " + systemPrinters.length + " printer(s) — choose the one your USB printer installed as."
    : "Type the exact printer name from Windows Settings > Printers.");
  sysWrap.append(sysLabel, sysInput, dataList, sysHint);

  const pidLabel = document.createElement("label");
  setText(pidLabel, "Printer ID");
  const pidInput = document.createElement("input");
  pidInput.type = "text";
  pidInput.placeholder = "From Dine Settings > Printers";
  setVal(pidInput, printer.printerId);
  pidInput.dataset.field = "printerId";

  const keyLabel = document.createElement("label");
  setText(keyLabel, "Agent Key");
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.placeholder = "From Dine Settings > Printers";
  setVal(keyInput, printer.agentKey);
  keyInput.dataset.field = "agentKey";

  const widthLabel = document.createElement("label");
  setText(widthLabel, "Paper Width");
  const widthSelect = document.createElement("select");
  widthSelect.style.cssText = "width:100%;padding:9px 11px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:#1f2937;font-size:13px;";
  [["80mm (standard)", "80"], ["58mm (small)", "58"]].forEach(function(opt) {
    const o = document.createElement("option");
    o.value = opt[1];
    setText(o, opt[0]);
    if (String(printer.paperWidth || 80) === opt[1]) o.selected = true;
    widthSelect.appendChild(o);
  });
  widthSelect.addEventListener("change", function() {
    cfg.printers[index].paperWidth = Number(widthSelect.value);
  });

  const modeLabel = document.createElement("label");
  setText(modeLabel, "Printer Mode");
  const modeSelect = document.createElement("select");
  modeSelect.style.cssText = SELECT_CSS;
  [["Receipt Printer", "receipt"], ["Label Printer", "label"]].forEach(function(opt) {
    const o = document.createElement("option");
    o.value = opt[1];
    setText(o, opt[0]);
    if (printerMode === opt[1]) o.selected = true;
    modeSelect.appendChild(o);
  });

  const labelWrap = document.createElement("div");
  labelWrap.style.cssText = "display:" + (printerMode === "label" ? "block" : "none") + ";margin-top:8px;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;";

  function clampMm(v) {
    if (v === "" || v == null) return undefined;
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return undefined;
    return Math.min(120, Math.max(10, Math.round(n)));
  }

  const labelRow = document.createElement("div");
  labelRow.className = "row";

  const lwWrap = document.createElement("div");
  lwWrap.style.flex = "1";
  const lwLabel = document.createElement("label");
  setText(lwLabel, "Label Width (mm)");
  const lwInput = document.createElement("input");
  lwInput.type = "number";
  lwInput.min = "10"; lwInput.max = "120";
  lwInput.placeholder = "60";
  setVal(lwInput, printer.labelWidthMm);
  lwInput.addEventListener("input", function() {
    cfg.printers[index].labelWidthMm = clampMm(lwInput.value);
  });
  lwWrap.append(lwLabel, lwInput);

  const lhWrap = document.createElement("div");
  lhWrap.style.flex = "1";
  const lhLabel = document.createElement("label");
  setText(lhLabel, "Label Height (mm — blank = continuous)");
  const lhInput = document.createElement("input");
  lhInput.type = "number";
  lhInput.min = "10"; lhInput.max = "120";
  lhInput.placeholder = "40";
  setVal(lhInput, printer.labelHeightMm);
  lhInput.addEventListener("input", function() {
    cfg.printers[index].labelHeightMm = clampMm(lhInput.value);
  });
  lhWrap.append(lhLabel, lhInput);

  labelRow.append(lwWrap, lhWrap);

  const gapLabel = document.createElement("label");
  setText(gapLabel, "Gap Type");
  const gapSelect = document.createElement("select");
  gapSelect.style.cssText = SELECT_CSS;
  const currentGap = printer.gapType || "die_cut";
  [["Die-cut labels", "die_cut"], ["Black mark", "black_mark"], ["Continuous roll", "continuous"]].forEach(function(opt) {
    const o = document.createElement("option");
    o.value = opt[1];
    setText(o, opt[0]);
    if (currentGap === opt[1]) o.selected = true;
    gapSelect.appendChild(o);
  });
  gapSelect.addEventListener("change", function() {
    cfg.printers[index].gapType = gapSelect.value;
  });

  const langLabel = document.createElement("label");
  setText(langLabel, "Label Command Language");
  const langSelect = document.createElement("select");
  langSelect.style.cssText = SELECT_CSS;
  const currentLang = printer.labelLanguage || "tspl";
  [["TSPL (TSC / Xprinter / Rongta — most USB labels)", "tspl"], ["ZPL (Zebra)", "zpl"], ["EPL (older Zebra)", "epl"]].forEach(function(opt) {
    const o = document.createElement("option");
    o.value = opt[1];
    setText(o, opt[0]);
    if (currentLang === opt[1]) o.selected = true;
    langSelect.appendChild(o);
  });
  langSelect.addEventListener("change", function() {
    cfg.printers[index].labelLanguage = langSelect.value;
  });
  const langHint = document.createElement("div");
  langHint.className = "status";
  setText(langHint, "If the test print does nothing, try a different language — your printer's manual lists which one it supports.");

  labelWrap.append(labelRow, gapLabel, gapSelect, langLabel, langSelect, langHint);

  modeSelect.addEventListener("change", function() {
    const mode = modeSelect.value === "label" ? "label" : "receipt";
    cfg.printers[index].printerMode = mode;
    if (mode === "label" && !cfg.printers[index].gapType) {
      cfg.printers[index].gapType = "die_cut";
    }
    if (mode === "label" && !cfg.printers[index].labelLanguage) {
      cfg.printers[index].labelLanguage = "tspl";
    }
    labelWrap.style.display = mode === "label" ? "block" : "none";
    setText(modeBadge, mode);
    modeBadge.style.cssText = "font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;"
      + (mode === "label"
        ? "background:#ecfdf5;color:#059669;border:1px solid #a7f3d0;"
        : "background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;");
  });

  const actions = document.createElement("div");
  actions.className = "actions";
  const testBtn = document.createElement("button");
  testBtn.className = "ghost";
  setText(testBtn, "Test Print");
  const removeBtn = document.createElement("button");
  removeBtn.className = "danger";
  setText(removeBtn, "Remove");
  actions.append(testBtn, removeBtn);

  const st = document.createElement("div");
  st.className = "status";
  st.id = "st" + index;

  const connectionFields = connType === "system" ? sysWrap : row;
  card.append(header, nameLabel, nameInput, connLabel, connSelect, connectionFields, pidLabel, pidInput, keyLabel, keyInput, widthLabel, widthSelect, modeLabel, modeSelect, labelWrap, actions, st);

  card.querySelectorAll("input[data-field]").forEach(function(input) {
    input.addEventListener("input", function() {
      const field = input.dataset.field;
      cfg.printers[index][field] = field === "port" ? Number(input.value) : input.value;
    });
  });

  testBtn.addEventListener("click", function() {
    st.className = "status";
    setText(st, "Sending…");
    window.agent.testPrinter(index).then(function(r) {
      st.className = r.ok ? "status ok" : "status err";
      setText(st, r.ok ? "Printed ✓" : (r.error || "Failed"));
    }).catch(function(e) {
      st.className = "status err";
      setText(st, e.message);
    });
  });

  removeBtn.addEventListener("click", function() {
    cfg.printers.splice(index, 1);
    renderPrinters();
  });

  return card;
}

function renderPrinters() {
  const list = document.getElementById("printers");
  while (list.firstChild) list.removeChild(list.firstChild);
  cfg.printers.forEach(function(p, i) { list.appendChild(buildPrinterCard(p, i)); });
}

document.getElementById("addBtn").addEventListener("click", function() {
  cfg.printers.push({ printerId: "", agentKey: "", connection: "network", host: "", port: 9100, systemPrinterName: "", name: "", paperWidth: 80, printerMode: "receipt" });
  renderPrinters();
});

document.getElementById("serverUrl").addEventListener("input", function(e) {
  cfg.serverUrl = e.target.value.trim();
});

document.getElementById("saveBtn").addEventListener("click", function() {
  const st = document.getElementById("globalStatus");
  cfg.serverUrl = document.getElementById("serverUrl").value.trim();
  st.className = "status";
  setText(st, "Saving…");
  window.agent.saveConfig(cfg).then(function() {
    st.className = "status ok";
    setText(st, "Saved ✓");
    setTimeout(function() { setText(st, ""); }, 2500);
  }).catch(function(e) {
    st.className = "status err";
    setText(st, e.message);
  });
});

function init() {
  window.agent.loadConfig().then(function(c) {
    cfg = c;
    document.getElementById("serverUrl").value = c.serverUrl || "";
    document.getElementById("offlineDeviceKey").value = c.offlineDeviceKey || "";
    document.getElementById("taxRelayKey").value = c.taxRelayKey || "";
    renderPrinters();
  });
}

// Save the tax relay key (same config blob).
document.getElementById("saveTaxRelayBtn").addEventListener("click", function() {
  var st = document.getElementById("taxRelayStatus");
  cfg.taxRelayKey = document.getElementById("taxRelayKey").value.trim();
  st.className = "status";
  st.textContent = "Saving…";
  window.agent.saveConfig(cfg).then(function() {
    st.className = "status ok";
    st.textContent = cfg.taxRelayKey
      ? "Saved — the agent will now relay fiscal invoices for this branch."
      : "Key cleared.";
  }).catch(function(e) {
    st.className = "status err";
    st.textContent = e.message;
  });
});

// ── Live print-status panel ─────────────────────────────────
function nameForPrinterId(printerId) {
  var p = (cfg.printers || []).find(function(x) { return x.printerId === printerId; });
  return (p && p.name) ? p.name : printerId;
}

function clockStr(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch (e) { return ""; }
}

function renderHealth(snap) {
  var dot   = document.getElementById("healthDot");
  var label = document.getElementById("healthLabel");
  var pls   = document.getElementById("healthPrinters");
  var rec   = document.getElementById("healthRecent");

  var status = (snap && snap.status) || "green";
  dot.className = "dot " + status;
  label.textContent =
    status === "red"    ? "A printer is currently failing" :
    status === "yellow" ? "Recent print issue — watching" :
                          "Printing OK";

  while (pls.firstChild) pls.removeChild(pls.firstChild);
  var printers = (snap && snap.printers) || [];
  if (printers.length === 0) {
    var e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No print activity yet.";
    pls.appendChild(e);
  } else {
    printers.forEach(function(p) {
      var row = document.createElement("div");
      row.className = "hprinter";
      var d = document.createElement("span");
      d.className = "dot " + (p.ok ? "green" : "red");
      var nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = nameForPrinterId(p.printerId);
      var det = document.createElement("span");
      det.className = "det";
      det.textContent = p.ok ? "last job OK" : "last job FAILED";
      row.append(d, nm, det);
      pls.appendChild(row);
    });
  }

  while (rec.firstChild) rec.removeChild(rec.firstChild);
  var events = (snap && snap.recent) || [];
  events.slice(0, 6).forEach(function(ev) {
    var line = document.createElement("div");
    line.className = "ev";
    var mark = ev.ok ? "✓" : "✗";
    var who  = nameForPrinterId(ev.printerId);
    line.textContent = clockStr(ev.ts) + "  " + mark + " " + ev.kind + " → " + who +
      (ev.ok ? "" : ("  (" + (ev.error || "error") + ")"));
    rec.appendChild(line);
  });
}

function pollHealth() {
  window.agent.getStatus().then(renderHealth).catch(function() {});
}

window.agent.listPrinters().then(function(names) {
  systemPrinters = Array.isArray(names) ? names : [];
  init();
}).catch(function() {
  init();
});

window.agent.getVersion().then(function(v) {
  document.title = "Kliovo Print Agent v" + v;
});

pollHealth();
setInterval(pollHealth, 3000);

// ── Tabs ────────────────────────────────────────────────────
var activePane = "print";
function selectTab(pane) {
  activePane = pane;
  document.querySelectorAll(".tab").forEach(function(b) {
    b.classList.toggle("active", b.dataset.pane === pane);
  });
  document.querySelectorAll(".pane").forEach(function(p) {
    p.classList.toggle("active", p.id === "pane-" + pane);
  });
  if (pane === "offline") refreshOfflineTab();
  if (pane === "biometric") { initBiometric(); pollBiometricStatus(); }
}
document.querySelectorAll(".tab").forEach(function(b) {
  b.addEventListener("click", function() { selectTab(b.dataset.pane); });
});

// ═══════════════════════════════════════════════════════════════
// ── OFFLINE POS TAB ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
function fmtMoney(amount) {
  return "Rs " + Math.round(Number(amount) || 0).toLocaleString();
}
function ago(ts) {
  if (!ts) return "never";
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function pill(text, kind) {
  var p = document.createElement("span");
  p.className = "pill" + (kind ? " " + kind : "");
  p.textContent = text;
  return p;
}

// ── Device Key — save + verify ─────────────────────────────────
document.getElementById("saveKeyBtn").addEventListener("click", function() {
  var btn = document.getElementById("saveKeyBtn");
  var connResult = document.getElementById("connResult");
  var key = document.getElementById("offlineDeviceKey").value.trim();

  btn.disabled = true;
  btn.textContent = "Verifying…";
  while (connResult.firstChild) connResult.removeChild(connResult.firstChild);

  cfg.offlineDeviceKey = key;
  window.agent.saveConfig(cfg).then(function() {
    if (!key) {
      btn.disabled = false;
      btn.textContent = "Save";
      var box = document.createElement("div");
      box.className = "conn-result error";
      box.textContent = "Key cleared.";
      connResult.appendChild(box);
      return;
    }
    return window.agent.verifyDeviceKey(key);
  }).then(function(r) {
    btn.disabled = false;
    btn.textContent = "Save";
    if (!r) return;

    var box = document.createElement("div");
    if (r.valid && r.entitled) {
      box.className = "conn-result success";
      var lines = [];
      if (r.branchName) lines.push(r.branchName);
      if (r.branchAddress) lines.push(r.branchAddress);
      if (r.branchPhone) lines.push(r.branchPhone);
      var b = document.createElement("b");
      b.textContent = "Connected";
      box.appendChild(b);
      if (lines.length) {
        box.appendChild(document.createTextNode(" — " + lines.join(" / ")));
      }
    } else if (r.valid && r.entitled === false) {
      box.className = "conn-result error";
      box.textContent = "Key is valid but Offline POS is not enabled for this branch. Enable it in Dine > Settings > Offline POS.";
    } else {
      box.className = "conn-result error";
      box.textContent = r.error || "Verification failed";
    }
    connResult.appendChild(box);

    // After successful verification, refresh the data inventory
    if (r.valid && r.entitled) {
      setTimeout(loadOfflineData, 2000);
    }
  }).catch(function(e) {
    btn.disabled = false;
    btn.textContent = "Save";
    var box = document.createElement("div");
    box.className = "conn-result error";
    box.textContent = e.message;
    connResult.appendChild(box);
  });
});

// ── Sync bar + log rendering ───────────────────────────────────
function renderSyncBar(overview, syncLog) {
  var bar = document.getElementById("syncBar");
  while (bar.firstChild) bar.removeChild(bar.firstChild);

  if (!overview || !overview.ok) {
    bar.style.display = "none";
    return;
  }
  bar.style.display = "block";

  var d = overview.data;
  var wrapper = document.createElement("div");
  wrapper.className = "sync-bar";

  // Entitled pill
  var ePill = document.createElement("span");
  ePill.className = "sync-pill " + (d.entitled ? "good" : "bad");
  ePill.textContent = d.entitled ? "Entitled" : "Not entitled";
  wrapper.appendChild(ePill);

  // Paired pill
  var pPill = document.createElement("span");
  pPill.className = "sync-pill " + (d.paired ? "good" : "warn");
  pPill.textContent = d.paired ? "Paired" : "Not paired";
  wrapper.appendChild(pPill);

  // Last sync pill
  var sPill = document.createElement("span");
  sPill.className = "sync-pill " + (d.lastMirrorAt ? "good" : "warn");
  sPill.textContent = "Synced " + ago(d.lastMirrorAt);
  wrapper.appendChild(sPill);

  // Unsynced orders pill (if any)
  if (d.counts.unsyncedOrders > 0) {
    var uPill = document.createElement("span");
    uPill.className = "sync-pill bad";
    uPill.textContent = d.counts.unsyncedOrders + " unsynced";
    wrapper.appendChild(uPill);
  }

  // Sync Now button
  var actionsDiv = document.createElement("div");
  actionsDiv.className = "sync-actions";
  var syncBtn = document.createElement("button");
  syncBtn.className = "primary";
  syncBtn.textContent = "Sync Now";
  syncBtn.addEventListener("click", function() {
    syncBtn.disabled = true;
    syncBtn.textContent = "Syncing…";
    window.agent.syncNow().then(function(r) {
      syncBtn.disabled = false;
      syncBtn.textContent = "Sync Now";
      refreshOfflineTab();
    }).catch(function() {
      syncBtn.disabled = false;
      syncBtn.textContent = "Sync Now";
    });
  });
  actionsDiv.appendChild(syncBtn);
  wrapper.appendChild(actionsDiv);

  bar.appendChild(wrapper);

  // Sync log
  if (syncLog && syncLog.length > 0) {
    var logDiv = document.createElement("div");
    logDiv.className = "sync-log";
    syncLog.slice(0, 6).forEach(function(entry) {
      var line = document.createElement("div");
      line.className = "sync-entry";
      var ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = clockStr(entry.ts);
      var result = document.createElement("span");
      result.className = "result " + (entry.ok ? "result-ok" : "result-fail");
      result.textContent = entry.ok ? "OK" : "FAIL";
      var msg = document.createElement("span");
      msg.textContent = entry.message;
      line.append(ts, result, msg);
      logDiv.appendChild(line);
    });
    bar.appendChild(logDiv);
  }
}

// ── Data inventory rendering ───────────────────────────────────

// Track which rows are expanded
var expandedRows = {};

function toggleExpand(key) {
  expandedRows[key] = !expandedRows[key];
  var el = document.getElementById("inv-expand-" + key);
  if (el) el.classList.toggle("open", !!expandedRows[key]);
  var chev = document.getElementById("inv-chev-" + key);
  if (chev) chev.textContent = expandedRows[key] ? "▼" : "▶";
}

function invRow(key, label, count, detail, expandContent, warn) {
  var frag = document.createDocumentFragment();

  var row = document.createElement("div");
  row.className = "inv-row";
  row.addEventListener("click", function() { toggleExpand(key); });

  var icon = document.createElement("div");
  icon.className = "inv-icon" + (warn ? " warn" : "");
  icon.textContent = label.substring(0, 2).toUpperCase();

  var info = document.createElement("div");
  info.className = "inv-info";
  var lbl = document.createElement("div");
  lbl.className = "inv-label";
  lbl.textContent = label;
  info.appendChild(lbl);
  if (detail) {
    var det = document.createElement("div");
    det.className = "inv-detail";
    det.textContent = detail;
    info.appendChild(det);
  }

  var cnt = document.createElement("div");
  cnt.className = "inv-count" + (warn ? " warn" : "");
  cnt.textContent = String(count);

  var chev = document.createElement("div");
  chev.className = "inv-chevron";
  chev.id = "inv-chev-" + key;
  chev.textContent = expandedRows[key] ? "▼" : "▶";

  row.append(icon, info, cnt, chev);
  frag.appendChild(row);

  if (expandContent) {
    var expand = document.createElement("div");
    expand.className = "inv-expand" + (expandedRows[key] ? " open" : "");
    expand.id = "inv-expand-" + key;
    if (typeof expandContent === "function") {
      expandContent(expand);
    } else {
      expand.appendChild(expandContent);
    }
    frag.appendChild(expand);
  }

  return frag;
}

function subItem(label, value) {
  var div = document.createElement("div");
  div.className = "sub-item";
  var l = document.createElement("span");
  l.textContent = label;
  var v = document.createElement("span");
  v.className = "sub-val";
  v.textContent = String(value);
  div.append(l, v);
  return div;
}

function renderInventory(d) {
  var card = document.getElementById("invCard");
  while (card.firstChild) card.removeChild(card.firstChild);

  if (!d) {
    var empty = document.createElement("div");
    empty.className = "inv-row";
    empty.style.cursor = "default";
    var emptyInfo = document.createElement("div");
    emptyInfo.className = "inv-info";
    var emptyLbl = document.createElement("div");
    emptyLbl.className = "inv-label";
    emptyLbl.style.color = "#94a3b8";
    emptyLbl.textContent = "No data cached — save a device key and sync first";
    emptyInfo.appendChild(emptyLbl);
    empty.appendChild(emptyInfo);
    card.appendChild(empty);
    return;
  }

  // 1. Menu
  var menuCats = d.menuCategories || [];
  var menuCount = d.counts.menuItems || 0;
  var menuDetail = menuCats.length + " categories";
  card.appendChild(invRow("menu", "Menu", menuCount, menuDetail, function(el) {
    if (menuCats.length === 0) {
      el.appendChild(subItem("No categories cached", ""));
      return;
    }
    menuCats.forEach(function(cat) {
      el.appendChild(subItem(cat.name, cat.itemCount + " items"));
    });
  }));

  // 2. Combos
  var combos = d.comboDetails || [];
  var comboCount = d.counts.combos || 0;
  card.appendChild(invRow("combos", "Combos", comboCount,
    (d.counts.comboGroups || 0) + " groups, " + (d.counts.comboGroupItems || 0) + " group items",
    function(el) {
      if (combos.length === 0) {
        el.appendChild(subItem("No combos cached", ""));
        return;
      }
      combos.forEach(function(c) {
        var label = c.name + (c.isActive ? "" : " (inactive)");
        el.appendChild(subItem(label, "Rs " + Math.round(c.comboPrice || 0)));
      });
    }
  ));

  // 3. Tables
  var tables = d.tableDetails || [];
  var tableCount = d.counts.tables || 0;
  card.appendChild(invRow("tables", "Tables", tableCount, null, function(el) {
    if (tables.length === 0) {
      el.appendChild(subItem("No tables cached", ""));
      return;
    }
    tables.forEach(function(t) {
      var loc = t.locationName ? " (" + t.locationName + ")" : "";
      el.appendChild(subItem(t.name + loc, t.status || "available"));
    });
  }));

  // 4. Staff (users)
  var users = d.users || [];
  card.appendChild(invRow("staff", "Staff", users.length, null, function(el) {
    if (users.length === 0) {
      var hint = document.createElement("div");
      hint.className = "hint";
      hint.style.margin = "4px 0";
      hint.style.fontSize = "11px";
      var b = document.createElement("b");
      b.textContent = "No staff cached. ";
      hint.appendChild(b);
      hint.appendChild(document.createTextNode("Have an owner/admin sign in to Dine on this computer once to cache all staff, or each staff member signs in individually."));
      el.appendChild(hint);
      return;
    }
    var tbl = document.createElement("table");
    tbl.className = "tbl";
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    ["Name", "Role", "PIN", "Status"].forEach(function(h) {
      var th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr);
    tbl.appendChild(thead);
    var tbody = document.createElement("tbody");
    users.forEach(function(u) {
      var tr = document.createElement("tr");
      var tdN = document.createElement("td"); tdN.textContent = u.name || "—";
      var tdR = document.createElement("td"); tdR.appendChild(pill(u.role || "—", "role"));
      var tdP = document.createElement("td"); tdP.appendChild(u.hasPin ? pill("set", "pin") : pill("—"));
      var tdS = document.createElement("td");
      if (!u.isActive) tdS.appendChild(pill("inactive", "off"));
      tr.append(tdN, tdR, tdP, tdS);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    el.appendChild(tbl);
  }));

  // 5. Terminals
  var terminals = d.terminals || [];
  card.appendChild(invRow("terminals", "Terminals", terminals.length, null, function(el) {
    if (terminals.length === 0) {
      var warn = document.createElement("div");
      warn.className = "warn-banner";
      warn.textContent = "No terminals cached. The Dine server may not include terminals in the snapshot yet.";
      el.appendChild(warn);
      return;
    }
    terminals.forEach(function(t) {
      el.appendChild(subItem(t.code, "next #" + t.nextSeq));
    });
  }, terminals.length === 0));

  // 6. Orders
  var orders = d.recentOrders || [];
  var orderCount = d.counts.orders || 0;
  var unsyncedCount = d.counts.unsyncedOrders || 0;
  var orderDetail = unsyncedCount > 0 ? unsyncedCount + " unsynced" : "all synced";
  card.appendChild(invRow("orders", "Orders", orderCount, orderDetail, function(el) {
    if (orders.length === 0) {
      el.appendChild(subItem("No orders cached yet", ""));
      return;
    }
    var tbl = document.createElement("table");
    tbl.className = "tbl";
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    ["Reference", "Status", "Total", "Source", "Synced"].forEach(function(h) {
      var th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr);
    tbl.appendChild(thead);
    var tbody = document.createElement("tbody");
    orders.forEach(function(o) {
      var tr = document.createElement("tr");
      var tdR = document.createElement("td"); tdR.textContent = o.reference || "—";
      var tdSt = document.createElement("td"); tdSt.appendChild(pill(o.status || "—"));
      var tdT = document.createElement("td"); tdT.textContent = fmtMoney(o.total_amount);
      var tdSrc = document.createElement("td");
      tdSrc.appendChild(o.origin === "offline" ? pill("offline", "ofl") : pill("online", "onl"));
      var tdSy = document.createElement("td");
      if (o.origin === "offline") {
        tdSy.appendChild(o.synced_at ? pill("synced", "onl") : pill("pending", "ofl"));
      } else {
        tdSy.className = "muted"; tdSy.textContent = "—";
      }
      tr.append(tdR, tdSt, tdT, tdSrc, tdSy);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    el.appendChild(tbl);
  }, unsyncedCount > 0));

  // 7. Printers & Routing
  var printerDetails = d.printerDetails || [];
  var printRouting = d.printRouting || [];
  card.appendChild(invRow("printers", "Printers & Routing", printerDetails.length,
    printRouting.length + " routes",
    function(el) {
      if (printerDetails.length === 0) {
        el.appendChild(subItem("No printers cached", ""));
        return;
      }
      printerDetails.forEach(function(p) {
        var label = p.name + " (" + (p.connection || "network") + ")";
        var val = p.isActive ? (p.printerMode || "receipt") : "inactive";
        el.appendChild(subItem(label, val));
      });
      if (printRouting.length > 0) {
        var hdr = document.createElement("div");
        hdr.className = "sub-item";
        hdr.style.marginTop = "6px";
        hdr.style.borderTop = "1px solid #f1f5f9";
        hdr.style.paddingTop = "6px";
        var hdrLbl = document.createElement("span");
        hdrLbl.style.fontWeight = "600";
        hdrLbl.textContent = "Routes";
        hdr.appendChild(hdrLbl);
        el.appendChild(hdr);
        printRouting.forEach(function(r) {
          el.appendChild(subItem(r.role + " (station: " + (r.stationId || "—").substring(0, 8) + "…)", r.printerId ? r.printerId.substring(0, 8) + "…" : "no printer"));
        });
      }
    }
  ));

  // 8. Kitchen Stations
  var stations = d.kitchenStations || [];
  card.appendChild(invRow("stations", "Kitchen Stations", stations.length, null, function(el) {
    if (stations.length === 0) {
      el.appendChild(subItem("No stations cached", ""));
      return;
    }
    stations.forEach(function(s) {
      el.appendChild(subItem(s.name + (s.label ? " (" + s.label + ")" : ""), s.hasPrinter ? "has printer" : "no printer"));
    });
  }, stations.some(function(s) { return !s.hasPrinter; })));

  // 9. Settings
  var settingsDetails = d.settingsDetails || {};
  var settingsCount = d.counts.settings || 0;
  card.appendChild(invRow("settings", "Settings", settingsCount, null, function(el) {
    if (settingsCount === 0) {
      el.appendChild(subItem("No settings cached", ""));
      return;
    }
    var keys = Object.keys(settingsDetails);
    if (keys.length === 0) {
      el.appendChild(subItem("Settings data stored", String(settingsCount) + " records"));
      return;
    }
    keys.forEach(function(k) {
      var v = settingsDetails[k];
      var display = typeof v === "object" ? JSON.stringify(v).substring(0, 60) : String(v);
      el.appendChild(subItem(k, display));
    });
  }));

  // 10. Branding
  var branding = d.brandingDetails || [];
  card.appendChild(invRow("branding", "Branding", branding.length, null, function(el) {
    if (branding.length === 0) {
      el.appendChild(subItem("No branding cached", ""));
      return;
    }
    branding.forEach(function(b) {
      el.appendChild(subItem(b.name || "—", b.address || "—"));
      if (b.phone) el.appendChild(subItem("Phone", b.phone));
      if (b.taxLines && b.taxLines.length) {
        b.taxLines.forEach(function(t) {
          el.appendChild(subItem("Tax: " + (t.label || t.name || "—"), (t.rate || 0) + "%"));
        });
      }
    });
  }));

  // 11. Print Templates
  var templates = d.printTemplateKinds || [];
  card.appendChild(invRow("templates", "Print Templates", templates.length, null, function(el) {
    if (templates.length === 0) {
      el.appendChild(subItem("No templates cached", ""));
      return;
    }
    templates.forEach(function(t) {
      el.appendChild(subItem(t, ""));
    });
  }));
}

// ── Storage card ───────────────────────────────────────────────
function renderStorage(d) {
  var card = document.getElementById("offStorageCard");
  while (card.firstChild) card.removeChild(card.firstChild);

  if (!d) {
    var empty = document.createElement("div");
    empty.style.cssText = "font-size:12px;color:#94a3b8;padding:4px 0";
    empty.textContent = "No storage data available";
    card.appendChild(empty);
    return;
  }

  var rows = [
    ["Encrypted database", fmtBytes(d.storage.dbBytes)],
    ["Total orders", String(d.counts.orders || 0)],
    ["Unsynced orders", String(d.counts.unsyncedOrders || 0)],
    ["Online retention", (d.storage.retentionDays || 7) + " days (auto-pruned)"],
    ["Pending changes", String(d.counts.unsyncedChanges || 0)],
  ];
  rows.forEach(function(r) {
    var line = document.createElement("div");
    line.className = "storage-row";
    var a = document.createElement("span"); a.textContent = r[0];
    var b = document.createElement("span"); b.className = "val"; b.textContent = r[1];
    line.append(a, b);
    card.appendChild(line);
  });

  if (d.storage.dbPath) {
    var pathLine = document.createElement("div");
    pathLine.className = "storage-path";
    pathLine.textContent = d.storage.dbPath;
    card.appendChild(pathLine);
  }
}

// ── Master refresh for offline tab ─────────────────────────────
function loadOfflineData() {
  Promise.all([
    window.agent.getOfflineOverview(),
    window.agent.getSyncLog()
  ]).then(function(results) {
    var overview = results[0];
    var syncLog = results[1];
    renderSyncBar(overview, syncLog);
    if (overview && overview.ok) {
      renderInventory(overview.data);
      renderStorage(overview.data);
    } else {
      renderInventory(null);
      renderStorage(null);
    }
  }).catch(function() {
    renderSyncBar(null, []);
    renderInventory(null);
    renderStorage(null);
  });
}

function refreshOfflineTab() {
  loadOfflineData();
}

setInterval(function() { if (activePane === "offline") loadOfflineData(); }, 8000);

// ═══════════════════════════════════════════════════════════════
// ── BIOMETRIC TAB ──────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

function getBioDevices() {
  return (cfg.biometricDevices || []);
}

function bioDeviceEntry(idx) {
  return getBioDevices()[idx];
}

function renderBioDevices() {
  var list = document.getElementById("bioDevices");
  while (list.firstChild) list.removeChild(list.firstChild);
  var devices = getBioDevices();
  if (devices.length === 0) {
    var empty = document.createElement("div");
    empty.className = "empty";
    empty.style.marginBottom = "10px";
    empty.textContent = "No devices added yet.";
    list.appendChild(empty);
  }
  devices.forEach(function(dev, i) {
    var card = document.createElement("div");
    card.className = "card";
    card.style.marginBottom = "8px";

    var header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:8px";
    var dot = document.createElement("span");
    dot.className = "dot yellow";
    dot.id = "bioDevDot_" + i;
    var nm = document.createElement("span");
    nm.style.cssText = "font-weight:600;font-size:13px;flex:1";
    nm.textContent = dev.name || "Unnamed";
    var addr = document.createElement("span");
    addr.style.cssText = "font-size:11px;color:#94a3b8;font-family:monospace";
    addr.textContent = (dev.host || "?") + ":" + (dev.port || 4370);
    header.append(dot, nm, addr);

    var statusLine = document.createElement("div");
    statusLine.className = "status";
    statusLine.id = "bioDevSt_" + i;
    statusLine.style.marginBottom = "8px";

    var actions = document.createElement("div");
    actions.className = "actions";

    var testBtn = document.createElement("button");
    testBtn.className = "ghost";
    testBtn.textContent = "Test Connection";
    testBtn.addEventListener("click", function() {
      statusLine.className = "status";
      statusLine.textContent = "Connecting…";
      window.agent.biometricTestDevice({ id: dev.id, host: dev.host, port: dev.port || 4370, label: dev.name }).then(function(r) {
        if (r.ok) {
          dot.className = "dot green";
          if (r.serial) {
            cfg.biometricDevices[i].serial = r.serial;
            window.agent.saveConfig(cfg);
          }
          var regNote = r.registered
            ? "  |  registered in Dine"
            : (r.registerError ? "  |  not registered: " + r.registerError : "");
          statusLine.className = "status ok";
          statusLine.textContent = "Connected  Serial: " + r.serial + "  |  " + r.userCounts + " users  |  " + r.logCounts + " punch records" + regNote;
        } else {
          dot.className = "dot red";
          statusLine.className = "status err";
          statusLine.textContent = "Failed: " + (r.error || "unknown error");
        }
      }).catch(function(e) {
        dot.className = "dot red";
        statusLine.className = "status err";
        statusLine.textContent = e.message;
      });
    });

    var pullBtn = document.createElement("button");
    pullBtn.className = "ghost";
    pullBtn.textContent = "Pull Attendance Now";
    pullBtn.addEventListener("click", function() {
      pullBtn.disabled = true;
      var prevText = pullBtn.textContent;
      pullBtn.textContent = "Pulling…";
      statusLine.className = "status";
      statusLine.textContent = "Reading punches from device…";
      window.agent.biometricPollNow({ id: dev.id, name: dev.name, host: dev.host, port: dev.port || 4370, serial: dev.serial }).then(function(r) {
        if (r.ok) {
          dot.className = "dot green";
          statusLine.className = "status ok";
          var parts = [];
          parts.push("Device has " + (r.totalLogs != null ? r.totalLogs : "?") + " punch record(s)");
          parts.push((r.newPunches || 0) + " new pulled");
          if (r.pushed) parts.push("pushed to Dine");
          else if (r.pushError) parts.push("push issue: " + r.pushError);
          if ((r.newPunches || 0) === 0) parts.push("(nothing new since last pull)");
          statusLine.textContent = parts.join("  |  ");
        } else {
          dot.className = "dot red";
          statusLine.className = "status err";
          statusLine.textContent = "Pull failed: " + (r.error || "unknown error");
        }
      }).catch(function(e) {
        dot.className = "dot red";
        statusLine.className = "status err";
        statusLine.textContent = e.message;
      }).finally(function() {
        pullBtn.disabled = false;
        pullBtn.textContent = prevText;
      });
    });

    var toggleBtn = document.createElement("button");
    toggleBtn.className = dev.enabled ? "ghost" : "primary";
    toggleBtn.textContent = dev.enabled ? "Disable" : "Enable";
    toggleBtn.addEventListener("click", function() {
      cfg.biometricDevices[i].enabled = !cfg.biometricDevices[i].enabled;
      window.agent.saveConfig(cfg).then(function() { renderBioDevices(); updateBioDeviceSelect(); });
    });

    var removeBtn = document.createElement("button");
    removeBtn.className = "danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", function() {
      if (!confirm("Remove " + (dev.name || "this device") + "?")) return;
      cfg.biometricDevices.splice(i, 1);
      window.agent.saveConfig(cfg).then(function() { renderBioDevices(); updateBioDeviceSelect(); });
    });

    actions.append(testBtn, pullBtn, toggleBtn, removeBtn);
    card.append(header, statusLine, actions);
    list.appendChild(card);
  });
  updateBioDeviceSelect();
}

function updateBioDeviceSelect() {
  var sel = document.getElementById("bioSyncDevice");
  while (sel.firstChild) sel.removeChild(sel.firstChild);
  var devices = getBioDevices();
  if (devices.length === 0) {
    var o = document.createElement("option");
    o.textContent = "No devices configured";
    o.disabled = true;
    sel.appendChild(o);
    return;
  }
  devices.forEach(function(dev, i) {
    var o = document.createElement("option");
    o.value = String(i);
    o.textContent = (dev.name || "Device " + i) + "  —  " + (dev.host || "?") + ":" + (dev.port || 4370);
    sel.appendChild(o);
  });
}

function initBiometric() {
  document.getElementById("bioKey").value = cfg.attendanceDeviceKey || "";
  renderBioDevices();
}

function pollBiometricStatus() {
  if (activePane !== "biometric") return;
  window.agent.biometricStatus().then(function(s) {
    if (!s || !s.ok) return;
    document.getElementById("bioQueueN").textContent = String(s.queueDepth || 0);
    var fmtTime = function(v) {
      return v ? new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "never";
    };
    var scanEl = document.getElementById("bioScanN");
    if (scanEl) scanEl.textContent = fmtTime(s.lastScan);
    document.getElementById("bioSyncN").textContent = fmtTime(s.lastSync);

    var statusEl = document.getElementById("bioDeviceStatuses");
    while (statusEl.firstChild) statusEl.removeChild(statusEl.firstChild);
    (s.devices || []).forEach(function(d) {
      var row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;font-size:12px;padding:4px 0;border-top:1px solid #f1f5f9";
      var dot = document.createElement("span");
      dot.className = "dot " + (d.connected ? "green" : "red");
      var lbl = document.createElement("span");
      lbl.textContent = d.name;
      var st = document.createElement("span");
      st.style.cssText = "margin-left:auto;font-size:11px;color:#94a3b8";
      st.textContent = d.connected ? "polling" : "disconnected";
      row.append(dot, lbl, st);
      statusEl.appendChild(row);
    });
  }).catch(function() {});
}
setInterval(function() { if (activePane === "biometric") pollBiometricStatus(); }, 5000);

// Save attendance device key
document.getElementById("bioSaveConfigBtn").addEventListener("click", function() {
  var st = document.getElementById("bioConfigStatus");
  var key = document.getElementById("bioKey").value.trim();
  if (key && !key.startsWith("atk_")) {
    st.className = "status err";
    st.textContent = "That doesn't look like an attendance device key (should start with atk_).";
    return;
  }
  cfg.attendanceDeviceKey = key;
  st.className = "status";
  st.textContent = "Saving…";
  window.agent.saveConfig(cfg).then(function() {
    st.className = "status ok";
    st.textContent = "Saved — now test each device's connection below to register it.";
    setTimeout(function() { st.textContent = ""; }, 4000);
  }).catch(function(e) {
    st.className = "status err";
    st.textContent = e.message;
  });
});

// Add device
document.getElementById("bioAddBtn").addEventListener("click", function() {
  var name = document.getElementById("bioAddName").value.trim();
  var host = document.getElementById("bioAddHost").value.trim();
  var port = parseInt(document.getElementById("bioAddPort").value) || 4370;
  if (!host) { alert("Enter the device IP address."); return; }
  var id = "zk_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  if (!cfg.biometricDevices) cfg.biometricDevices = [];
  cfg.biometricDevices.push({ id: id, name: name || host, type: "zk-tcp", host: host, port: port, enabled: true, pollIntervalMs: 15000 });
  document.getElementById("bioAddName").value = "";
  document.getElementById("bioAddHost").value = "";
  document.getElementById("bioAddPort").value = "";
  window.agent.saveConfig(cfg).then(function() { renderBioDevices(); });
});

// Sync staff from Dine to device
document.getElementById("bioSyncStaffBtn").addEventListener("click", function() {
  var st = document.getElementById("bioSyncStatus");
  var results = document.getElementById("bioSyncResults");
  var sel = document.getElementById("bioSyncDevice");
  var idx = parseInt(sel.value);
  var dev = bioDeviceEntry(idx);
  if (!dev) { st.className = "status err"; st.textContent = "Select a device first."; return; }
  st.className = "status";
  st.textContent = "Fetching staff from Dine…";
  while (results.firstChild) results.removeChild(results.firstChild);

  window.agent.biometricSyncStaff({ id: dev.id, host: dev.host, port: dev.port || 4370, serial: dev.serial }).then(function(r) {
    if (!r.ok && (!r.results || r.results.length === 0)) {
      st.className = "status err";
      st.textContent = r.error || "Failed";
      return;
    }
    var removedNote = r.removed > 0 ? "  |  " + r.removed + " ex-staff removed from device" : "";
    st.className = r.ok ? "status ok" : "status err";
    st.textContent = r.ok
      ? "Done — " + r.pushed + " staff pushed to device" + (r.failed > 0 ? "  (" + r.failed + " failed)" : "") + removedNote
      : (r.error || "Partial failure");

    if (r.results && r.results.length > 0) {
      var tbl = document.createElement("table");
      tbl.className = "tbl";
      var thead = document.createElement("thead");
      var htr = document.createElement("tr");
      ["Name", "PIN", "Status"].forEach(function(h) {
        var th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
      });
      thead.appendChild(htr);
      tbl.appendChild(thead);
      var tbody = document.createElement("tbody");
      r.results.forEach(function(row) {
        var tr = document.createElement("tr");
        var tdN = document.createElement("td"); tdN.textContent = row.name;
        var tdP = document.createElement("td"); tdP.appendChild(pill(row.pin, "pin"));
        var tdS = document.createElement("td");
        tdS.appendChild(row.ok ? pill("synced", "onl") : pill(row.error || "failed", "off"));
        tr.append(tdN, tdP, tdS);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      results.appendChild(tbl);
    }
  }).catch(function(e) {
    st.className = "status err";
    st.textContent = e.message;
  });
});

// View enrolled users on device
document.getElementById("bioViewUsersBtn").addEventListener("click", function() {
  var st = document.getElementById("bioSyncStatus");
  var results = document.getElementById("bioSyncResults");
  var sel = document.getElementById("bioSyncDevice");
  var idx = parseInt(sel.value);
  var dev = bioDeviceEntry(idx);
  if (!dev) { st.className = "status err"; st.textContent = "Select a device first."; return; }
  st.className = "status";
  st.textContent = "Reading device…";
  while (results.firstChild) results.removeChild(results.firstChild);

  window.agent.biometricDeviceUsers({ host: dev.host, port: dev.port || 4370 }).then(function(r) {
    if (!r.ok) {
      st.className = "status err";
      st.textContent = r.error || "Failed";
      return;
    }
    st.className = "status ok";
    st.textContent = r.users.length + " user(s) enrolled on device";
    if (r.users.length === 0) {
      var e = document.createElement("div");
      e.className = "empty";
      e.style.marginTop = "8px";
      e.textContent = "No users enrolled. Sync staff first, then each person enrolls their fingerprint at the device.";
      results.appendChild(e);
      return;
    }
    var tbl = document.createElement("table");
    tbl.className = "tbl";
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    ["Name", "PIN (userId)", "Role"].forEach(function(h) {
      var th = document.createElement("th"); th.textContent = h; htr.appendChild(th);
    });
    thead.appendChild(htr);
    tbl.appendChild(thead);
    var tbody = document.createElement("tbody");
    r.users.forEach(function(u) {
      var tr = document.createElement("tr");
      var tdN = document.createElement("td"); tdN.textContent = u.name || "(no name)";
      var tdP = document.createElement("td"); tdP.appendChild(pill(u.userId, "pin"));
      var tdR = document.createElement("td");
      tdR.appendChild(pill(u.role === 14 ? "admin" : "user", u.role === 14 ? "role" : ""));
      tr.append(tdN, tdP, tdR);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    results.appendChild(tbl);
  }).catch(function(e) {
    st.className = "status err";
    st.textContent = e.message;
  });
});
