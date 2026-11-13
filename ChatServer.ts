import { Context } from "@oak/oak";

type WebSocketWithUsername = WebSocket & { username: string };
type AppEvent = { event: string; [key: string]: unknown };
type Room = {
  name: string;
  members: Set<string>; // usernames
};

export default class ChatServer {
  private rooms: Map<string, Room> = new Map([
    ["global", { name: "global", members: new Set() }],
  ]);
  private userRooms = new Map<string, string>();
  private connectedClients = new Map<string, WebSocketWithUsername>();
  private currentPoll: {
    id: string;
    question: string;
    options: string[];
    votes: Record<string, string[]>; // array of voter names
    votedUsers: Set<string>; // untuk mencegah vote ganda
    createdBy: string;
    room: string;
  } | null = null;


  public async handleConnection(ctx: Context) {
    const socket = await ctx.upgrade() as WebSocketWithUsername;
    const rawUsername = ctx.request.url.searchParams.get("username");
    const username = rawUsername?.trim();

    if (!username || this.connectedClients.has(username)) {
      socket.close(1008, `Username ${username ?? ""} is already taken or invalid`);
      return;
    }

    socket.username = username;

    socket.onclose = () => this.clientDisconnected(socket.username);
    socket.onmessage = (m) => this.handleMessage(socket.username, m);

    this.connectedClients.set(username, socket);
    console.log(`New client connected: ${username}`);

    socket.onopen = () => {
      // Semua dilakukan saat socket sudah OPEN
      this.rooms.get("global")?.members.add(username);
      this.userRooms.set(username, "global");

      this.broadcastUsernames();

      socket.send(JSON.stringify({
        event: "update-rooms",
        rooms: [...this.rooms.keys()],
      }));

      // Kirim poll jika ada
      if (this.currentPoll) {
        socket.send(JSON.stringify({
          event: "poll-created",
          poll: this.serializePoll(this.currentPoll),
        }));
      }
    };
  }


  private handleMessage(username: string, message: MessageEvent) {
    if (typeof message.data !== "string") {
      return;
    }

    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message.data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.event !== "string") {
        console.error("Invalid WebSocket message structure from", username);
        return;
      }
      data = parsed as Record<string, unknown>;
    } catch (err) {
      console.error("Failed to parse WebSocket message from", username, err);
      return;
    }

    switch (data.event) {
      case "send-message": {
        if (typeof data.message !== "string" || data.message.trim().length === 0) {
          return;
        }
        const room = this.userRooms.get(username) || "global";
        this.broadcastToRoom(room, {
          event: "send-message",
          username,
          message: data.message.trim(),
          room,
        });
        break;
      }

      case "create-room": {
        if (typeof data.room !== "string" || data.room.trim().length === 0) {
          return;
        }
        const roomName = data.room.trim();
        if (!this.rooms.has(roomName)) {
          this.rooms.set(roomName, { name: roomName, members: new Set() });
          this.broadcast({ event: "update-rooms", rooms: [...this.rooms.keys()] });
        }
        break;
      }

      case "switch-room": {
        if (typeof data.room !== "string" || !this.rooms.has(data.room)) {
          return;
        }
        const prevRoom = this.userRooms.get(username);
        if (prevRoom) this.rooms.get(prevRoom)?.members.delete(username);

        this.userRooms.set(username, data.room);
        this.rooms.get(data.room)?.members.add(username);
        break;
      }

      case "create-poll": {
        if (
          typeof data.question !== "string" ||
          data.question.trim().length === 0 ||
          !Array.isArray(data.options) ||
          typeof data.room !== "string" ||
          !this.rooms.has(data.room)
        ) {
          return;
        }
        const options = data.options
          .filter((opt): opt is string => typeof opt === "string")
          .map((opt) => opt.trim())
          .filter((opt) => opt.length > 0);

        if (options.length < 2) {
          return;
        }

        this.currentPoll = {
          id: crypto.randomUUID(),
          question: data.question.trim(),
          options,
          votes: Object.fromEntries(options.map((opt) => [opt, []])),
          createdBy: username,
          room: data.room,
          votedUsers: new Set(),
        };
        this.broadcast({
          event: "poll-created",
          poll: this.serializePoll(this.currentPoll),
          room: data.room,
        });
        break;
      }

      case "vote": {
        if (typeof data.option !== "string" || typeof data.room !== "string") {
          return;
        }
        if (
          this.currentPoll &&
          this.currentPoll.room === data.room &&
          this.currentPoll.options.includes(data.option) &&
          !this.currentPoll.votedUsers.has(username)
        ) {
          console.log("Received vote from", username, "for", data.option, "in room", data.room);
          console.log("Current poll room is", this.currentPoll?.room);

          this.currentPoll.votes[data.option].push(username);
          this.currentPoll.votedUsers.add(username);
          this.broadcast({
            event: "poll-updated",
            poll: this.serializePoll(this.currentPoll),
            room: data.room,
          });
        }
        break;
      }
    }
  }

  private serializePoll(poll: NonNullable<typeof this.currentPoll>) {
    return {
      id: poll.id,
      question: poll.question,
      options: poll.options,
      createdBy: poll.createdBy,
      votes: poll.votes,
    };
  }

  private clientDisconnected(username: string) {
    this.connectedClients.delete(username);
    const room = this.userRooms.get(username);
    if (room) {
      this.rooms.get(room)?.members.delete(username);
      this.userRooms.delete(username);
    }
    for (const r of this.rooms.values()) {
      r.members.delete(username);
    }
    this.broadcastUsernames();
    console.log(`Client ${username} disconnected`);
  }

  private broadcastUsernames() {
    const usernames = [...this.connectedClients.keys()];
    this.broadcast({ event: "update-users", usernames });
    console.log("Sent username list:", JSON.stringify(usernames));
  }

  private broadcast(message: AppEvent) {
    const messageString = JSON.stringify(message);
    for (const client of this.connectedClients.values()) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageString);
      }
    }
  }

  private broadcastToRoom(room: string, message: AppEvent) {
    const messageStr = JSON.stringify(message);
    const members = this.rooms.get(room)?.members ?? new Set();

    for (const username of members) {
      const client = this.connectedClients.get(username);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    }
  }

}

