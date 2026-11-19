let myUsername = (localStorage.getItem("username") || "").trim();
let socket = null;
let activeConnId = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let needsRoomResync = false;
let canDismissUsernameModal = false;

let currentRoom = "global";
let knownRooms = [{ name: "global", memberCount: 0, hasActivePoll: false }];
const unreadCounts = new Map();
const typingUsers = new Set();

let activePollId = null;
let isPollCollapsed = false;
let lastRenderedMsg = null;

let isSelfTyping = false;
let typingIdleTimer = null;
let toastTimer = null;

const MAX_MESSAGE_LENGTH = 1000;
const MAX_POLL_OPTIONS = 8;
const ROOM_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,31}$/;

const conversationEl = document.getElementById("conversation");
const pinnedPollEl = document.getElementById("pinned-poll");
const headerRoomEl = document.getElementById("header-room");
const headerRoomMembersEl = document.getElementById("header-room-members");
const headerUsernameEl = document.getElementById("header-username");
const changeUsernameBtn = document.getElementById("change-username-btn");

const statusPillEl = document.getElementById("connection-status");
const statusTextEl = document.getElementById("connection-status-text");

const inputElement = document.getElementById("data");
const charCounterEl = document.getElementById("char-counter");
const typingIndicatorEl = document.getElementById("typing-indicator");
const jumpLatestBtn = document.getElementById("jump-latest-btn");
const sendBtn = document.getElementById("send");
const crtRoomBtn = document.getElementById("crt-room-btn");

const roomForm = document.getElementById("room-form");
const roomNameInput = document.getElementById("room-name");
const roomErrorEl = document.getElementById("room-error");

const bannerEl = document.getElementById("connection-banner");
const bannerTextEl = document.getElementById("connection-banner-text");
const reconnectBtn = document.getElementById("reconnect-btn");

const toastEl = document.getElementById("action-toast");
const toastTextEl = document.getElementById("action-toast-text");
const dismissToastBtn = document.getElementById("dismiss-toast-btn");

const modal = document.getElementById("poll-section");
const pollBtn = document.getElementById("show-poll-btn");
const closeModalBtn = document.getElementById("close-poll-modal");
const pollForm = document.getElementById("poll-form");
const pollQuestionInput = document.getElementById("poll-question");
const pollOptionsInput = document.getElementById("poll-options");
const pollErrorEl = document.getElementById("poll-error");

const usernameModal = document.getElementById("username-modal");
const usernameModalTitle = document.getElementById("username-modal-title");
const closeUsernameModalBtn = document.getElementById("close-username-modal");
const usernameForm = document.getElementById("username-form");
const usernameInput = document.getElementById("username-input");
const usernameErrorEl = document.getElementById("username-error");
const joinChatBtn = document.getElementById("join-chat-btn");

const sidebarEl = document.getElementById("sidebar");
const menuToggleBtn = document.getElementById("menu-toggle");
const closeSidebarBtn = document.getElementById("close-sidebar-btn");
const sidebarBackdrop = document.getElementById("sidebar-backdrop");

function formatTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function getDateKey(timestamp) {
  const d = new Date(timestamp || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatDateLabel(timestamp) {
  const targetKey = getDateKey(timestamp);
  const now = new Date();
  const todayKey = getDateKey(now.getTime());
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = getDateKey(yesterday.getTime());

  if (targetKey === todayKey) return "Hari ini";
  if (targetKey === yesterdayKey) return "Kemarin";
  return new Date(timestamp).toLocaleDateString("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function getUserVoteOption(poll) {
  if (!poll || !poll.votes) return null;
  for (const [option, voters] of Object.entries(poll.votes)) {
    if (Array.isArray(voters) && voters.includes(myUsername)) {
      return option;
    }
  }
  return null;
}

function setConnectionStatus(state) {
  statusPillEl.classList.remove(
    "status-connected",
    "status-connecting",
    "status-disconnected",
  );
  if (state === "connected") {
    statusPillEl.classList.add("status-connected");
    statusTextEl.textContent = "Terhubung";
  } else if (state === "connecting") {
    statusPillEl.classList.add("status-connecting");
    statusTextEl.textContent = "Menyambungkan";
  } else {
    statusPillEl.classList.add("status-disconnected");
    statusTextEl.textContent = "Terputus";
  }
}

function updateHeaderUsername() {
  headerUsernameEl.textContent = myUsername ? `@${myUsername}` : "Belum masuk";
}

function setControlsEnabled(enabled) {
  sendBtn.disabled = !enabled;
  pollBtn.disabled = !enabled;
  crtRoomBtn.disabled = !enabled;
}

function showConnectionBanner(message, canReconnect) {
  bannerTextEl.textContent = message;
  reconnectBtn.hidden = !canReconnect;
  bannerEl.hidden = false;
}

function hideConnectionBanner() {
  bannerEl.hidden = true;
  bannerTextEl.textContent = "";
  reconnectBtn.hidden = true;
}

function showToast(message) {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastTextEl.textContent = message;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    toastTimer = null;
  }, 5000);
}

function hideToast() {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastEl.hidden = true;
  toastTextEl.textContent = "";
}

dismissToastBtn.addEventListener("click", hideToast);

function showRoomError(message) {
  roomErrorEl.textContent = message;
  roomErrorEl.hidden = false;
}

function clearRoomError() {
  roomErrorEl.textContent = "";
  roomErrorEl.hidden = true;
}

function showPollError(message) {
  pollErrorEl.textContent = message;
  pollErrorEl.hidden = false;
}

function clearPollError() {
  pollErrorEl.textContent = "";
  pollErrorEl.hidden = true;
}

function setConversationState(text, kind) {
  conversationEl.replaceChildren();
  lastRenderedMsg = null;
  jumpLatestBtn.hidden = true;
  const stateEl = document.createElement("p");
  stateEl.className = `conversation-state conversation-state-${kind}`;
  stateEl.textContent = text;
  conversationEl.appendChild(stateEl);
}

function clearConversationState() {
  const existing = conversationEl.querySelector(".conversation-state");
  if (existing) {
    existing.remove();
  }
}

function clearPoll() {
  activePollId = null;
  isPollCollapsed = false;
  pinnedPollEl.replaceChildren();
  pinnedPollEl.hidden = true;
}

function updateTypingDisplay() {
  const names = [...typingUsers];
  if (names.length === 0) {
    typingIndicatorEl.hidden = true;
    typingIndicatorEl.textContent = "";
    return;
  }
  if (names.length === 1) {
    typingIndicatorEl.textContent = `${names[0]} sedang mengetik...`;
  } else if (names.length === 2) {
    typingIndicatorEl.textContent = `${names[0]} dan ${names[1]} sedang mengetik...`;
  } else {
    typingIndicatorEl.textContent = `${names.length} orang sedang mengetik...`;
  }
  typingIndicatorEl.hidden = false;
}

function sendTypingState(isTyping) {
  if (isSelfTyping === isTyping) return;
  isSelfTyping = isTyping;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({ event: "typing", room: currentRoom, isTyping }),
    );
  }
}

function stopSelfTyping() {
  if (typingIdleTimer) {
    clearTimeout(typingIdleTimer);
    typingIdleTimer = null;
  }
  sendTypingState(false);
}

function updateRoomHeader(room, memberCount = null) {
  headerRoomEl.textContent = `#${room}`;
  inputElement.placeholder = `Tulis pesan untuk #${room}...`;

  let count = memberCount;
  if (count === null) {
    const found = knownRooms.find((r) => r.name === room);
    count = found ? found.memberCount : 0;
  }
  headerRoomMembersEl.textContent = `${count} anggota`;
}

