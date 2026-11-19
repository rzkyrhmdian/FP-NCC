import { assertEquals, assertExists } from "@std/assert";
import ChatServer, { ClientSocket } from "./ChatServer.ts";
import { JsonFileStorage, MemoryStorage } from "./ChatStorage.ts";

class MockSocket implements ClientSocket {
  public readyState = 1; // OPEN
  public onopen: ((ev: Event) => unknown) | null = null;
  public onclose: ((ev: CloseEvent) => unknown) | null = null;
  public onmessage: ((ev: MessageEvent) => unknown) | null = null;
  public sent: Record<string, unknown>[] = [];
  public closeCode: number | null = null;
  public closeReason: string | null = null;

  public send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  public close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? "";
  }

  public emitMessage(payload: unknown): void {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    this.onmessage?.({ data: raw } as MessageEvent);
  }

  public disconnect(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000 } as CloseEvent);
  }

  public lastEvent(eventName: string): Record<string, unknown> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      if (this.sent[i].event === eventName) {
        return this.sent[i];
      }
    }
    return undefined;
  }

  public clearSent(): void {
    this.sent = [];
  }
}

Deno.test("rejects empty, reserved, and duplicate usernames with code 1008", async () => {
  const server = new ChatServer({ storage: new MemoryStorage(), persistDebounceMs: 0 });
  await server.init();

  const emptySocket = new MockSocket();
  assertEquals(server.attachClient("   ", emptySocket), false);
  assertEquals(emptySocket.closeCode, 1008);

  const systemSocket = new MockSocket();
  assertEquals(server.attachClient("System", systemSocket), false);
  assertEquals(systemSocket.closeCode, 1008);

  const alice1 = new MockSocket();
  assertEquals(server.attachClient("Alice", alice1), true);

  const aliceDup = new MockSocket();
  assertEquals(server.attachClient("alice", aliceDup), false);
  assertEquals(aliceDup.closeCode, 1008);

  assertEquals(server.getStats().onlineUsers, 1);
  await server.dispose();
});

Deno.test("handles malformed payloads without crashing and sends structured errors", async () => {
  const server = new ChatServer({ storage: new MemoryStorage(), persistDebounceMs: 0 });
  await server.init();

  const alice = new MockSocket();
  server.attachClient("Alice", alice);
  alice.clearSent();

  alice.emitMessage("{bad json");
  assertEquals(alice.lastEvent("error")?.code, "INVALID_JSON");

  alice.emitMessage([1, 2, 3]);
  assertEquals(alice.lastEvent("error")?.code, "INVALID_PAYLOAD");

  alice.emitMessage({ event: "send-message", message: "a".repeat(1001) });
  assertEquals(alice.lastEvent("error")?.code, "MESSAGE_TOO_LONG");

  await server.dispose();
});

Deno.test("room creation, switching, unread activity, and disconnect cleanup", async () => {
  const server = new ChatServer({ storage: new MemoryStorage(), persistDebounceMs: 0 });
  await server.init();

  const alice = new MockSocket();
  const bob = new MockSocket();
  server.attachClient("Alice", alice);
  server.attachClient("Bob", bob);
  alice.clearSent();
  bob.clearSent();

  // Create room with spaces -> normalized slug
  alice.emitMessage({ event: "create-room", room: "Backend Dev" });
  assertEquals(alice.lastEvent("room-created")?.room, "backend-dev");

  // Duplicate room rejected
  alice.emitMessage({ event: "create-room", room: "backend-dev" });
  assertEquals(alice.lastEvent("error")?.code, "ROOM_EXISTS");

  // Alice switches to backend-dev while Bob stays in global
  alice.emitMessage({ event: "switch-room", room: "backend-dev" });
  const state = alice.lastEvent("room-state");
  assertEquals(state?.room, "backend-dev");
  assertEquals(state?.memberCount, 1);

  bob.clearSent();
  alice.emitMessage({ event: "send-message", message: "Halo tim backend", room: "backend-dev" });
  // Bob does not receive backend-dev chat body, only lightweight room-activity notification
  assertEquals(bob.lastEvent("send-message"), undefined);
  assertEquals(bob.lastEvent("room-activity")?.room, "backend-dev");

  // Disconnect cleanup
  alice.disconnect();
  bob.disconnect();
  assertEquals(server.getStats().onlineUsers, 0);

  await server.dispose();
});

