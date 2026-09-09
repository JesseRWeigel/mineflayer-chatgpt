import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

export const AUDIO_RETENTION_MAX_FILES = 10;
export const AUDIO_RETENTION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

const MAX_ALLOCATION_ATTEMPTS = 32;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AudioFileStoreOptions {
  createId?: () => string;
  maxFiles?: number;
  maxAgeMs?: number;
  now?: () => number;
}

export class AudioReservation {
  private settled = false;

  constructor(
    readonly filename: string,
    readonly filepath: string,
    private readonly handle: FileHandle,
    private readonly onSettled: () => void,
  ) {}

  async write(audio: Buffer): Promise<void> {
    if (this.settled) throw new Error("Audio reservation is already closed");
    await this.handle.truncate(0);
    await this.handle.writeFile(audio);
    await this.handle.sync();
  }

  async release(): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    try {
      await this.handle.close();
    } finally {
      this.onSettled();
    }
  }

  async discard(): Promise<void> {
    if (this.settled) return;
    await this.release();
    try {
      await unlink(this.filepath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

/**
 * Allocates generated speech files without deriving the next name from disk.
 *
 * UUID candidates are created with the filesystem's exclusive-create flag, so
 * a collision is retried rather than overwriting an existing clip. Retention
 * uses mtime metadata for both UUID and legacy filenames and skips every file
 * with an active reservation.
 */
export class AudioFileStore {
  private readonly activeFiles = new Set<string>();
  private readonly createId: () => string;
  private readonly maxFiles: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(
    readonly directory: string,
    options: AudioFileStoreOptions = {},
  ) {
    this.createId = options.createId ?? randomUUID;
    this.maxFiles = options.maxFiles ?? AUDIO_RETENTION_MAX_FILES;
    this.maxAgeMs = options.maxAgeMs ?? AUDIO_RETENTION_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  async reserve(): Promise<AudioReservation> {
    await mkdir(this.directory, { recursive: true });

    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; attempt += 1) {
      const id = this.createId();
      if (!UUID_PATTERN.test(id)) {
        throw new Error("Audio IDs must be UUIDs");
      }
      const filename = "thought-" + id + ".mp3";
      const filepath = path.join(this.directory, filename);

      try {
        const handle = await open(filepath, "wx");
        this.activeFiles.add(filepath);
        return new AudioReservation(filename, filepath, handle, () => {
          this.activeFiles.delete(filepath);
        });
      } catch (error) {
        if (isAlreadyExists(error)) continue;
        throw error;
      }
    }

    throw new Error("Could not allocate a unique TTS audio filename");
  }

  async cleanup(): Promise<string[]> {
    await mkdir(this.directory, { recursive: true });
    const filenames = (await readdir(this.directory)).filter(isGeneratedAudioFilename);
    const entries = (
      await Promise.all(
        filenames.map(async (filename) => {
          const filepath = path.join(this.directory, filename);
          try {
            const metadata = await stat(filepath);
            return { filename, filepath, mtimeMs: metadata.mtimeMs };
          } catch (error) {
            if (isMissingFile(error)) return null;
            throw error;
          }
        }),
      )
    )
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.filename.localeCompare(b.filename));

    const removed = new Set<string>();
    const remove = async (filepath: string): Promise<void> => {
      if (this.activeFiles.has(filepath) || removed.has(filepath)) return;
      try {
        await unlink(filepath);
        removed.add(filepath);
      } catch (error) {
        if (!isMissingFile(error)) throw error;
        removed.add(filepath);
      }
    };

    const expiry = this.now() - this.maxAgeMs;
    for (const entry of entries) {
      if (entry.mtimeMs < expiry) await remove(entry.filepath);
    }

    let remaining = entries.length - removed.size;
    for (const entry of entries) {
      if (remaining <= this.maxFiles) break;
      const removedBefore = removed.size;
      await remove(entry.filepath);
      if (removed.size > removedBefore) remaining -= 1;
    }

    return entries.filter((entry) => removed.has(entry.filepath)).map((entry) => entry.filename);
  }
}

/** Save a provider stream without exposing the live provider in tests. */
export async function saveAudioStream(stream: Readable, store: AudioFileStore): Promise<string> {
  const reservation = await store.reserve();
  let keep = false;

  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    await reservation.write(Buffer.concat(chunks));
    await store.cleanup();
    keep = true;
    return "/audio/" + reservation.filename;
  } finally {
    if (keep) await reservation.release();
    else await reservation.discard();
  }
}

function isGeneratedAudioFilename(filename: string): boolean {
  return filename.startsWith("thought-") && filename.endsWith(".mp3");
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
