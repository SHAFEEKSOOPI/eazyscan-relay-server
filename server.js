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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const state = {
  devices: {},
  desktops: {},
  activeDevice: null
};



// ================= HELPERS =================

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

    socket.emit("desktop:registered", {
      ok: true,
      sessionId
    });

    console.log("DESKTOP REGISTERED:", sessionId);
  });

  // ===== PAIR REQUEST =====
socket.on("pair:request", (payload = {}) => {

  const { sessionId, deviceId, deviceName } = payload;

  const desktop = getDesktopBySession(sessionId);
  if (!desktop) {
    socket.emit("pair:response", { ok: false });
    return;
  }

  const id = deviceId || socket.id;

  // 🔥 JOIN ROOM (IMPORTANT)
  socket.join(id);

  const existing = state.devices[id];

  const finalName =
    existing?.name || deviceName || "Mobile Device";

  if (existing) {
    // 🔥 DO NOT RESET APPROVAL
    state.devices[id] = {
      ...existing,
      socketId: socket.id,
      sessionId,
      online: true,
      lastSeen: Date.now()
    };
  } else {
    state.devices[id] = {
      id,
      name: finalName,
      socketId: socket.id,
      sessionId,
      approved: false,
      online: true,
      lastSeen: Date.now()
    };
  }

  if (state.devices[id].approved) {
    socket.emit("pair:response", {
      ok: true,
      name: state.devices[id].name
    });
  } else {
    socket.emit("pair:response", {
      ok: false,
      pending: true
    });
  }

  emitDevicesUpdate();

  console.log("PAIR REQUEST:", id);
});


  // ===== APPROVE =====

socket.on("device:approve", ({ deviceId }) => {

  const dev = state.devices[deviceId];
  if (!dev) return;

  dev.approved = true;

  if (!state.trusted[deviceId] || typeof state.trusted[deviceId] !== "object") {
    state.trusted[deviceId] = {};
  }

  if (state.devices[deviceId]?.name) {
  state.trusted[deviceId].name = state.devices[deviceId].name;
}
  saveTrusted();

  state.activeDevice = deviceId;

  if (dev.socketId) {
    io.to(dev.socketId).emit("pair:approved");
    io.to(dev.socketId).emit("pair:response", { ok: true, name: dev.name });
  }

  emitDevicesUpdate();
});



  // ===== REJECT =====

socket.on("device:reject", ({ deviceId }) => {

  const dev = state.devices[deviceId];

  if (dev?.socketId) {
    io.to(dev.socketId).emit("pair:rejected");
  }

  rejected[deviceId] = Date.now(); // block for some time

  delete state.devices[deviceId];

  emitDevicesUpdate();
});



  // ===== DISCONNECT =====
socket.on("device:disconnect", ({ deviceId }) => {
    const dev = state.devices[deviceId];
    if (!dev) return;

    if (dev.socketId) {
      io.to(dev.socketId).emit("force:disconnect");
    }

    state.devices[deviceId] = {
      ...dev,
      socketId: null,
      online: false
    };

    emitDevicesUpdate();
  });

  // ===== RENAME =====
socket.on("device:rename", ({ deviceId, name }) => {
    if (!state.devices[deviceId]) return;

    state.devices[deviceId].name = name;

    emitDevicesUpdate();
  });

  // ===== REMOVE =====
socket.on("device:remove", ({ deviceId }) => {
    delete state.devices[deviceId];

    if (state.activeDevice === deviceId) {
      state.activeDevice = null;
    }

    emitDevicesUpdate();
  });

  // ===== SCAN =====
socket.on("scan:barcode", (data = {}) => {
    const { barcode, sessionId, deviceId } = data;

    const desktop = getDesktopBySession(sessionId);

    if (desktop?.socketId) {
      io.to(desktop.socketId).emit("scan-received", {
        barcode,
        deviceId,
        at: new Date().toLocaleTimeString()
      });
    }
  });

  // ===== DISCONNECT SOCKET =====
socket.on("disconnect", () => {

  const dev = Object.values(state.devices)
    .find(d => d.socketId === socket.id);

  if (!dev) return;

  console.log("⚠️ SOCKET DISCONNECTED:", dev.id);

  // 🔥 DO NOT RESET IMMEDIATELY
  setTimeout(() => {

    const stillConnected = Object.values(state.devices)
      .find(d => d.id === dev.id && d.socketId !== socket.id);

    if (stillConnected) {
      console.log("✅ Device reconnected, ignore disconnect");
      return;
    }

    state.devices[dev.id] = {
      ...state.devices[dev.id],
      socketId: null,
      online: false
    };

    emitDevicesUpdate();

  }, 1000); // 👈 allow reconnect window
});


});

// ================= START =================

const PORT = process.env.PORT || 3210;

server.listen(PORT, () => {
  console.log("Relay running on port " + PORT);
});