function getFocusableElements(container) {
  return [...container.querySelectorAll(
    'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => el.offsetParent !== null);
}

function trapFocusInModal(modalEl, event) {
  if (event.key !== "Tab") return;
  const focusables = getFocusableElements(modalEl);
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openUsernameModal(errorText = "", dismissible = false) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  canDismissUsernameModal = dismissible;
  closeUsernameModalBtn.hidden = !dismissible;
  usernameModalTitle.textContent = dismissible
    ? "Ganti Nama Pengguna"
    : "Masuk ke Chat";
  joinChatBtn.textContent = dismissible ? "Simpan Nama" : "Gabung ke Chat";

  usernameInput.value = myUsername;
  if (errorText) {
    usernameErrorEl.textContent = errorText;
    usernameErrorEl.hidden = false;
  } else {
    usernameErrorEl.textContent = "";
    usernameErrorEl.hidden = true;
  }
  usernameModal.hidden = false;
  usernameInput.focus();
  usernameInput.select();
}

function closeUsernameModal(restoreFocus = false) {
  if (usernameModal.hidden) return;
  usernameModal.hidden = true;
  usernameErrorEl.hidden = true;
  usernameErrorEl.textContent = "";
  if (restoreFocus) {
    changeUsernameBtn.focus();
  }
}

changeUsernameBtn.addEventListener("click", () => {
  const isConnected = Boolean(socket && socket.readyState === WebSocket.OPEN);
  openUsernameModal("", isConnected);
});

closeUsernameModalBtn.addEventListener("click", () => {
  if (canDismissUsernameModal) {
    closeUsernameModal(true);
  }
});

usernameModal.addEventListener("click", (event) => {
  if (event.target === usernameModal && canDismissUsernameModal) {
    closeUsernameModal(true);
  }
});

function openSidebar() {
  sidebarEl.classList.add("open");
  sidebarBackdrop.hidden = false;
  menuToggleBtn.setAttribute("aria-expanded", "true");
  closeSidebarBtn.focus();
}

function closeSidebar(restoreFocus = false) {
  if (!sidebarEl.classList.contains("open")) return;
  sidebarEl.classList.remove("open");
  sidebarBackdrop.hidden = true;
  menuToggleBtn.setAttribute("aria-expanded", "false");
  if (restoreFocus) {
    menuToggleBtn.focus();
  }
}

menuToggleBtn.addEventListener("click", () => {
  if (sidebarEl.classList.contains("open")) {
    closeSidebar(true);
  } else {
    openSidebar();
  }
});

closeSidebarBtn.addEventListener("click", () => closeSidebar(true));
sidebarBackdrop.addEventListener("click", () => closeSidebar(true));

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(ws, connId) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (connId !== activeConnId || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    ws.send(JSON.stringify({ event: "ping" }));
  }, 25000);
}

function scheduleReconnect() {
  if (reconnectTimer || !usernameModal.hidden || !myUsername) return;
  if (reconnectAttempts >= 5) {
    showConnectionBanner(
      "Gagal menyambung otomatis setelah 5 percobaan. Periksa server lalu klik Sambungkan Ulang.",
      true,
    );
    return;
  }
  const delayMs = Math.min(10000, 2000 * (2 ** reconnectAttempts));
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket(myUsername);
  }, delayMs);
}

function normalizeRoomsPayload(rawRooms) {
  if (!Array.isArray(rawRooms)) {
    return [{ name: "global", memberCount: 0, hasActivePoll: false }];
  }
  return rawRooms.map((item) => {
    if (typeof item === "string") {
      return { name: item, memberCount: 0, hasActivePoll: false };
    }
    return {
      name: item.name,
      memberCount: Number(item.memberCount) || 0,
      hasActivePoll: Boolean(item.hasActivePoll),
    };
  });
}

function switchToRoom(roomName) {
  if (roomName === currentRoom) {
    closeSidebar(false);
    return;
  }
  stopSelfTyping();
  typingUsers.clear();
  updateTypingDisplay();
  unreadCounts.delete(roomName);

  currentRoom = roomName;
  updateRoomHeader(roomName);
  clearPoll();
  setConversationState(`Memuat pesan untuk #${roomName}...`, "loading");

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event: "switch-room", room: roomName }));
  }
  updateRoomList(knownRooms);
  closeSidebar(false);
  inputElement.focus();
}

