const myUsername = prompt("Please enter your name") || "Anonymous";
localStorage.setItem("username", myUsername);

const url = new URL(`./start_web_socket?username=${myUsername}`, location.href);
url.protocol = url.protocol.replace("http", "ws");
const socket = new WebSocket(url);

let currentPoll = null;
let hasVoted = false;
let pollElement = null;
let currentRoom = "global";

socket.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.event) {
    case "update-users":
      updateUserList(data.usernames);
      break;
    case "update-rooms":
      updateRoomList(data.rooms);
      break;
    case "send-message":
      if (data.room === currentRoom) {
        addMessage(data.username, data.message);
      }
      break;
    case "poll-created":
      if (data.room === currentRoom) {
        hasVoted = false;
        renderPoll(data.poll);
      }
      break;
    case "poll-updated":
      if (data.room === currentRoom) {
        renderPoll(data.poll);
      }
      break;
  }
};

function updateUserList(usernames) {
  const userList = document.getElementById("users");
  userList.replaceChildren();
  for (const username of usernames) {
    const listItem = document.createElement("li");
    listItem.textContent = username;
    userList.appendChild(listItem);
  }
}

function addMessage(username, message) {
  const template = document.getElementById("message");
  const clone = template.content.cloneNode(true);
  clone.querySelector("span").textContent = username;
  clone.querySelector("p").textContent = message;
  document.getElementById("conversation").prepend(clone);
}

const inputElement = document.getElementById("data");
inputElement.focus();

const form = document.getElementById("form");
form.onsubmit = (e) => {
  e.preventDefault();
  const message = inputElement.value;
  inputElement.value = "";
  socket.send(
    JSON.stringify({ event: "send-message", message, room: currentRoom })
  );
};

document.getElementById("room-form").onsubmit = (e) => {
  e.preventDefault();
  const roomName = document.getElementById("room-name").value.trim();
  if (roomName) {
    socket.send(JSON.stringify({ event: "create-room", room: roomName }));
    document.getElementById("room-form").reset();
  }
};

const modal = document.getElementById("poll-section");
const pollBtn = document.getElementById("show-poll-btn");
const crtBtn = document.getElementById("create-poll-btn");
const span = document.getElementsByClassName("close")[0];

// Show modal when poll button is clicked
pollBtn.onclick = function() {
  modal.style.display = "block";
}

// Close modal when X is clicked
span.onclick = function() {
  modal.style.display = "none";
}

// Close modal when create poll button is clicked
crtBtn.onclick = function() {
  modal.style.display = "none";
}

// Close modal when clicking outside
globalThis.onclick = function(event) {
  if (event.target == modal) {
    modal.style.display = "none";
  }
}


document.getElementById("poll-form").onsubmit = (e) => {
  e.preventDefault();

  const question = document.getElementById("poll-question").value;
  const rawOptions = document.getElementById("poll-options").value;
  const options = rawOptions
    .split(",")
    .map((opt) => opt.trim())
    .filter((opt) => opt);

  if (question && options.length >= 2) {
    socket.send(JSON.stringify({
      event: "create-poll",
      question,
      options,
      room: currentRoom
    }));
  }

  e.target.reset();
};

// Fungsi untuk menampilkan polling
function renderPoll(poll) {
  currentPoll = poll;

  // Buat elemen jika belum ada
  if (!pollElement) {
    pollElement = document.createElement("div");
    pollElement.classList.add("poll-box");
    document.getElementById("conversation").prepend(pollElement);
  }

  // Reset konten
  pollElement.innerHTML = "";

  const title = document.createElement("strong");
  title.textContent = `Poll by ${poll.createdBy}: ${poll.question}`;
  pollElement.appendChild(title);

  for (const option of poll.options) {
    const btn = document.createElement("button");
    btn.textContent = `${option} (${poll.votes[option].length})`;
    btn.disabled = hasVoted;

    btn.onclick = () => {
      if (hasVoted) return;
      hasVoted = true;
      socket.send(JSON.stringify({ 
        event: "vote", 
        option, 
        room: currentRoom
      }));
    };


    pollElement.appendChild(btn);

    // Tambahkan daftar voter
    const voterList = document.createElement("small");
    const voters = poll.votes[option];
    if (voters.length > 0) {
      voterList.textContent = "Voters: " + voters.join(", ");
    } else {
      voterList.textContent = "No voters yet";
    }
    pollElement.appendChild(voterList);
  }
}

function updateRoomList(rooms) {
  const roomList = document.getElementById("rooms");
  roomList.replaceChildren();

  for (const room of rooms) {
    const li = document.createElement("li");
    li.textContent = room;
    li.style.cursor = "pointer";
    if (room === currentRoom) {
      li.style.fontWeight = "bold";
    }
    li.onclick = () => {
      currentRoom = room;
      socket.send(JSON.stringify({ event: "switch-room", room }));
    };
    roomList.appendChild(li);
  }
}

