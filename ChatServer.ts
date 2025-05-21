import { Context } from "@oak/oak";

type WebSocketWithUsername = WebSocket & { username: string };
type AppEvent = { event: string; [key: string]: any };
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
    const username = ctx.request.url.searchParams.get("username");

    if (!username || this.connectedClients.has(username)) {
      socket.close(1008, `Username ${username} is already taken or invalid`);
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


  private handleMessage(username: string, message: any) {
    const data = JSON.parse(message.data);

    switch (data.event) {
      case "send-message":
        const room = this.userRooms.get(username) || "global";
        this.broadcastToRoom(room, {
          event: "send-message",
          username,
          message: data.message,
          room,
        });
        break;

      case "create-room":
        if (!this.rooms.has(data.room)) {
          this.rooms.set(data.room, { name: data.room, members: new Set() });
          this.broadcast({ event: "update-rooms", rooms: [...this.rooms.keys()] });
        }
        break;

      case "switch-room":
        const prevRoom = this.userRooms.get(username);
        if (prevRoom) this.rooms.get(prevRoom)?.members.delete(username);

        this.userRooms.set(username, data.room);
        this.rooms.get(data.room)?.members.add(username);
        break;

      case "create-poll":
        this.currentPoll = {
          id: crypto.randomUUID(),
          question: data.question,
          options: data.options,
          votes: Object.fromEntries(data.options.map((opt: string) => [opt, []])), // array kosong
          createdBy: username,
          room: data.room, // pastikan room juga dikirim
          votedUsers: new Set(), // tambahkan untuk mencegah double vote
        };
        this.broadcast({
          event: "poll-created",
          poll: this.serializePoll(this.currentPoll),
          room: data.room,
        });
        break;

      case "vote":
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
            poll: this.currentPoll,
            room: data.room,
          });
        }
        break;
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
      client.send(messageString);
    }
  }

  private broadcastToRoom(room: string, message: AppEvent) {
    const messageStr = JSON.stringify(message);
    const members = this.rooms.get(room)?.members ?? new Set();

    for (const username of members) {
      const client = this.connectedClients.get(username);
      if (client) {
        client.send(messageStr);
      }
    }
  }

}

