const savedName = localStorage.getItem("username") || "";
const promptedName = prompt("Masukkan nama pengguna Anda:", savedName);
const myUsername = (promptedName && promptedName.trim()) || "Anonymous";
localStorage.setItem("username", myUsername);

const url = new URL(`./start_web_socket?username=${encodeURIComponent(myUsername)}`, location.href);
url.protocol = url.protocol.replace("http", "ws");
const socket = new WebSocket(url);

let currentPoll = null;
let hasVoted = false;
let currentRoom = "global";
let knownRooms = ["global"];

const conversationEl = document.getElementById("conversation");
const pinnedPollEl = document.getElementById("pinned-poll");
const headerRoomEl = document.getElementById("header-room");
const inputElement = document.getElementById("data");
const modal = document.getElementById("poll-section");
const pollBtn = document.getElementById("show-poll-btn");
const closeModalBtn = document.getElementById("close-poll-modal");
const pollQuestionInput = document.getElementById("poll-question");

function formatTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
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

function setConversationState(text, kind) {
  conversationEl.replaceChildren();
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
  currentPoll = null;
  hasVoted = false;
  pinnedPollEl.replaceChildren();
  pinnedPollEl.hidden = true;
}

function updateRoomHeader(room) {
  headerRoomEl.textContent = `#${room}`;
  inputElement.placeholder = `Tulis pesan untuk #${room}...`;
}

setConversationState("Menghubungkan ke server dan memuat pesan room...", "loading");

socket.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.event) {
    case "update-users":
      updateUserList(data.usernames);
      break;
    case "update-rooms":
      knownRooms = Array.isArray(data.rooms) ? data.rooms : ["global"];
      updateRoomList(knownRooms);
      break;
    case "room-state":
      if (data.room === currentRoom) {
        conversationEl.replaceChildren();
        clearPoll();

        if (Array.isArray(data.messages) && data.messages.length > 0) {
          for (const msg of data.messages) {
            addMessage(msg.username, msg.message, msg.timestamp, msg.type || "chat");
          }
        } else {
          setConversationState(
            "Belum ada percakapan di room ini. Kirim pesan pertama untuk memulai diskusi.",
            "empty"
          );
        }

        if (data.poll) {
          renderPoll(data.poll);
        }
      }
      break;
    case "send-message":
      if (data.room === currentRoom) {
        addMessage(data.username, data.message, data.timestamp, data.type || "chat");
      }
      break;
    case "poll-created":
    case "poll-updated":
      if (data.room === currentRoom && data.poll) {
        renderPoll(data.poll);
      }
      break;
  }
};

function updateUserList(usernames) {
  const userList = document.getElementById("users");
  const userCountEl = document.getElementById("user-count");
  userList.replaceChildren();
  userCountEl.textContent = String(usernames.length);

  for (const username of usernames) {
    const listItem = document.createElement("li");
    listItem.textContent = username === myUsername ? `${username} (Anda)` : username;
    if (username === myUsername) {
      listItem.classList.add("current-user");
    }
    userList.appendChild(listItem);
  }
}

function addMessage(username, message, timestamp, type = "chat") {
  clearConversationState();
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

  const formattedTime = formatTime(timestamp);
  timeEl.textContent = formattedTime;
  if (timestamp) {
    timeEl.setAttribute("datetime", new Date(timestamp).toISOString());
  }
  bodyEl.textContent = message;

  conversationEl.prepend(clone);
}

inputElement.focus();

const form = document.getElementById("form");
form.onsubmit = (e) => {
  e.preventDefault();
  const message = inputElement.value.trim();
  if (!message || socket.readyState !== WebSocket.OPEN) return;
  inputElement.value = "";
  socket.send(
    JSON.stringify({ event: "send-message", message, room: currentRoom })
  );
};

document.getElementById("room-form").onsubmit = (e) => {
  e.preventDefault();
  const roomInput = document.getElementById("room-name");
  const roomName = roomInput.value.trim();
  if (roomName && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ event: "create-room", room: roomName }));
    document.getElementById("room-form").reset();
  }
};