function connectSocket(username) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopHeartbeat();
  stopSelfTyping();
  typingUsers.clear();
  updateTypingDisplay();

  activeConnId += 1;
  const connId = activeConnId;

  if (
    socket &&
    (socket.readyState === WebSocket.OPEN ||
      socket.readyState === WebSocket.CONNECTING)
  ) {
    socket.close();
  }

  setConnectionStatus("connecting");
  setControlsEnabled(false);
  setConversationState("Menghubungkan ke server dan memuat pesan room...", "loading");

  const url = new URL(
    `./start_web_socket?username=${encodeURIComponent(username)}`,
    location.href,
  );
  url.protocol = url.protocol.replace("http", "ws");
  const ws = new WebSocket(url);
  socket = ws;

  ws.onopen = () => {
    if (connId !== activeConnId) return;
    reconnectAttempts = 0;
    setConnectionStatus("connected");
    updateHeaderUsername();
    hideConnectionBanner();
    closeUsernameModal(false);
    setControlsEnabled(true);
    startHeartbeat(ws, connId);
    inputElement.focus();
  };

  ws.onmessage = (event) => {
    if (connId !== activeConnId) return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (data.event) {
      case "pong":
        break;
      case "update-users":
        updateUserList(data.users, data.usernames);
        break;
      case "update-rooms":
        knownRooms = normalizeRoomsPayload(data.rooms);
        if (needsRoomResync && currentRoom !== "global") {
          needsRoomResync = false;
          if (knownRooms.some((r) => r.name === currentRoom)) {
            ws.send(JSON.stringify({ event: "switch-room", room: currentRoom }));
          } else {
            currentRoom = "global";
          }
        }
        updateRoomHeader(currentRoom);
        updateRoomList(knownRooms);
        break;
      case "room-created":
        clearRoomError();
        if (typeof data.room === "string") {
          switchToRoom(data.room);
        }
        break;
      case "room-activity":
        if (typeof data.room === "string" && data.room !== currentRoom) {
          const prev = unreadCounts.get(data.room) || 0;
          unreadCounts.set(data.room, prev + 1);
          updateRoomList(knownRooms);
        }
        break;
      case "room-state":
        if (data.room === currentRoom) {
          conversationEl.replaceChildren();
          lastRenderedMsg = null;
          typingUsers.clear();
          updateTypingDisplay();
          clearPoll();
          unreadCounts.delete(currentRoom);

          if (typeof data.memberCount === "number") {
            updateRoomHeader(currentRoom, data.memberCount);
          }

          if (Array.isArray(data.messages) && data.messages.length > 0) {
            for (const msg of data.messages) {
              addMessage(
                msg.username,
                msg.message,
                msg.timestamp,
                msg.type || "chat",
              );
            }
          } else {
            setConversationState(
              "Belum ada percakapan di room ini. Kirim pesan pertama untuk memulai diskusi.",
              "empty",
            );
          }

          if (data.poll) {
            renderPoll(data.poll);
          }
        }
        break;
      case "send-message":
        if (data.room === currentRoom) {
          addMessage(
            data.username,
            data.message,
            data.timestamp,
            data.type || "chat",
          );
        }
        break;
      case "poll-created":
      case "poll-updated":
        if (data.room === currentRoom && data.poll) {
          renderPoll(data.poll);
        }
        break;
      case "user-typing":
        if (data.room === currentRoom && data.username !== myUsername) {
          if (data.isTyping) {
            typingUsers.add(data.username);
          } else {
            typingUsers.delete(data.username);
          }
          updateTypingDisplay();
        }
        break;
      case "error":
        if (
          data.code === "INVALID_ROOM_NAME" ||
          data.code === "ROOM_EXISTS"
        ) {
          showRoomError(data.message || "Gagal membuat room.");
        } else if (data.code === "INVALID_POLL" && !modal.hidden) {
          showPollError(data.message || "Data polling tidak valid.");
        } else {
          showToast(data.message || "Terjadi kesalahan pada permintaan.");
        }
        break;
    }
  };

  ws.onclose = (event) => {
    if (connId !== activeConnId) return;
    stopHeartbeat();
    stopSelfTyping();
    typingUsers.clear();
    updateTypingDisplay();
    setControlsEnabled(false);
    setConnectionStatus("disconnected");

    if (event.code === 1008) {
      showConnectionBanner(
        `Nama pengguna "${myUsername}" sudah dipakai atau tidak valid.`,
        false,
      );
      openUsernameModal(
        `Nama pengguna "${myUsername}" sudah dipakai atau tidak valid. Silakan gunakan nama lain.`,
        false,
      );
      return;
    }

    needsRoomResync = true;
    showConnectionBanner(
      "Koneksi ke server terputus. Periksa jaringan atau klik Sambungkan Ulang.",
      true,
    );
    scheduleReconnect();
  };

  ws.onerror = () => {
    if (connId !== activeConnId) return;
    if (ws.readyState !== WebSocket.OPEN) {
      setConnectionStatus("disconnected");
      showConnectionBanner(
        "Tidak dapat terhubung ke server chat. Pastikan server berjalan lalu coba lagi.",
        true,
      );
    }
  };
}

