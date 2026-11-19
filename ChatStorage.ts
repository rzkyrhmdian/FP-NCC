export type PersistedPoll = {
  id: string;
  question: string;
  options: string[];
  votes: Record<string, string[]>;
  createdBy: string;
  room: string;
  status: "open" | "closed";
  createdAt: number;
  closedAt?: number;
};

export type PersistedMessage = {
  username: string;
  message: string;
  room: string;
  timestamp: number;
  type: "chat" | "system";
};

export type PersistedRoom = {
  name: string;
  poll: PersistedPoll | null;
  messages: PersistedMessage[];
};

export type PersistedState = {
  version: number;
  rooms: PersistedRoom[];
};

export interface ChatStorage {
  load(): Promise<PersistedState | null>;
  save(state: PersistedState): Promise<void>;
}

export class MemoryStorage implements ChatStorage {
  private state: PersistedState | null = null;

  public load(): Promise<PersistedState | null> {
    if (!this.state) return Promise.resolve(null);
    return Promise.resolve(structuredClone(this.state));
  }

  public save(state: PersistedState): Promise<void> {
    this.state = structuredClone(state);
    return Promise.resolve();
  }
}

export class JsonFileStorage implements ChatStorage {
  private filePath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  public async load(): Promise<PersistedState | null> {
    try {
      const raw = await Deno.readTextFile(this.filePath);
      const parsed = JSON.parse(raw);
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.rooms)
      ) {
        return null;
      }
      return parsed as PersistedState;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        return null;
      }
      console.error("Failed to load persisted state:", err);
      return null;
    }
  }

  public save(state: PersistedState): Promise<void> {
    const serialized = JSON.stringify(state, null, 2);
    const next = this.writeQueue.then(async () => {
      const dir = this.getParentDir(this.filePath);
      if (dir) {
        await Deno.mkdir(dir, { recursive: true });
      }
      const tempPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await Deno.writeTextFile(tempPath, serialized);
        await Deno.rename(tempPath, this.filePath);
      } catch (err) {
        try {
          await Deno.remove(tempPath);
        } catch {
          // Ignore cleanup errors for missing temp files.
        }
        throw err;
      }
    });

    this.writeQueue = next.catch((err) => {
      console.error("Failed to persist chat state:", err);
    });
    return next;
  }

  private getParentDir(path: string): string {
    const normalized = path.replaceAll("\\", "/");
    const lastSlash = normalized.lastIndexOf("/");
    if (lastSlash <= 0) return "";
    return normalized.slice(0, lastSlash);
  }
}