function openPollModal() {
  modal.hidden = false;
  pollQuestionInput.focus();
}

function closePollModal() {
  if (modal.hidden) return;
  modal.hidden = true;
  pollBtn.focus();
}

pollBtn.addEventListener("click", openPollModal);
closeModalBtn.addEventListener("click", closePollModal);

modal.addEventListener("click", (event) => {
  if (event.target === modal) {
    closePollModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !modal.hidden) {
    closePollModal();
  }
});

document.getElementById("poll-form").onsubmit = (e) => {
  e.preventDefault();

  const question = pollQuestionInput.value.trim();
  const rawOptions = document.getElementById("poll-options").value;
  const options = rawOptions
    .split(",")
    .map((opt) => opt.trim())
    .filter((opt) => opt);

  if (question && options.length >= 2 && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      event: "create-poll",
      question,
      options,
      room: currentRoom,
    }));
    e.target.reset();
    closePollModal();
  }
};

function renderPoll(poll) {
  currentPoll = poll;
  const userVote = getUserVoteOption(poll);
  hasVoted = userVote !== null;

  pinnedPollEl.replaceChildren();
  pinnedPollEl.hidden = false;

  const box = document.createElement("div");
  box.className = "poll-box";

  const totalVotes = poll.options.reduce(
    (sum, opt) => sum + (Array.isArray(poll.votes[opt]) ? poll.votes[opt].length : 0),
    0
  );

  const header = document.createElement("div");
  header.className = "poll-header";

  const title = document.createElement("strong");
  title.className = "poll-question";
  title.textContent = poll.question;

  const meta = document.createElement("span");
  meta.className = "poll-meta";
  meta.textContent = `Oleh ${poll.createdBy} | ${totalVotes} suara`;

  header.appendChild(title);
  header.appendChild(meta);
  box.appendChild(header);

  const optionsList = document.createElement("div");
  optionsList.className = "poll-options-list";

  for (const option of poll.options) {
    const voters = Array.isArray(poll.votes[option]) ? poll.votes[option] : [];
    const voteCount = voters.length;
    const percentage = totalVotes > 0 ? Math.round((voteCount / totalVotes) * 100) : 0;
    const isChosen = option === userVote;

    const optionWrap = document.createElement("div");
    optionWrap.className = "poll-option-item";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "poll-option-btn";
    if (isChosen) {
      btn.classList.add("poll-option-selected");
    }
    btn.disabled = hasVoted;

    if (hasVoted) {
      const bar = document.createElement("span");
      bar.className = "poll-progress-bar";
      bar.style.width = `${percentage}%`;
      bar.setAttribute("aria-hidden", "true");
      btn.appendChild(bar);
    }

    const labelSpan = document.createElement("span");
    labelSpan.className = "poll-option-label";
    labelSpan.textContent = isChosen ? `${option} [Pilihan Anda]` : option;

    const countSpan = document.createElement("span");
    countSpan.className = "poll-option-count";
    countSpan.textContent = hasVoted
      ? `${voteCount} suara (${percentage}%)`
      : `${voteCount} suara`;

    btn.appendChild(labelSpan);
    btn.appendChild(countSpan);

    btn.onclick = () => {
      if (hasVoted || socket.readyState !== WebSocket.OPEN) return;
      hasVoted = true;
      socket.send(JSON.stringify({
        event: "vote",
        option,
        room: currentRoom,
      }));
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

  box.appendChild(optionsList);
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
    btn.textContent = `#${room}`;

    if (room === currentRoom) {
      btn.classList.add("active-room");
      btn.setAttribute("aria-current", "true");
    }

    btn.onclick = () => {
      if (room === currentRoom) return;
      currentRoom = room;
      updateRoomHeader(room);
      clearPoll();
      setConversationState(`Memuat pesan untuk #${room}...`, "loading");
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event: "switch-room", room }));
      }
      updateRoomList(rooms);
    };

    li.appendChild(btn);
    roomList.appendChild(li);
  }
}
