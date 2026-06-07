// Settings window renderer — loaded as external script so CSP 'self' allows it

let cfg = { serverUrl: "", printers: [] };
let systemQueues = [];   // OS-installed print-queue names (Windows/CUPS)
let usbDevices   = [];   // raw USB printers with no queue [{ path, name }]

const SELECT_CSS = "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#f1f5f9;font-size:13px;";

function setText(el, val) { el.textContent = String(val ?? ""); }
function setVal(el, val)  { el.value = String(val ?? ""); }

function buildPrinterCard(printer, index) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.index = String(index);

  // "usb" groups both queue-installed ("system") and raw-USB ("usb_raw") printers.
  const connType = printer.connection === "network" ? "network" : "usb";

  const nameLabel = document.createElement("label");
  setText(nameLabel, "Name");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "e.g. Main Floor";
  setVal(nameInput, printer.name);
  nameInput.dataset.field = "name";

  // ── Connection type ────────────────────────────────────────
  const connLabel = document.createElement("label");
  setText(connLabel, "Connection");
  const connSelect = document.createElement("select");
  connSelect.style.cssText = SELECT_CSS;
  [["Network (Ethernet / Wi-Fi)", "network"], ["USB (this PC's printer)", "usb"]].forEach(function(opt) {
    const o = document.createElement("option");
    o.value = opt[1];
    setText(o, opt[0]);
    if (connType === opt[1]) o.selected = true;
    connSelect.appendChild(o);
  });
  connSelect.addEventListener("change", function() {
    if (connSelect.value === "network") {
      cfg.printers[index].connection = "network";
    } else if (cfg.printers[index].connection !== "usb_raw") {
      // Entering USB mode — default to a queue printer until one is picked.
      cfg.printers[index].connection = "system";
    }
    renderPrinters();
  });

  // ── Network fields (IP + Port) ─────────────────────────────
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

  // ── USB fields — one picker covering both installed queues AND raw USB ─
  const sysWrap = document.createElement("div");
  const sysLabel = document.createElement("label");
  setText(sysLabel, "USB Printer");

  const pickerRow = document.createElement("div");
  pickerRow.className = "row";

  const pick = document.createElement("select");
  pick.style.cssText = SELECT_CSS;
  pick.style.flex = "1";

  const ph = document.createElement("option");
  ph.value = ""; setText(ph, "— select a detected printer —");
  pick.appendChild(ph);

  // Group 1: installed Windows/CUPS print queues (connection "system")
  if (systemQueues.length) {
    const g = document.createElement("optgroup");
    g.label = "Installed printers (in Windows Settings)";
    systemQueues.forEach(function(nm) {
      const o = document.createElement("option");
      o.value = "system::" + nm; setText(o, nm);
      if (printer.connection === "system" && printer.systemPrinterName === nm) o.selected = true;
      g.appendChild(o);
    });
    pick.appendChild(g);
  }

  // Group 2: raw USB printers with no queue (connection "usb_raw")
  if (usbDevices.length) {
    const g = document.createElement("optgroup");
    g.label = "USB printers (no driver / not in Settings)";
    usbDevices.forEach(function(d) {
      const o = document.createElement("option");
      o.value = "usb_raw::" + d.path; setText(o, d.name);
      if (printer.connection === "usb_raw" && printer.usbDevicePath === d.path) o.selected = true;
      g.appendChild(o);
    });
    pick.appendChild(g);
  }

  pick.addEventListener("change", function() {
    const v = pick.value;
    const sep = v.indexOf("::");
    if (sep === -1) return;
    const kind = v.slice(0, sep);
    const val  = v.slice(sep + 2);
    if (kind === "system") {
      cfg.printers[index].connection = "system";
      cfg.printers[index].systemPrinterName = val;
      cfg.printers[index].usbDevicePath = "";
      setVal(sysInput, val);
    } else {
      cfg.printers[index].connection = "usb_raw";
      cfg.printers[index].usbDevicePath = val;
      cfg.printers[index].systemPrinterName = "";
      setVal(sysInput, "");
    }
  });

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "ghost";
  refreshBtn.style.flex = "0 0 auto";
  setText(refreshBtn, "Refresh");
  refreshBtn.addEventListener("click", function() {
    setText(sysHint, "Scanning for printers…");
    detectPrinters().then(function() { renderPrinters(); });
  });
  pickerRow.append(pick, refreshBtn);

  // Manual fallback: type an exact Windows queue name if it isn't auto-listed.
  const sysInput = document.createElement("input");
  sysInput.type = "text";
  sysInput.placeholder = "…or type the exact Windows printer name";
  setVal(sysInput, printer.systemPrinterName);
  sysInput.style.marginTop = "8px";
  sysInput.addEventListener("input", function() {
    cfg.printers[index].connection = "system";
    cfg.printers[index].systemPrinterName = sysInput.value;
    cfg.printers[index].usbDevicePath = "";
  });

  const sysHint = document.createElement("div");
  sysHint.className = "status";
  const total = systemQueues.length + usbDevices.length;
  setText(sysHint, total
    ? "Detected " + total + " printer(s). Pick yours — USB printers that aren't in Windows Settings appear in the second group."
    : "No printers detected. Plug in the USB printer, then press Refresh.");
  sysWrap.append(sysLabel, pickerRow, sysInput, sysHint);

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
  widthSelect.style.cssText = "width:100%;padding:8px 10px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#f1f5f9;font-size:13px;";
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
  card.append(nameLabel, nameInput, connLabel, connSelect, connectionFields, pidLabel, pidInput, keyLabel, keyInput, widthLabel, widthSelect, actions, st);

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
  cfg.printers.push({ printerId: "", agentKey: "", connection: "network", host: "", port: 9100, systemPrinterName: "", usbDevicePath: "", name: "", paperWidth: 80 });
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
    renderPrinters();
  });
}