reconnectBtn.addEventListener("click", () => {
  if (!myUsername) {
    openUsernameModal("", false);
    return;
  }
  reconnectAttempts = 0;
  connectSocket(myUsername);
});

usernameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const chosen = usernameInput.value.trim();
  if (!chosen) {
    usernameErrorEl.textContent = "Nama pengguna tidak boleh kosong.";
    usernameErrorEl.hidden = false;
    usernameInput.focus();
    return;
  }
  if (chosen.length > 30) {
    usernameErrorEl.textContent = "Nama pengguna maksimal 30 karakter.";
    usernameErrorEl.hidden = false;
    usernameInput.focus();
    return;
  }
  if (chosen.toLowerCase() === "system") {
    usernameErrorEl.textContent = 'Nama "System" dicadangkan oleh server.';
    usernameErrorEl.hidden = false;
    usernameInput.focus();
    return;
  }
  if (
    chosen === myUsername &&
    socket &&
    socket.readyState === WebSocket.OPEN
  ) {
    closeUsernameModal(true);
    return;
  }

  myUsername = chosen;
  localStorage.setItem("username", myUsername);
  updateHeaderUsername();
  needsRoomResync = currentRoom !== "global";
  connectSocket(myUsername);
});

function updateUserList(users, fallbackUsernames) {
  const userList = document.getElementById("users");
  const userCountEl = document.getElementById("user-count");
  userList.replaceChildren();

  const normalized = Array.isArray(users)
    ? users
    : Array.isArray(fallbackUsernames)
    ? fallbackUsernames.map((username) => ({ username, room: "" }))
    : [];

  userCountEl.textContent = String(normalized.length);

  for (const user of normalized) {
    const listItem = document.createElement("li");
    if (user.username === myUsername) {
      listItem.classList.add("current-user");
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "user-name-label";
    nameSpan.textContent = user.username === myUsername
      ? `${user.username} (Anda)`
      : user.username;
    listItem.appendChild(nameSpan);

    if (user.room) {
      const roomTag = document.createElement("span");
      roomTag.className = "user-room-tag";
      roomTag.textContent = `#${user.room}`;
      listItem.appendChild(roomTag);
    }

    userList.appendChild(listItem);
  }
}

function addMessage(username, message, timestamp, type = "chat") {
  clearConversationState();
  const ts = timestamp || Date.now();
  const dateKey = getDateKey(ts);

  if (!lastRenderedMsg || lastRenderedMsg.dateKey !== dateKey) {
    const divider = document.createElement("div");
    divider.className = "date-divider";
    divider.textContent = formatDateLabel(ts);
    conversationEl.prepend(divider);
  }

  const isGrouped = Boolean(
    lastRenderedMsg &&
      type === "chat" &&
      lastRenderedMsg.type === "chat" &&
      lastRenderedMsg.username === username &&
      lastRenderedMsg.dateKey === dateKey &&
      ts - lastRenderedMsg.timestamp <= 120000,
  );

  const template = document.getElementById("message");
  const clone = template.content.cloneNode(true);
  const article = clone.querySelector(".message-item");
  const authorEl = clone.querySelector(".message-author");
  const timeEl = clone.querySelector(".message-time");
  const bodyEl = clone.querySelector(".message-body");

  if (type === "system") {
    article.classList.add("message-system");
    authorEl.textContent = "System";
  } else if (username === myUsername) {
    article.classList.add("message-self");
    authorEl.textContent = `${username} (Anda)`;
  } else {
    article.classList.add("message-other");
    authorEl.textContent = username;
  }

  if (isGrouped) {
    article.classList.add("message-grouped");
  }

  timeEl.textContent = formatTime(ts);
  timeEl.setAttribute("datetime", new Date(ts).toISOString());
  bodyEl.textContent = message;

  conversationEl.prepend(clone);
  lastRenderedMsg = { username, timestamp: ts, type, dateKey };
}

conversationEl.addEventListener("scroll", () => {
  const isScrolledUp = Math.abs(conversationEl.scrollTop) > 180;
  jumpLatestBtn.hidden = !isScrolledUp;
});

jumpLatestBtn.addEventListener("click", () => {
  conversationEl.scrollTop = 0;
  jumpLatestBtn.hidden = true;
});

function updateCharCounter() {
  const len = inputElement.value.length;
  if (len >= 800) {
    charCounterEl.textContent = `${len}/${MAX_MESSAGE_LENGTH}`;
    charCounterEl.classList.toggle("char-counter-warn", len >= 950);
    charCounterEl.hidden = false;
  } else {
    charCounterEl.hidden = true;
  }
}

inputElement.addEventListener("input", () => {
  updateCharCounter();
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  if (inputElement.value.trim().length > 0) {
    sendTypingState(true);
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(() => {
      typingIdleTimer = null;
      sendTypingState(false);
    }, 2500);
  } else {
    stopSelfTyping();
  }
});

inputElement.addEventListener("blur", stopSelfTyping);

const form = document.getElementById("form");
form.onsubmit = (e) => {
  e.preventDefault();
  const message = inputElement.value.trim();
  if (!message || !socket || socket.readyState !== WebSocket.OPEN) return;
  if (message.length > MAX_MESSAGE_LENGTH) {
    showToast(`Pesan maksimal ${MAX_MESSAGE_LENGTH} karakter.`);
    return;
  }
  stopSelfTyping();
  inputElement.value = "";
  updateCharCounter();
  socket.send(
    JSON.stringify({ event: "send-message", message, room: currentRoom }),
  );
};

roomNameInput.addEventListener("input", clearRoomError);

roomForm.onsubmit = (e) => {
  e.preventDefault();
  clearRoomError();
  const normalized = roomNameInput.value
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, "-");

  if (!normalized) {
    showRoomError("Masukkan nama room terlebih dahulu.");
    roomNameInput.focus();
    return;
  }
  if (!ROOM_NAME_PATTERN.test(normalized)) {
    showRoomError("Gunakan huruf, angka, tanda hubung (-), atau garis bawah (_).");
    roomNameInput.focus();
    return;
  }
  if (knownRooms.some((r) => r.name === normalized)) {
    showRoomError(`Room #${normalized} sudah tersedia.`);
    roomNameInput.focus();
    return;
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event: "create-room", room: normalized }));
    roomForm.reset();
  }
};

