import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { AudioFileStore, saveAudioStream } from "./audio-files.js";

const ID_A = "00000000-0000-4000-8000-000000000001";
const ID_B = "00000000-0000-4000-8000-000000000002";

async function temporaryAudioDirectory(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "swarm-audio-"));
}

test("concurrent reservations cannot allocate the same audio path", async () => {
  const directory = await temporaryAudioDirectory();
  const ids = [ID_A, ID_A, ID_B];
  const store = new AudioFileStore(directory, {
    createId: () => ids.shift() ?? ID_B,
  });

  const [first, second] = await Promise.all([store.reserve(), store.reserve()]);

  assert.notEqual(first.filename, second.filename);
  assert.deepEqual((await readdir(directory)).sort(), [first.filename, second.filename].sort());
  await Promise.all([first.discard(), second.discard()]);
});

test("legacy numeric and scientific-notation files do not affect allocation", async () => {
  const directory = await temporaryAudioDirectory();
  const legacy = ["thought-9007199254740993.mp3", "thought-1.0009203275524804e+21.mp3"];
  await Promise.all(legacy.map((filename) => writeFile(path.join(directory, filename), filename)));

  const store = new AudioFileStore(directory, { createId: () => ID_A });
  const reservation = await store.reserve();
  await reservation.write(Buffer.from("new audio"));
  await reservation.release();

  assert.equal(reservation.filename, "thought-" + ID_A + ".mp3");
  assert.deepEqual((await readdir(directory)).sort(), [...legacy, reservation.filename].sort());
});

test("a restarted store preserves an existing clip and retries a colliding ID", async () => {
  const directory = await temporaryAudioDirectory();
  const firstStore = new AudioFileStore(directory, { createId: () => ID_A });
  const first = await firstStore.reserve();
  await first.write(Buffer.from("first audio"));
  await first.release();

  const ids = [ID_A, ID_B];
  const restartedStore = new AudioFileStore(directory, {
    createId: () => ids.shift() ?? ID_B,
  });
  const second = await restartedStore.reserve();
  await second.write(Buffer.from("second audio"));
  await second.release();

  assert.equal(await readFile(first.filepath, "utf8"), "first audio");
  assert.equal(await readFile(second.filepath, "utf8"), "second audio");
  assert.notEqual(first.filepath, second.filepath);
});

test("cleanup applies age and count limits by mtime without deleting an active clip", async () => {
  const directory = await temporaryAudioDirectory();
  const now = Date.UTC(2026, 8, 8, 12);
  const oldNumeric = path.join(directory, "thought-99999.mp3");
  const recentScientific = path.join(directory, "thought-1e+21.mp3");
  await writeFile(oldNumeric, "old");
  await writeFile(recentScientific, "recent");
  await utimes(oldNumeric, new Date(now - 20_000), new Date(now - 20_000));
  await utimes(recentScientific, new Date(now - 1_000), new Date(now - 1_000));

  const store = new AudioFileStore(directory, {
    createId: () => ID_A,
    maxFiles: 1,
    maxAgeMs: 10_000,
    now: () => now,
  });
  const active = await store.reserve();
  await active.write(Buffer.from("active"));
  await utimes(active.filepath, new Date(now - 20_000), new Date(now - 20_000));

  await store.cleanup();

  assert.equal(await readFile(active.filepath, "utf8"), "active");
  assert.deepEqual(await readdir(directory), [active.filename]);
  await active.release();
});

test("a mocked TTS stream is saved through an exclusive reservation", async () => {
  const directory = await temporaryAudioDirectory();
  const store = new AudioFileStore(directory, { createId: () => ID_A });
  const audioStream = Readable.from([Buffer.from("mock "), Buffer.from("speech")]);

  const url = await saveAudioStream(audioStream, store);

  assert.equal(url, "/audio/thought-" + ID_A + ".mp3");
  const filepath = path.join(directory, "thought-" + ID_A + ".mp3");
  assert.equal(await readFile(filepath, "utf8"), "mock speech");
  assert.equal((await stat(filepath)).size, 11);
});

test("a failed mocked TTS stream removes its exclusive placeholder", async () => {
  const directory = await temporaryAudioDirectory();
  const store = new AudioFileStore(directory, { createId: () => ID_A });
  const audioStream = new Readable({
    read() {
      this.destroy(new Error("mock provider failure"));
    },
  });

  await assert.rejects(saveAudioStream(audioStream, store), /mock provider failure/);

  assert.deepEqual(await readdir(directory), []);
});
