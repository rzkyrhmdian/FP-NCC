import { Context } from "@oak/oak";
import {
  ChatStorage,
  MemoryStorage,
  PersistedPoll,
  PersistedState,
} from "./ChatStorage.ts";

export interface ClientSocket {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type ManagedSocket = ClientSocket & { username?: string };
type AppEvent = { event: string; [key: string]: unknown };

export type Poll = {
  id: string;
  question: string;
  options: string[];
  votes: Record<string, string[]>;
  votedUsers: Set<string>;
  createdBy: string;
  room: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
};

export type SerializedPoll = PersistedPoll;

export type ChatMessage = {
  username: string;
  message: string;
  room: string;
  timestamp: number;
  type: "chat" | "system";
};

export type RoomSummary = {
  name: string;
  memberCount: number;
  hasActivePoll: boolean;
};

export type UserSummary = {
  username: string;
  room: string;
};

export type ServerStats = {
  onlineUsers: number;
  roomsCount: number;
  activePolls: number;
};

type Room = {
  name: string;
  members: Set<string>;
  typingUsers: Set<string>;
  poll: Poll | null;
  messages: ChatMessage[];
};

export type ChatServerOptions = {
  storage?: ChatStorage;
  persistDebounceMs?: number;
  rateLimitMaxEvents?: number;
  rateLimitWindowMs?: number;
};

const MAX_ROOM_MESSAGES = 100;
const MAX_USERNAME_LENGTH = 30;
const MAX_ROOM_NAME_LENGTH = 32;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_POLL_QUESTION_LENGTH = 200;
const MAX_POLL_OPTIONS = 8;
const MAX_POLL_OPTION_LENGTH = 80;
const ROOM_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,31}$/;
const WS_OPEN = 1;

export default class ChatServer {
  private rooms: Map<string, Room> = new Map([
    [
      "global",
      {
        name: "global",
        members: new Set(),
        typingUsers: new Set(),
        poll: null,
        messages: [],
      },
    ],
  ]);
  private userRooms = new Map<string, string>();
  private connectedClients = new Map<string, ManagedSocket>();
  private rateLimitLog = new Map<string, number[]>();

  private storage: ChatStorage;
  private persistDebounceMs: number;
  private rateLimitMaxEvents: number;
  private rateLimitWindowMs: number;
  private persistTimer: number | null = null;
  private pendingPersist: Promise<void> = Promise.resolve();

  constructor(options: ChatServerOptions = {}) {
    this.storage = options.storage ?? new MemoryStorage();
    this.persistDebounceMs = options.persistDebounceMs ?? 150;
    this.rateLimitMaxEvents = options.rateLimitMaxEvents ?? 25;
    this.rateLimitWindowMs = options.rateLimitWindowMs ?? 5000;
  }

  public async init(): Promise<void> {
    const saved = await this.storage.load();
    if (!saved || !Array.isArray(saved.rooms)) return;

    for (const savedRoom of saved.rooms) {
      if (
        !savedRoom ||
        typeof savedRoom.name !== "string" ||
        !ROOM_NAME_PATTERN.test(savedRoom.name)
      ) {
        continue;
      }

      const hydratedMessages: ChatMessage[] = Array.isArray(savedRoom.messages)
        ? savedRoom.messages
          .filter(
            (m) =>
              m &&
              typeof m.username === "string" &&
              typeof m.message === "string" &&
              typeof m.timestamp === "number",
          )
          .slice(-MAX_ROOM_MESSAGES)
          .map((m) => ({
            username: m.username,
            message: m.message,
            room: savedRoom.name,
            timestamp: m.timestamp,
            type: m.type === "system" ? "system" : "chat",
          }))
        : [];

      let hydratedPoll: Poll | null = null;
      if (
        savedRoom.poll &&
        typeof savedRoom.poll.id === "string" &&
        typeof savedRoom.poll.question === "string" &&
        Array.isArray(savedRoom.poll.options) &&
        savedRoom.poll.options.length >= 2
      ) {
        const votedUsers = new Set<string>();
        const normalizedVotes: Record<string, string[]> = {};
        for (const opt of savedRoom.poll.options) {
          const voters = Array.isArray(savedRoom.poll.votes?.[opt])
            ? savedRoom.poll.votes[opt].filter(
              (v): v is string => typeof v === "string",
            )
            : [];
          normalizedVotes[opt] = voters;
          for (const voter of voters) {
            votedUsers.add(voter);
          }
        }
        hydratedPoll = {
          id: savedRoom.poll.id,
          question: savedRoom.poll.question,
          options: [...savedRoom.poll.options],
          votes: normalizedVotes,
          votedUsers,
          createdBy: typeof savedRoom.poll.createdBy === "string"
            ? savedRoom.poll.createdBy
            : "Unknown",
          room: savedRoom.name,
          status: savedRoom.poll.status === "closed" ? "closed" : "open",
          createdAt: typeof savedRoom.poll.createdAt === "number"
            ? savedRoom.poll.createdAt
            : Date.now(),
          ...(typeof savedRoom.poll.closedAt === "number"
            ? { closedAt: savedRoom.poll.closedAt }
            : {}),
        };
      }

      this.rooms.set(savedRoom.name, {
        name: savedRoom.name,
        members: new Set(),
        typingUsers: new Set(),
        poll: hydratedPoll,
        messages: hydratedMessages,
      });
    }

    if (!this.rooms.has("global")) {
      this.rooms.set("global", {
        name: "global",
        members: new Set(),
        typingUsers: new Set(),
        poll: null,
        messages: [],
      });
    }
  }