function openPollModal() {
  clearPollError();
  modal.hidden = false;
  pollQuestionInput.focus();
}

function closePollModal() {
  if (modal.hidden) return;
  modal.hidden = true;
  clearPollError();
  pollBtn.focus();
}

pollBtn.addEventListener("click", openPollModal);
closeModalBtn.addEventListener("click", closePollModal);
pollQuestionInput.addEventListener("input", clearPollError);
pollOptionsInput.addEventListener("input", clearPollError);

modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    closePollModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (!modal.hidden) {
    if (event.key === "Escape") {
      closePollModal();
    } else {
      trapFocusInModal(modal, event);
    }
    return;
  }

  if (!usernameModal.hidden) {
    if (event.key === "Escape" && canDismissUsernameModal) {
      closeUsernameModal(true);
    } else {
      trapFocusInModal(usernameModal, event);
    }
    return;
  }

  if (event.key === "Escape" && sidebarEl.classList.contains("open")) {
    closeSidebar(true);
  }
});

pollForm.onsubmit = (e) => {
  e.preventDefault();
  clearPollError();

  const question = pollQuestionInput.value.trim();
  const seen = new Set();
  const options = [];
  for (const part of pollOptionsInput.value.split(",")) {
    const cleaned = part.trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      options.push(cleaned);
    }
  }

  if (!question) {
    showPollError("Pertanyaan polling tidak boleh kosong.");
    pollQuestionInput.focus();
    return;
  }
  if (options.length < 2) {
    showPollError("Masukkan minimal 2 opsi unik yang dipisahkan dengan koma.");
    pollOptionsInput.focus();
    return;
  }
  if (options.length > MAX_POLL_OPTIONS) {
    showPollError(`Maksimal ${MAX_POLL_OPTIONS} opsi per polling.`);
    pollOptionsInput.focus();
    return;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        event: "create-poll",
        question,
        options,
        room: currentRoom,
      }),
    );
    pollForm.reset();
    closePollModal();
  }
};

