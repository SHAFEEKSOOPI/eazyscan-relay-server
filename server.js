const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const state = {
  devices: {},
  desktops: {},
  activeDevice: null,
  trusted: {}
};

const fs = require("fs");
const path = require("path");
const DEVICES_FILE = path.join(__dirname, "devices.json");
const DESKTOPS_FILE = path.join(__dirname, "desktops.json");
function loadDesktops() { try { return fs.existsSync(DESKTOPS_FILE) ? JSON.parse(fs.readFileSync(DESKTOPS_FILE, "utf8")) : {}; } catch (_) { return {}; } }
function saveDesktops() { try { fs.writeFileSync(DESKTOPS_FILE, JSON.stringify(state.desktops, null, 2)); } catch (err) { console.error("Error saving desktops:", err); } }
state.devices = loadDevices();
state.desktops = loadDesktops();

// ================= HELPERS =================
function loadDevices() {
  try {
    if (fs.existsSync(DEVICES_FILE)) {
      return JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Error loading devices:", err);
  }
  return {};
}


function saveDevices() {
  try {
    fs.writeFileSync(
      DEVICES_FILE,
      JSON.stringify(state.devices, null, 2)
    );
  } catch (err) {
    console.error("Error saving devices:", err);
  }
}

function emitDevicesUpdate() {
  const payload = {
    devices: state.devices,
    active: state.activeDevice
  };

  Object.values(state.desktops).forEach((desk) => {
    if (desk.socketId) {
      io.to(desk.socketId).emit("devices-update", payload);
    }
  });
}

function getDesktopBySession(sessionId) {
  return Object.values(state.desktops).find(
    (d) => d.sessionId === sessionId
  );
}

// ================= ROUTES =================

app.get("/", (req, res) => {
  res.send("EazyScan Relay Running");
});

const rejected = {};

function createDesktopSession(desktopId, name = "1BOS PWA") {
  const id = desktopId || `pwa_${crypto.randomBytes(8).toString("hex")}`;
  const sessionId = crypto.randomBytes(16).toString("hex");
  state.desktops[id] = { id, socketId: null, sessionId, name };
  saveDesktops();
  return { desktopId: id, sessionId, qrUrl: `https://eazyscan.app/connect?session=${sessionId}` };
}

app.post("/api/desktop/register", (req, res) => {
  res.json({ ok: true, ...createDesktopSession(req.body?.desktopId, req.body?.name) });
});

app.get("/api/state", (req, res) => {
  const sessionId = String(req.query.sessionId || "").trim();
  const desktop = getDesktopBySession(sessionId);
  if (!desktop) return res.status(401).json({ ok: false, error: "invalid-session" });
  res.json({ ok: true, devices: state.devices, active: state.activeDevice, sessionId, qrUrl: `https://eazyscan.app/connect?session=${sessionId}` });
});

app.post("/api/device/action", (req, res) => {
  const sessionId = String(req.body?.sessionId || "").trim();
  const desktop = getDesktopBySession(sessionId);
  if (!desktop) return res.status(401).json({ ok: false, error: "invalid-session" });
  const { action, deviceId, name } = req.body || {};
  const dev = state.devices[deviceId];
  if (!dev && action !== "connect") return res.status(404).json({ ok: false, error: "device-not-found" });
  if (action === "approve" || action === "reconnect") {
    dev.approved = true;
    dev.online = Boolean(dev.socketId);
    if (action === "reconnect") dev.reconnectRequested = true;
    state.activeDevice = deviceId;
    if (dev.socketId) io.to(dev.socketId).emit(action === "reconnect" ? "device:reconnect" : "pair:approved", { ok: true, name: dev.name });
  }
  else if (action === "disconnect") {
    if (dev.socketId) io.to(dev.socketId).emit("force:disconnect");
    state.devices[deviceId] = { ...dev, online: false, approved: true };
  }
  else if (action === "reject" || action === "remove") { if (dev.socketId) io.to(dev.socketId).emit("pair:rejected"); delete state.devices[deviceId]; }
  else if (action === "rename" && name) dev.name = name;
  else if (action !== "connect") return res.status(400).json({ ok: false, error: "invalid-action" });
  saveDevices(); emitDevicesUpdate();
  res.json({ ok: true, action, devices: state.devices, active: state.activeDevice });
});

// ================= SOCKET =================

io.on("connection", (socket) => {
  console.log("CLIENT CONNECTED:", socket.id);

  // ===== DESKTOP REGISTER =====
socket.on("desktop:register", (payload = {}) => {
    const desktopId = payload.desktopId || socket.id;
    const sessionId = crypto.randomBytes(16).toString("hex");

    state.desktops[desktopId] = {
      id: desktopId,
      socketId: socket.id,
      sessionId
    };
    saveDesktops();

    socket.emit("desktop:registered", {
      ok: true,
      sessionId
    });

    console.log("DESKTOP REGISTERED:", sessionId);
  });

// ===== PAIR REQUEST =====
socket.on("pair:request", (payload = {}) => {
  const { sessionId, deviceId, deviceName } = payload;

  const id = deviceId || socket.id;
  const existing = state.devices[id];

  // Approved devices may reconnect through a PWA-created virtual desktop
  // session. Electron sessions have socketId; PWA sessions intentionally do
  // not, but still own the persisted pairing session.
  const currentDesktop = (existing?.desktopId && state.desktops[existing.desktopId])
    || Object.values(state.desktops).find(d => d.socketId)
    || Object.values(state.desktops)[0];

  if (existing && existing.approved) {
    if (!currentDesktop) {
      socket.emit("pair:response", { ok: false, reason: "no-desktop" });
      return;
    }

    state.devices[id] = {
      ...existing,
      name: existing.name || deviceName || "Mobile Device",
      socketId: socket.id,
      sessionId: currentDesktop.sessionId,
      desktopId: currentDesktop.id,
      online: true,
      reconnectRequested: false,
      lastSeen: Date.now()
    };
    
    state.activeDevice = id;

    socket.emit("pair:response", {
      ok: true,
      name: state.devices[id].name
    });

    emitDevicesUpdate();
    console.log("RECONNECTED APPROVED DEVICE:", id, state.devices[id]);
    return;
  }

  const desktop = getDesktopBySession(sessionId);
  if (!desktop) {
    socket.emit("pair:response", { ok: false, reason: "invalid-session" });
    return;
  }

  state.devices[id] = {
    id,
    name: existing?.name || deviceName || "Mobile Device",
    socketId: socket.id,
    sessionId,
    desktopId: desktop.id,
    approved: false,
    online: true,
    lastSeen: Date.now()
  };

  saveDevices();

  socket.emit("pair:response", {
    ok: false,
    pending: true
  });

  emitDevicesUpdate();
  console.log("PAIR REQUEST:", id, state.devices[id]);
});


// ===== APPROVE =====
socket.on("device:approve", ({ deviceId }) => {
  const dev = state.devices[deviceId];
  if (!dev) return;

  dev.approved = true;
  dev.online = true;
  dev.lastSeen = Date.now();
  state.activeDevice = deviceId;
  
  saveDevices();

  if (dev.socketId) {
    io.to(dev.socketId).emit("pair:approved", {
      ok: true,
      name: dev.name
    });

    io.to(dev.socketId).emit("pair:response", {
      ok: true,
      name: dev.name
    });
  }

  emitDevicesUpdate();
  console.log("DEVICE APPROVED:", deviceId);
});



// ===== REJECT =====
socket.on("device:reject", ({ deviceId }) => {
  const dev = state.devices[deviceId];
  if (!dev) return;

  if (dev.socketId) {
    io.to(dev.socketId).emit("pair:rejected");
  }

  delete state.devices[deviceId];

  const nextActive = Object.values(state.devices)
    .find(d => d.approved && d.online);

  state.activeDevice = nextActive ? nextActive.id : null;

  emitDevicesUpdate();
  console.log("DEVICE REJECTED:", deviceId);
});

  // ===== DISCONNECT =====
socket.on("device:disconnect", ({ deviceId }) => {
  const dev = state.devices[deviceId];
  if (!dev) return;

  if (dev.socketId) {
    io.to(dev.socketId).emit("force:disconnect");
  }

  state.devices[deviceId] = { ...dev, online: false, approved: true };

  saveDevices();   

  if (state.activeDevice === deviceId) {
    const onlineApproved = Object.values(state.devices)
      .find(d => d.approved && d.online);

    state.activeDevice = onlineApproved ? onlineApproved.id : null;
  }

  emitDevicesUpdate();
  console.log("DEVICE DISCONNECTED:", deviceId, state.devices[deviceId]);
});

  // ===== RECONNECT =====
socket.on("device:reconnect", ({ deviceId }) => {
  const dev = state.devices[deviceId];
  if (!dev) return;

  dev.approved = true;
  dev.online = Boolean(dev.socketId);
  dev.lastSeen = Date.now();
  state.activeDevice = deviceId;
  if (dev.socketId) io.to(dev.socketId).emit("device:reconnect", { ok: true, name: dev.name });
  saveDevices();
  emitDevicesUpdate();
  console.log("DEVICE RECONNECT REQUEST:", deviceId);
});

  // ===== RENAME =====
socket.on("device:rename", ({ deviceId, name }) => {
    if (!deviceId || !name) return;

  if (state.devices[deviceId]) {
    state.devices[deviceId].name = name;
    saveDevices();
  }


    emitDevicesUpdate();
  });

 // ===== DEVICE REMOVE =====
socket.on("device:remove", ({ deviceId }) => {
  const dev = state.devices[deviceId];
  if (!dev) return;

  if (dev.socketId) {
    io.to(dev.socketId).emit("pair:rejected");
  }

  delete state.devices[deviceId];
  
  saveDevices();

  const nextActive = Object.values(state.devices)
    .find(d => d.approved && d.online);

  state.activeDevice = nextActive ? nextActive.id : null;

  emitDevicesUpdate();
  console.log("DEVICE REMOVED:", deviceId);
});

  // ===== SCAN =====
socket.on("scan:barcode", (data = {}) => {
  const { barcode, deviceId } = data;

  const dev = state.devices[deviceId];

  if (!dev || !dev.approved) {
    console.log("❌ Scan rejected (not approved):", deviceId);
    return;
  }

  console.log("📦 SCAN RECEIVED FROM:", deviceId, barcode);

  Object.values(state.desktops).forEach((desk) => {
    if (desk.socketId) {
      io.to(desk.socketId).emit("scan-received", {
        barcode,
        deviceId,
        at: new Date().toLocaleTimeString()
      });
    }
  });
});

  // ===== DISCONNECT SOCKET =====
socket.on("disconnect", () => {
  const dev = Object.values(state.devices).find(d => d.socketId === socket.id);
  if (!dev) return;

  console.log("SOCKET DISCONNECT:", dev.id, socket.id);

  setTimeout(() => {
    const latest = state.devices[dev.id];
    if (!latest) return;

    // ignore if same device already reconnected with a new socket
    if (latest.socketId && latest.socketId !== socket.id) {
      console.log("IGNORE OLD DISCONNECT:", dev.id);
      return;
    }

    state.devices[dev.id] = {
      ...latest,
      socketId: null,
      online: false
    };

    saveDevices();

    if (state.activeDevice === dev.id) {
      const onlineApproved = Object.values(state.devices)
        .find(d => d.approved && d.online);

      state.activeDevice = onlineApproved ? onlineApproved.id : null;
    }

    emitDevicesUpdate();
    console.log("MARKED OFFLINE:", dev.id, state.devices[dev.id]);
  }, 1500);
});

});

// ================= START =================

const PORT = process.env.PORT || 3210;

server.listen(PORT, () => {
  console.log("Relay running on port " + PORT);
});
