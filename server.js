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

app.get("/", (req, res) => {
  res.send("EazyScan Relay Running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    desktops: Object.keys(state.desktops).length,
    devices: Object.keys(state.devices).length
  });
});

io.on("connection", (socket) => {
  console.log("CLIENT CONNECTED:", socket.id);

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

  socket.on("pair:request", (payload = {}) => {
    const { sessionId, deviceId } = payload;

    const desktop = getDesktopBySession(sessionId);
    if (!desktop) {
      socket.emit("pair:response", { ok: false });
      return;
    }

    const id = deviceId || socket.id;

  state.devices[id] = {
  id,
  socketId: socket.id,
  sessionId,
  name: payload.deviceName || "Mobile Device", // ✅ FIX
  approved: true,
  online: true, // ✅ FIX
  lastSeen: Date.now()
};

    state.activeDevice = id;

  socket.emit("pair:response", {
  ok: true,
  deviceId: id,
  name: state.devices[id].name
});

    emitDevicesUpdate();

    console.log("DEVICE CONNECTED:", id);
  });

  socket.on("scan:barcode", (data = {}) => {
    const { barcode, deviceId, sessionId } = data;

    const desktop = getDesktopBySession(sessionId);
    if (desktop?.socketId) {
      io.to(desktop.socketId).emit("scan-received", {
        barcode
      });
    }
  });

  socket.on("disconnect", () => {
  console.log("DISCONNECTED:", socket.id);

  const dev = Object.values(state.devices)
    .find(d => d.socketId === socket.id);

  if (dev) {
    state.devices[dev.id] = {
      ...dev,
      socketId: null,
      online: false
    };

    emitDevicesUpdate();
  }
});
});

socket.on("device:disconnect", ({ deviceId }) => {
  const dev = state.devices[deviceId];
  if (!dev) return;

  if (dev.socketId) {
    io.to(dev.socketId).emit("force:disconnect");
  }

  state.devices[deviceId].online = false;
  state.devices[deviceId].socketId = null;

  emitDevicesUpdate();
});

socket.on("device:remove", ({ deviceId }) => {
  delete state.devices[deviceId];

  if (state.activeDevice === deviceId) {
    state.activeDevice = null;
  }

  emitDevicesUpdate();
});


const PORT = process.env.PORT || 3210;

server.listen(PORT, () => {
  console.log("Relay server running on port " + PORT);
});