function renderPoll(poll) {
  if (poll.id !== activePollId) {
    activePollId = poll.id;
    isPollCollapsed = false;
  }

  const userVote = getUserVoteOption(poll);
  const hasVoted = userVote !== null;
  const isClosed = poll.status === "closed";
  const showResults = hasVoted || isClosed;

  pinnedPollEl.replaceChildren();
  pinnedPollEl.hidden = false;

  const box = document.createElement("div");
  box.className = "poll-box";

  const counts = poll.options.map((opt) =>
    Array.isArray(poll.votes[opt]) ? poll.votes[opt].length : 0
  );
  const totalVotes = counts.reduce((sum, n) => sum + n, 0);
  const maxVotes = counts.length > 0 ? Math.max(...counts) : 0;

  const header = document.createElement("div");
  header.className = "poll-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "poll-title-group";

  const questionRow = document.createElement("div");
  questionRow.className = "poll-question-row";

  const title = document.createElement("strong");
  title.className = "poll-question";
  title.textContent = poll.question;

  const statusBadge = document.createElement("span");
  statusBadge.className = isClosed
    ? "poll-status-badge poll-status-closed"
    : "poll-status-badge poll-status-open";
  statusBadge.textContent = isClosed ? "[Polling Ditutup]" : "[Terbuka]";

  questionRow.appendChild(title);
  questionRow.appendChild(statusBadge);

  const meta = document.createElement("span");
  meta.className = "poll-meta";
  meta.textContent = `Oleh ${poll.createdBy} | ${totalVotes} suara`;

  titleGroup.appendChild(questionRow);
  titleGroup.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "poll-header-actions";

  if (!isClosed && poll.createdBy === myUsername) {
    const closePollBtn = document.createElement("button");
    closePollBtn.type = "button";
    closePollBtn.className = "poll-close-btn";
    closePollBtn.textContent = "Tutup Polling";
    closePollBtn.onclick = () => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify({ event: "close-poll", room: currentRoom }));
    };
    actions.appendChild(closePollBtn);
  }

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "poll-toggle-btn";
  toggleBtn.setAttribute("aria-expanded", String(!isPollCollapsed));
  toggleBtn.textContent = isPollCollapsed ? "Tampilkan" : "Sembunyikan";
  toggleBtn.onclick = () => {
    isPollCollapsed = !isPollCollapsed;
    renderPoll(poll);
  };
  actions.appendChild(toggleBtn);

  header.appendChild(titleGroup);
  header.appendChild(actions);
  box.appendChild(header);

  if (!isPollCollapsed) {
    const body = document.createElement("div");
    body.className = "poll-body";

    if (!isClosed && hasVoted) {
      const hint = document.createElement("p");
      hint.className = "poll-hint";
      hint.textContent = "Klik opsi lain jika ingin mengubah pilihan Anda.";
      body.appendChild(hint);
    }

    const optionsList = document.createElement("div");
    optionsList.className = "poll-options-list";

    for (const option of poll.options) {
      const voters = Array.isArray(poll.votes[option]) ? poll.votes[option] : [];
      const voteCount = voters.length;
      const percentage = totalVotes > 0
        ? Math.round((voteCount / totalVotes) * 100)
        : 0;
      const isChosen = option === userVote;
      const isWinner = isClosed && maxVotes > 0 && voteCount === maxVotes;

      const optionWrap = document.createElement("div");
      optionWrap.className = "poll-option-item";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "poll-option-btn";
      if (isChosen) {
        btn.classList.add("poll-option-selected");
        btn.setAttribute("aria-pressed", "true");
      } else {
        btn.setAttribute("aria-pressed", "false");
      }
      if (isWinner) {
        btn.classList.add("poll-option-winner");
      }
      btn.disabled = isClosed;

      if (showResults) {
        const bar = document.createElement("span");
        bar.className = "poll-progress-bar";
        bar.style.width = `${percentage}%`;
        bar.setAttribute("aria-hidden", "true");
        btn.appendChild(bar);
      }

      const tags = [];
      if (isChosen) tags.push("[Pilihan Anda]");
      if (isWinner) tags.push("[Terbanyak]");

      const labelSpan = document.createElement("span");
      labelSpan.className = "poll-option-label";
      labelSpan.textContent = tags.length > 0
        ? `${option} ${tags.join(" ")}`
        : option;

      const countSpan = document.createElement("span");
      countSpan.className = "poll-option-count";
      countSpan.textContent = showResults
        ? `${voteCount} suara (${percentage}%)`
        : `${voteCount} suara`;

      btn.appendChild(labelSpan);
      btn.appendChild(countSpan);

      btn.onclick = () => {
        if (isClosed || isChosen || !socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }
        socket.send(
          JSON.stringify({
            event: "vote",
            option,
            room: currentRoom,
          }),
        );
      };

      optionWrap.appendChild(btn);

      const voterList = document.createElement("small");
      voterList.className = "poll-voters";
      voterList.textContent = voters.length > 0
        ? `Pemilih: ${voters.join(", ")}`
        : "Belum ada pemilih";
      optionWrap.appendChild(voterList);

      optionsList.appendChild(optionWrap);
    }

    body.appendChild(optionsList);
    box.appendChild(body);
  }

  pinnedPollEl.appendChild(box);
}

