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

  // ── Mode badge (Receipt / Label) in card header ────────────
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

  // ── Connection type ────────────────────────────────────────
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

  // ── System (USB) fields — printer queue name + detect list ─
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

  // ── Printer Mode (Receipt / Label) ─────────────────────────
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

  // ── Label-only fields (width / height / gap type) ──────────
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

  // Command language the label printer speaks — ESC/POS won't work on any
  // label printer, so let the operator pick TSPL / ZPL / EPL.
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
    renderPrinters();
  });
}

// Save the offline device key (kept in the same config as printers/serverUrl).
document.getElementById("saveKeyBtn").addEventListener("click", function() {
  const st = document.getElementById("keyStatus");
  cfg.offlineDeviceKey = document.getElementById("offlineDeviceKey").value.trim();
  st.className = "status";
  st.textContent = "Saving…";
  window.agent.saveConfig(cfg).then(function() {
    st.className = "status ok";
    st.textContent = cfg.offlineDeviceKey
      ? "Saved ✓ — pulling offline data… (give it a few seconds, then check below)"
      : "Key cleared.";
    setTimeout(pollOffline, 6000);
  }).catch(function(e) {
    st.className = "status err";
    st.textContent = e.message;
  });
});

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

// Detect OS-installed printers first (for the USB picker), then render.
window.agent.listPrinters().then(function(names) {
  systemPrinters = Array.isArray(names) ? names : [];
  init();
}).catch(function() {
  init();
});

window.agent.getVersion().then(function(v) {
  document.title = "Kliovo Print Agent v" + v;
});

// Live status panel — poll the health snapshot every few seconds.
pollHealth();
setInterval(pollHealth, 3000);

// ── Tabs ────────────────────────────────────────────────────
let activePane = "print";
function selectTab(pane) {
  activePane = pane;
  document.querySelectorAll(".tab").forEach(function(b) {
    b.classList.toggle("active", b.dataset.pane === pane);
  });
  document.getElementById("pane-print").classList.toggle("active", pane === "print");
  document.getElementById("pane-offline").classList.toggle("active", pane === "offline");
  if (pane === "offline") pollOffline();
}
document.querySelectorAll(".tab").forEach(function(b) {
  b.addEventListener("click", function() { selectTab(b.dataset.pane); });
});