Deno.test("poll isolation per room, option dedup, change vote, and creator-only close", async () => {
  const server = new ChatServer({ storage: new MemoryStorage(), persistDebounceMs: 0 });
  await server.init();

  const alice = new MockSocket();
  const bob = new MockSocket();
  server.attachClient("Alice", alice);
  server.attachClient("Bob", bob);

  alice.emitMessage({ event: "create-room", room: "design" });
  alice.emitMessage({
    event: "create-poll",
    question: "Makan siang?",
    options: ["Soto", "soto", "Bakso", "Nasi Goreng"],
    room: "global",
  });

  const created = alice.lastEvent("poll-created")?.poll as Record<string, unknown>;
  assertExists(created);
  assertEquals(created.options, ["Soto", "Bakso", "Nasi Goreng"]);
  assertEquals(created.status, "open");

  // Bob votes Soto then changes vote to Bakso
  bob.emitMessage({ event: "vote", option: "Soto", room: "global" });
  bob.emitMessage({ event: "vote", option: "Bakso", room: "global" });
  const updated = alice.lastEvent("poll-updated")?.poll as Record<string, unknown>;
  const votes = updated.votes as Record<string, string[]>;
  assertEquals(votes["Soto"], []);
  assertEquals(votes["Bakso"], ["Bob"]);

  // Non-creator cannot close poll
  bob.clearSent();
  bob.emitMessage({ event: "close-poll", room: "global" });
  assertEquals(bob.lastEvent("error")?.code, "FORBIDDEN");

  // Creator closes poll
  alice.emitMessage({ event: "close-poll", room: "global" });
  const closed = bob.lastEvent("poll-updated")?.poll as Record<string, unknown>;
  assertEquals(closed.status, "closed");

  // Voting after close is rejected
  alice.clearSent();
  alice.emitMessage({ event: "vote", option: "Nasi Goreng", room: "global" });
  assertEquals(alice.lastEvent("error")?.code, "POLL_CLOSED");

  // Poll in design room stays isolated from global
  alice.emitMessage({ event: "switch-room", room: "design" });
  assertEquals(alice.lastEvent("room-state")?.poll, null);

  await server.dispose();
});

Deno.test("typing indicator broadcasts to peers only and heartbeat ping/pong works", async () => {
  const server = new ChatServer({
    storage: new MemoryStorage(),
    persistDebounceMs: 0,
    rateLimitMaxEvents: 3,
    rateLimitWindowMs: 5000,
  });
  await server.init();

  const alice = new MockSocket();
  const bob = new MockSocket();
  server.attachClient("Alice", alice);
  server.attachClient("Bob", bob);
  alice.clearSent();
  bob.clearSent();

  // Heartbeat does not consume rate limit
  for (let i = 0; i < 5; i += 1) {
    alice.emitMessage({ event: "ping" });
  }
  assertEquals(alice.lastEvent("pong")?.event, "pong");

  // Typing goes to Bob, not echoed to Alice
  alice.emitMessage({ event: "typing", isTyping: true });
  assertEquals(alice.lastEvent("user-typing"), undefined);
  assertEquals(bob.lastEvent("user-typing")?.username, "Alice");
  assertEquals(bob.lastEvent("user-typing")?.isTyping, true);

  // Sending a message clears typing state
  alice.emitMessage({ event: "send-message", message: "Pesan 1" });
  assertEquals(bob.lastEvent("user-typing")?.isTyping, false);

  // Rate limit triggers after exceeding 3 stateful events in window
  alice.emitMessage({ event: "send-message", message: "Pesan 2" });
  alice.emitMessage({ event: "send-message", message: "Pesan 3" });
  alice.emitMessage({ event: "send-message", message: "Pesan 4" });
  assertEquals(alice.lastEvent("error")?.code, "RATE_LIMITED");

  await server.dispose();
});

Deno.test("JsonFileStorage persists rooms, messages, and polls across server restarts", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = `${tempDir}/chat-state.json`;

  try {
    const storage1 = new JsonFileStorage(filePath);
    const server1 = new ChatServer({ storage: storage1, persistDebounceMs: 0 });
    await server1.init();

    const alice = new MockSocket();
    server1.attachClient("Alice", alice);
    alice.emitMessage({ event: "create-room", room: "kuliah" });
    alice.emitMessage({ event: "switch-room", room: "kuliah" });
    alice.emitMessage({ event: "send-message", message: "Catatan pertemuan 7" });
    alice.emitMessage({
      event: "create-poll",
      question: "Jadwal demo?",
      options: ["Senin", "Selasa"],
      room: "kuliah",
    });
    alice.emitMessage({ event: "vote", option: "Selasa", room: "kuliah" });
    await server1.dispose();

    // Restart with a brand new server instance
    const storage2 = new JsonFileStorage(filePath);
    const server2 = new ChatServer({ storage: storage2, persistDebounceMs: 0 });
    await server2.init();

    const bob = new MockSocket();
    server2.attachClient("Bob", bob);
    bob.emitMessage({ event: "switch-room", room: "kuliah" });

    const roomState = bob.lastEvent("room-state");
    assertExists(roomState);
    const messages = roomState.messages as { message: string }[];
    assertEquals(messages.length, 1);
    assertEquals(messages[0].message, "Catatan pertemuan 7");

    const poll = roomState.poll as Record<string, unknown>;
    assertExists(poll);
    assertEquals(poll.question, "Jadwal demo?");
    assertEquals((poll.votes as Record<string, string[]>)["Selasa"], ["Alice"]);

    await server2.dispose();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
