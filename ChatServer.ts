import { Context } from "@oak/oak";

type WebSocketWithUsername = WebSocket & { username: string };
type AppEvent = { event: string; [key: string]: any };

export default class ChatServer {
  private connectedClients = new Map<string, WebSocketWithUsername>();
  private currentPoll: {
    id: string;
    question: string;
    options: string[];
    votes: Record<string, string[]>; // opsi: [username1, username2]
    createdBy: string;
    votedUsers: Set<string>;
  } | null = null;

  public async handleConnection(ctx: Context) {
    const socket = await ctx.upgrade() as WebSocketWithUsername;
    const username = ctx.request.url.searchParams.get("username");

    if (!username || this.connectedClients.has(username)) {
      socket.close(1008, `Username ${username} is already taken or invalid`);
      return;
    }

    socket.username = username;
    socket.onopen = this.broadcastUsernames.bind(this);
    socket.onclose = () => this.clientDisconnected(socket.username);
    socket.onmessage = (m) => this.handleMessage(socket.username, m);

    this.connectedClients.set(username, socket);
    console.log(`New client connected: ${username}`);

    // Kirim poll yang sedang aktif (jika ada)
    if (this.currentPoll) {
      socket.send(JSON.stringify({
        event: "poll-created",
        poll: this.serializePoll(this.currentPoll),
      }));
    }
  }

  private handleMessage(username: string, message: any) {
    const data = JSON.parse(message.data);

    switch (data.event) {
      case "send-message":
        this.broadcast({
          event: "send-message",
          username,
          message: data.message,
        });
        break;

      case "create-poll":
        this.currentPoll = {
          id: crypto.randomUUID(),
          question: data.question,
          options: data.options,
          votes: Object.fromEntries(data.options.map((opt: string) => [opt, []])),
          createdBy: username,
          votedUsers: new Set(),
        };
        this.broadcast({
          event: "poll-created",
          poll: this.serializePoll(this.currentPoll),
        });
        break;

      case "vote":
        if (!this.currentPoll) return;

        const { option } = data;
        const { options, votes, votedUsers } = this.currentPoll;

        if (!options.includes(option)) return;
        if (votedUsers.has(username)) return;

        votes[option].push(username);
        votedUsers.add(username);

        this.broadcast({
          event: "poll-updated",
          poll: this.serializePoll(this.currentPoll),
        });
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
}