// ── Live print-status panel ─────────────────────────────────
function nameForPrinterId(printerId) {
  const p = (cfg.printers || []).find(function(x) { return x.printerId === printerId; });
  return (p && p.name) ? p.name : printerId;
}

function clockStr(ts) {
  try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
  catch (e) { return ""; }
}

function renderHealth(snap) {
  const dot   = document.getElementById("healthDot");
  const label = document.getElementById("healthLabel");
  const pls   = document.getElementById("healthPrinters");
  const rec   = document.getElementById("healthRecent");

  const status = (snap && snap.status) || "green";
  dot.className = "dot " + status;
  label.textContent =
    status === "red"    ? "A printer is currently failing" :
    status === "yellow" ? "Recent print issue — watching" :
                          "Printing OK";

  // Per-printer last result
  while (pls.firstChild) pls.removeChild(pls.firstChild);
  const printers = (snap && snap.printers) || [];
  if (printers.length === 0) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No print activity yet.";
    pls.appendChild(e);
  } else {
    printers.forEach(function(p) {
      const row = document.createElement("div");
      row.className = "hprinter";
      const d = document.createElement("span");
      d.className = "dot " + (p.ok ? "green" : "red");
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = nameForPrinterId(p.printerId);
      const det = document.createElement("span");
      det.className = "det";
      det.textContent = p.ok ? "last job OK" : "last job FAILED";
      row.append(d, nm, det);
      pls.appendChild(row);
    });
  }

  // Recent activity (last few events)
  while (rec.firstChild) rec.removeChild(rec.firstChild);
  const events = (snap && snap.recent) || [];
  events.slice(0, 6).forEach(function(ev) {
    const line = document.createElement("div");
    line.className = "ev";
    const mark = ev.ok ? "✓" : "✗";
    const who  = nameForPrinterId(ev.printerId);
    line.textContent = clockStr(ev.ts) + "  " + mark + " " + ev.kind + " → " + who +
      (ev.ok ? "" : ("  (" + (ev.error || "error") + ")"));
    rec.appendChild(line);
  });
}

function pollHealth() {
  window.agent.getStatus().then(renderHealth).catch(function() {});
}

// Detect every reachable printer (installed queues + raw USB) for the picker.
function detectPrinters() {
  return window.agent.listPrinters().then(function(res) {
    systemQueues = (res && Array.isArray(res.queues)) ? res.queues : [];
    usbDevices   = (res && Array.isArray(res.usb))    ? res.usb    : [];
  }).catch(function() {
    systemQueues = [];
    usbDevices = [];
  });
}

// Detect printers first (for the USB picker), then render.
detectPrinters().then(init);

window.agent.getVersion().then(function(v) {
  document.title = "Kliovo Print Agent v" + v;
});

// Live status panel — poll the health snapshot every few seconds.
pollHealth();
setInterval(pollHealth, 3000);
