// Settings window renderer — loaded as external script so CSP 'self' allows it

let cfg = { serverUrl: "", printers: [] };

function setText(el, val) { el.textContent = String(val ?? ""); }
function setVal(el, val)  { el.value = String(val ?? ""); }

function buildPrinterCard(printer, index) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.index = String(index);

  const nameLabel = document.createElement("label");
  setText(nameLabel, "Name");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.placeholder = "e.g. Main Floor";
  setVal(nameInput, printer.name);
  nameInput.dataset.field = "name";

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

  card.append(nameLabel, nameInput, row, pidLabel, pidInput, keyLabel, keyInput, actions, st);

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
  cfg.printers.push({ printerId: "", agentKey: "", host: "", port: 9100, name: "", paperWidth: 80 });
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

window.agent.loadConfig().then(function(c) {
  cfg = c;
  document.getElementById("serverUrl").value = c.serverUrl || "";
  renderPrinters();
});

window.agent.getVersion().then(function(v) {
  document.title = "Kliovo Print Agent v" + v;
});