  public getStats(): ServerStats {
    let activePolls = 0;
    for (const room of this.rooms.values()) {
      if (room.poll && room.poll.status === "open") {
        activePolls += 1;
      }
    }
    return {
      onlineUsers: this.connectedClients.size,
      roomsCount: this.rooms.size,
      activePolls,
    };
  }

  public async flush(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      await this.writeStateNow();
    } else {
      await this.pendingPersist;
    }
  }

  public async dispose(): Promise<void> {
    await this.flush();
  }

  public async handleConnection(ctx: Context): Promise<void> {
    const socket = await ctx.upgrade() as ManagedSocket;
    const rawUsername = ctx.request.url.searchParams.get("username");
    this.attachClient(rawUsername, socket);
  }

  public attachClient(
    rawUsername: string | null,
    socket: ManagedSocket,
  ): boolean {
    const username = rawUsername?.trim() ?? "";

    if (
      !username ||
      username.length > MAX_USERNAME_LENGTH ||
      username.toLowerCase() === "system" ||
      this.hasActiveUsername(username)
    ) {
      socket.close(
        1008,
        `Username ${username} is already taken or invalid`,
      );
      return false;
    }

    socket.username = username;
    socket.onclose = () => this.clientDisconnected(username);
    socket.onmessage = (m) => this.handleMessage(username, m);

    this.connectedClients.set(username, socket);
    console.log(`New client connected: ${username}`);

    const onReady = () => {
      if (this.connectedClients.get(username) !== socket) return;

      this.rooms.get("global")?.members.add(username);
      this.userRooms.set(username, "global");

      this.broadcastUsers();
      this.broadcastRooms();
      this.sendRoomState(socket, "global");
      this.broadcastSystemMessage(
        "global",
        `${username} bergabung ke room #global`,
      );
    };

    if (socket.readyState === WS_OPEN) {
      onReady();
    } else {
      socket.onopen = onReady;
    }
    return true;
  }

  private hasActiveUsername(candidate: string): boolean {
    const lowered = candidate.toLowerCase();
    for (const existing of this.connectedClients.keys()) {
      if (existing.toLowerCase() === lowered) {
        return true;
      }
    }
    return false;
  }

  private isRateLimited(username: string): boolean {
    const now = Date.now();
    const cutoff = now - this.rateLimitWindowMs;
    const history = (this.rateLimitLog.get(username) ?? []).filter(
      (ts) => ts > cutoff,
    );
    if (history.length >= this.rateLimitMaxEvents) {
      this.rateLimitLog.set(username, history);
      return true;
    }
    history.push(now);
    this.rateLimitLog.set(username, history);
    return false;
  }

  private sendError(username: string, code: string, message: string): void {
    const socket = this.connectedClients.get(username);
    if (socket && socket.readyState === WS_OPEN) {
      socket.send(JSON.stringify({ event: "error", code, message }));
    }
  }

  private clearTyping(username: string, roomName: string): void {
    const room = this.rooms.get(roomName);
    if (!room || !room.typingUsers.has(username)) return;
    room.typingUsers.delete(username);
    this.broadcastToRoomExcept(roomName, username, {
      event: "user-typing",
      username,
      room: roomName,
      isTyping: false,
    });
  }

  private handleMessage(username: string, message: MessageEvent): void {
    if (typeof message.data !== "string") {
      return;
    }

    let data: Record<string, unknown>;
    try {
      const parsed = JSON.parse(message.data);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof parsed.event !== "string"
      ) {
        this.sendError(username, "INVALID_PAYLOAD", "Format pesan tidak valid.");
        return;
      }
      data = parsed as Record<string, unknown>;
    } catch {
      this.sendError(username, "INVALID_JSON", "Payload JSON tidak valid.");
      return;
    }

    if (data.event === "ping") {
      const socket = this.connectedClients.get(username);
      if (socket && socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({ event: "pong", timestamp: Date.now() }));
      }
      return;
    }

    if (data.event === "typing") {
      if (typeof data.isTyping !== "boolean") return;
      const roomName = this.userRooms.get(username) || "global";
      const room = this.rooms.get(roomName);
      if (!room) return;

      if (data.isTyping) {
        room.typingUsers.add(username);
      } else {
        room.typingUsers.delete(username);
      }
      this.broadcastToRoomExcept(roomName, username, {
        event: "user-typing",
        username,
        room: roomName,
        isTyping: data.isTyping,
      });
      return;
    }

    if (this.isRateLimited(username)) {
      this.sendError(
        username,
        "RATE_LIMITED",
        "Terlalu banyak aktivitas dalam waktu singkat. Tunggu sebentar.",
      );
      return;
    }

    switch (data.event) {
      case "send-message": {
        if (typeof data.message !== "string") {
          return;
        }
        const trimmedMessage = data.message.trim();
        if (trimmedMessage.length === 0) {
          return;
        }
        if (trimmedMessage.length > MAX_MESSAGE_LENGTH) {
          this.sendError(
            username,
            "MESSAGE_TOO_LONG",
            `Pesan maksimal ${MAX_MESSAGE_LENGTH} karakter.`,
          );
          return;
        }
        const room = this.userRooms.get(username) || "global";
        this.clearTyping(username, room);

        const chatMsg: ChatMessage = {
          username,
          message: trimmedMessage,
          room,
          timestamp: Date.now(),
          type: "chat",
        };
        const roomObj = this.rooms.get(room);
        if (roomObj) {
          roomObj.messages.push(chatMsg);
          if (roomObj.messages.length > MAX_ROOM_MESSAGES) {
            roomObj.messages.shift();
          }
          this.schedulePersist();
        }
        this.broadcastToRoom(room, {
          event: "send-message",
          ...chatMsg,
        });
        this.broadcastRoomActivity(room, username);
        break;
      }

      case "create-room": {
        if (typeof data.room !== "string") {
          return;
        }
        const normalized = data.room
          .trim()
          .toLowerCase()
          .replaceAll(/\s+/g, "-");
        if (
          normalized.length === 0 ||
          normalized.length > MAX_ROOM_NAME_LENGTH ||
          !ROOM_NAME_PATTERN.test(normalized)
        ) {
          this.sendError(
            username,
            "INVALID_ROOM_NAME",
            `Nama room hanya boleh huruf, angka, tanda hubung (-), atau garis bawah (_), maksimal ${MAX_ROOM_NAME_LENGTH} karakter.`,
          );
          return;
        }
        if (this.rooms.has(normalized)) {
          this.sendError(
            username,
            "ROOM_EXISTS",
            `Room #${normalized} sudah tersedia.`,
          );
          return;
        }

        this.rooms.set(normalized, {
          name: normalized,
          members: new Set(),
          typingUsers: new Set(),
          poll: null,
          messages: [],
        });
        this.schedulePersist();
        this.broadcastRooms();

        const socket = this.connectedClients.get(username);
        if (socket && socket.readyState === WS_OPEN) {
          socket.send(JSON.stringify({ event: "room-created", room: normalized }));
        }
        break;
      }

      case "switch-room": {
        if (typeof data.room !== "string" || !this.rooms.has(data.room)) {
          this.sendError(username, "ROOM_NOT_FOUND", "Room tujuan tidak ditemukan.");
          return;
        }
        const prevRoom = this.userRooms.get(username);
        if (prevRoom && prevRoom !== data.room) {
          this.clearTyping(username, prevRoom);
          this.rooms.get(prevRoom)?.members.delete(username);
        }

        this.userRooms.set(username, data.room);
        this.rooms.get(data.room)?.members.add(username);

        const socket = this.connectedClients.get(username);
        if (socket) {
          this.sendRoomState(socket, data.room);
        }

        if (prevRoom && prevRoom !== data.room) {
          this.broadcastRooms();
          this.broadcastUsers();
          this.broadcastSystemMessage(
            prevRoom,
            `${username} pindah ke room #${data.room}`,
          );
          this.broadcastSystemMessage(
            data.room,
            `${username} bergabung ke room #${data.room}`,
          );
        }
        break;
      }

      case "create-poll": {
        if (
          typeof data.question !== "string" ||
          !Array.isArray(data.options) ||
          typeof data.room !== "string" ||
          !this.rooms.has(data.room)
        ) {
          this.sendError(
            username,
            "INVALID_POLL",
            "Data polling tidak lengkap.",
          );
          return;
        }

        const question = data.question.trim();
        if (question.length === 0 || question.length > MAX_POLL_QUESTION_LENGTH) {
          this.sendError(
            username,
            "INVALID_POLL",
            `Pertanyaan polling harus 1 sampai ${MAX_POLL_QUESTION_LENGTH} karakter.`,
          );
          return;
        }

        const seen = new Set<string>();
        const options: string[] = [];
        for (const rawOpt of data.options) {
          if (typeof rawOpt !== "string") continue;
          const cleaned = rawOpt.trim();
          if (cleaned.length === 0 || cleaned.length > MAX_POLL_OPTION_LENGTH) {
            continue;
          }
          const key = cleaned.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            options.push(cleaned);
          }
        }

        if (options.length < 2 || options.length > MAX_POLL_OPTIONS) {
          this.sendError(
            username,
            "INVALID_POLL",
            `Polling membutuhkan 2 sampai ${MAX_POLL_OPTIONS} opsi unik (masing-masing maksimal ${MAX_POLL_OPTION_LENGTH} karakter).`,
          );
          return;
        }

        const targetRoomObj = this.rooms.get(data.room)!;
        const newPoll: Poll = {
          id: crypto.randomUUID(),
          question,
          options,
          votes: Object.fromEntries(options.map((opt) => [opt, []])),
          createdBy: username,
          room: data.room,
          votedUsers: new Set(),
          status: "open",
          createdAt: Date.now(),
        };
        targetRoomObj.poll = newPoll;
        this.schedulePersist();

        this.broadcastToRoom(data.room, {
          event: "poll-created",
          poll: this.serializePoll(newPoll),
          room: data.room,
        });
        this.broadcastRooms();
        this.broadcastRoomActivity(data.room, username);
        break;
      }

      case "vote": {
        if (typeof data.option !== "string" || typeof data.room !== "string") {
          return;
        }
        const roomObj = this.rooms.get(data.room);
        const poll = roomObj?.poll;
        if (!poll || !poll.options.includes(data.option)) {
          return;
        }
        if (poll.status === "closed") {
          this.sendError(
            username,
            "POLL_CLOSED",
            "Polling ini sudah ditutup dan tidak menerima suara baru.",
          );
          return;
        }

        let currentChoice: string | null = null;
        for (const [opt, voters] of Object.entries(poll.votes)) {
          if (voters.includes(username)) {
            currentChoice = opt;
            break;
          }
        }

        if (currentChoice === data.option) {
          return;
        }

        if (currentChoice !== null) {
          poll.votes[currentChoice] = poll.votes[currentChoice].filter(
            (v) => v !== username,
          );
        }

        poll.votes[data.option].push(username);
        poll.votedUsers.add(username);
        this.schedulePersist();

        this.broadcastToRoom(data.room, {
          event: "poll-updated",
          poll: this.serializePoll(poll),
          room: data.room,
        });
        break;
      }

      case "close-poll": {
        if (typeof data.room !== "string") {
          return;
        }
        const roomObj = this.rooms.get(data.room);
        const poll = roomObj?.poll;
        if (!poll || poll.status === "closed") {
          return;
        }
        if (poll.createdBy !== username) {
          this.sendError(
            username,
            "FORBIDDEN",
            "Hanya pembuat polling yang dapat menutup polling ini.",
          );
          return;
        }

        poll.status = "closed";
        poll.closedAt = Date.now();
        this.schedulePersist();

        this.broadcastToRoom(data.room, {
          event: "poll-updated",
          poll: this.serializePoll(poll),
          room: data.room,
        });
        this.broadcastRooms();
        break;
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistDebounceMs <= 0) {
      this.pendingPersist = this.writeStateNow();
      return;
    }
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.pendingPersist = this.writeStateNow();
    }, this.persistDebounceMs);
  }

  private writeStateNow(): Promise<void> {
    const state: PersistedState = {
      version: 1,
      rooms: [...this.rooms.values()].map((room) => ({
        name: room.name,
        poll: room.poll ? this.serializePoll(room.poll) : null,
        messages: room.messages,
      })),
    };
    return this.storage.save(state);
  }

  private sendRoomState(socket: ManagedSocket, roomName: string): void {
    const room = this.rooms.get(roomName);
    if (!room || socket.readyState !== WS_OPEN) return;

    socket.send(
      JSON.stringify({
        event: "room-state",
        room: roomName,
        messages: room.messages,
        poll: room.poll ? this.serializePoll(room.poll) : null,
        memberCount: room.members.size,
      }),
    );
  }

  private serializePoll(poll: Poll): SerializedPoll {
    return {
      id: poll.id,
      question: poll.question,
      options: poll.options,
      createdBy: poll.createdBy,
      votes: poll.votes,
      room: poll.room,
      status: poll.status,
      createdAt: poll.createdAt,
      ...(typeof poll.closedAt === "number" ? { closedAt: poll.closedAt } : {}),
    };
  }

  private clientDisconnected(username: string): void {
    this.connectedClients.delete(username);
    this.rateLimitLog.delete(username);
    const room = this.userRooms.get(username);
    if (room) {
      this.clearTyping(username, room);
      this.rooms.get(room)?.members.delete(username);
      this.userRooms.delete(username);
    }
    for (const r of this.rooms.values()) {
      r.members.delete(username);
      r.typingUsers.delete(username);
    }
    this.broadcastUsers();
    this.broadcastRooms();
    if (room) {
      this.broadcastSystemMessage(room, `${username} keluar dari chat`);
    }
    console.log(`Client ${username} disconnected`);
  }

  private broadcastSystemMessage(room: string, message: string): void {
    this.broadcastToRoom(room, {
      event: "send-message",
      username: "System",
      message,
      room,
      timestamp: Date.now(),
      type: "system",
    });
  }

  private broadcastRooms(): void {
    const rooms: RoomSummary[] = [...this.rooms.values()].map((room) => ({
      name: room.name,
      memberCount: room.members.size,
      hasActivePoll: Boolean(room.poll && room.poll.status === "open"),
    }));
    this.broadcast({ event: "update-rooms", rooms });
  }

  private broadcastUsers(): void {
    const usernames = [...this.connectedClients.keys()];
    const users: UserSummary[] = usernames.map((username) => ({
      username,
      room: this.userRooms.get(username) || "global",
    }));
    this.broadcast({ event: "update-users", usernames, users });
  }

  private broadcastRoomActivity(room: string, sender: string): void {
    const payload = JSON.stringify({
      event: "room-activity",
      room,
      from: sender,
    });
    for (const [username, client] of this.connectedClients.entries()) {
      if (
        username !== sender &&
        this.userRooms.get(username) !== room &&
        client.readyState === WS_OPEN
      ) {
        client.send(payload);
      }
    }
  }

  private broadcast(message: AppEvent): void {
    const messageString = JSON.stringify(message);
    for (const client of this.connectedClients.values()) {
      if (client.readyState === WS_OPEN) {
        client.send(messageString);
      }
    }
  }

  private broadcastToRoom(room: string, message: AppEvent): void {
    const messageStr = JSON.stringify(message);
    const members = this.rooms.get(room)?.members ?? new Set();

    for (const username of members) {
      const client = this.connectedClients.get(username);
      if (client && client.readyState === WS_OPEN) {
        client.send(messageStr);
      }
    }
  }

  private broadcastToRoomExcept(
    room: string,
    excludedUsername: string,
    message: AppEvent,
  ): void {
    const messageStr = JSON.stringify(message);
    const members = this.rooms.get(room)?.members ?? new Set();

    for (const username of members) {
      if (username === excludedUsername) continue;
      const client = this.connectedClients.get(username);
      if (client && client.readyState === WS_OPEN) {
        client.send(messageStr);
      }
    }
  }
}