// ── Offline POS panel ───────────────────────────────────────
function fmtBytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}
function fmtMoney(amount) {
  // Offline store amounts are in RUPEES (snapshot sends Decimal rupees; offline
  // orders compute in rupees too), so don't divide by 100.
  return "Rs " + Math.round(Number(amount) || 0).toLocaleString();
}
function ago(ts) {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function badge(text, kind) {
  const b = document.createElement("span");
  b.className = "badge" + (kind ? " " + kind : "");
  const d = document.createElement("span");
  d.className = "bdot";
  const t = document.createElement("span");
  t.textContent = text;
  b.append(d, t);
  return b;
}
function pill(text, kind) {
  const p = document.createElement("span");
  p.className = "pill" + (kind ? " " + kind : "");
  p.textContent = text;
  return p;
}
function kpi(n, label, alert) {
  const w = document.createElement("div");
  w.className = "kpi";
  const nn = document.createElement("div");
  nn.className = "n" + (alert && Number(n) > 0 ? " alert" : "");
  nn.textContent = String(n);
  const ll = document.createElement("div");
  ll.className = "l";
  ll.textContent = label;
  w.append(nn, ll);
  return w;
}
// Build the "no staff cached" guidance out of DOM nodes (no innerHTML).
function buildEmptyLoginHint() {
  const h = document.createElement("div");
  h.className = "hint";
  function strong(t) { const s = document.createElement("b"); s.textContent = t; return s; }
  h.append(
    strong("No staff cached yet. "),
    document.createTextNode("Offline login is primed from the web while online. Have an "),
    strong("owner/admin sign in to Dine on this computer once"),
    document.createTextNode(" to cache all staff at once — or each staff member can sign in to the web here once to cache their own login. After that they can log in to the offline POS during an outage.")
  );
  return h;
}

function renderOffline(res) {
  const badges  = document.getElementById("offBadges");
  const kpis    = document.getElementById("offKpis");
  const uCard   = document.getElementById("offUsersCard");
  const uCount  = document.getElementById("offUserCount");
  const oCard   = document.getElementById("offOrdersCard");
  const sCard   = document.getElementById("offStorageCard");
  [badges, kpis, uCard, oCard, sCard].forEach(function(n) { while (n.firstChild) n.removeChild(n.firstChild); });
  uCount.textContent = "";

  if (!res || !res.ok) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = res && res.error ? ("Offline store not ready — " + res.error) : "Offline store not initialised.";
    badges.appendChild(e);
    return;
  }
  const d = res.data;

  // Status badges
  badges.appendChild(badge(d.entitled ? "Offline enabled" : "Not entitled", d.entitled ? "good" : "warn"));
  badges.appendChild(badge(d.paired ? "Paired with web" : "Not paired yet", d.paired ? "good" : "warn"));
  badges.appendChild(badge("Last sync " + ago(d.lastMirrorAt), d.lastMirrorAt ? "good" : "warn"));

  // KPIs
  kpis.appendChild(kpi(d.users.length, "Logins"));
  kpis.appendChild(kpi(d.counts.menuItems ?? 0, "Menu items"));
  kpis.appendChild(kpi(d.counts.combos ?? 0, "Combos"));
  kpis.appendChild(kpi(d.counts.unsyncedOrders, "Unsynced", true));

  // Cached logins
  uCount.textContent = d.users.length + " staff can log in offline";
  if (d.users.length === 0) {
    uCard.appendChild(buildEmptyLoginHint());
  } else {
    const tbl = document.createElement("table");
    tbl.className = "tbl";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Name", "Email", "Role", "Manager PIN", ""].forEach(function(h) {
      const th = document.createElement("th");
      th.textContent = h;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    tbl.appendChild(thead);
    const tbody = document.createElement("tbody");
    d.users.forEach(function(u) {
      const tr = document.createElement("tr");
      const tdN = document.createElement("td"); tdN.textContent = u.name || "—";
      const tdE = document.createElement("td"); tdE.className = "muted"; tdE.textContent = u.email || "—";
      const tdR = document.createElement("td"); tdR.appendChild(pill(u.role || "—", "role"));
      const tdP = document.createElement("td");
      tdP.appendChild(u.hasPin ? pill("set", "pin") : pill("—"));
      const tdS = document.createElement("td");
      if (!u.isActive) tdS.appendChild(pill("inactive", "off"));
      tr.append(tdN, tdE, tdR, tdP, tdS);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    uCard.appendChild(tbl);
  }

  // Recent orders
  if (!d.recentOrders.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No orders cached yet.";
    oCard.appendChild(e);
  } else {
    const tbl = document.createElement("table");
    tbl.className = "tbl";
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    ["Reference", "Status", "Total", "Source", "Synced"].forEach(function(h) {
      const th = document.createElement("th");
      th.textContent = h;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    tbl.appendChild(thead);
    const tbody = document.createElement("tbody");
    d.recentOrders.forEach(function(o) {
      const tr = document.createElement("tr");
      const tdR = document.createElement("td"); tdR.textContent = o.reference || "—";
      const tdSt = document.createElement("td"); tdSt.appendChild(pill(o.status || "—"));
      const tdT = document.createElement("td"); tdT.textContent = fmtMoney(o.total_amount);
      const tdSrc = document.createElement("td");
      tdSrc.appendChild(o.origin === "offline" ? pill("offline", "ofl") : pill("online", "onl"));
      const tdSy = document.createElement("td");
      if (o.origin === "offline") {
        tdSy.appendChild(o.synced_at ? pill("synced", "onl") : pill("pending", "ofl"));
      } else {
        tdSy.className = "muted"; tdSy.textContent = "—";
      }
      tr.append(tdR, tdSt, tdT, tdSrc, tdSy);
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    oCard.appendChild(tbl);
  }

  // Storage
  const rows = [
    ["Encrypted database", fmtBytes(d.storage.dbBytes)],
    ["Total orders kept", String(d.counts.orders)],
    ["Online retention", d.storage.retentionDays + " days (auto-pruned)"],
    ["Pending changes", String(d.counts.unsyncedChanges)],
  ];
  if (d.terminals.length) {
    rows.push(["Terminals", d.terminals.map(function(t) { return t.code + " (next #" + t.nextSeq + ")"; }).join(", ")]);
  }
  rows.forEach(function(r) {
    const line = document.createElement("div");
    line.className = "meta";
    const a = document.createElement("span"); a.textContent = r[0];
    const b = document.createElement("span"); b.style.color = "#1f2937"; b.textContent = r[1];
    line.append(a, b);
    sCard.appendChild(line);
  });
  const pathLine = document.createElement("div");
  pathLine.className = "meta";
  pathLine.style.marginTop = "10px";
  const pa = document.createElement("span"); pa.textContent = "Location";
  const pb = document.createElement("span");
  pb.className = "muted"; pb.style.fontFamily = "ui-monospace, Menlo, monospace";
  pb.style.fontSize = "10px"; pb.style.maxWidth = "70%"; pb.style.textAlign = "right";
  pb.style.wordBreak = "break-all"; pb.textContent = d.storage.dbPath;
  pathLine.append(pa, pb);
  sCard.appendChild(pathLine);
}

function pollOffline() {
  if (activePane !== "offline") return;
  window.agent.getOfflineOverview().then(renderOffline).catch(function() {});
}
setInterval(function() { if (activePane === "offline") pollOffline(); }, 5000);