function updateRoomList(rooms) {
  const roomList = document.getElementById("rooms");
  roomList.replaceChildren();

  for (const room of rooms) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "room-btn";

    if (room.name === currentRoom) {
      btn.classList.add("active-room");
      btn.setAttribute("aria-current", "true");
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "room-btn-name";
    nameSpan.textContent = `#${room.name}`;
    btn.appendChild(nameSpan);

    const badges = document.createElement("span");
    badges.className = "room-btn-badges";

    const unread = unreadCounts.get(room.name) || 0;
    if (unread > 0 && room.name !== currentRoom) {
      const unreadBadge = document.createElement("span");
      unreadBadge.className = "room-badge room-badge-unread";
      unreadBadge.textContent = `+${unread}`;
      unreadBadge.setAttribute("aria-label", `${unread} aktivitas belum dibaca`);
      badges.appendChild(unreadBadge);
    }

    if (room.hasActivePoll) {
      const pollBadge = document.createElement("span");
      pollBadge.className = "room-badge room-badge-poll";
      pollBadge.textContent = "Poll";
      badges.appendChild(pollBadge);
    }

    const countBadge = document.createElement("span");
    countBadge.className = "room-badge room-badge-count";
    countBadge.textContent = String(room.memberCount);
    countBadge.setAttribute("aria-label", `${room.memberCount} anggota`);
    badges.appendChild(countBadge);

    btn.appendChild(badges);
    btn.onclick = () => switchToRoom(room.name);

    li.appendChild(btn);
    roomList.appendChild(li);
  }
}

setControlsEnabled(false);
updateHeaderUsername();
if (myUsername) {
  connectSocket(myUsername);
} else {
  setConnectionStatus("disconnected");
  setConversationState("Masukkan nama pengguna untuk bergabung ke chat.", "empty");
  openUsernameModal("", false);
}
