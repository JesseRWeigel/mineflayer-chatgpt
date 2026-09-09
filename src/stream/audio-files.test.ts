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
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [path.basename(first.stagingFilepath), path.basename(second.stagingFilepath)].sort(),
  );
  await Promise.all([first.discard(), second.discard()]);
});

test("legacy numeric and scientific-notation files do not affect allocation", async () => {
  const directory = await temporaryAudioDirectory();
  const legacy = ["thought-9007199254740993.mp3", "thought-1.0009203275524804e+21.mp3"];
  await Promise.all(legacy.map((filename) => writeFile(path.join(directory, filename), filename)));

  const store = new AudioFileStore(directory, { createId: () => ID_A });
  const reservation = await store.reserve();
  await reservation.write(Buffer.from("new audio"));
  await reservation.publish();

  assert.equal(reservation.filename, "thought-" + ID_A + ".mp3");
  assert.deepEqual((await readdir(directory)).sort(), [...legacy, reservation.filename].sort());
});

test("a restarted store preserves an existing clip and retries a colliding ID", async () => {
  const directory = await temporaryAudioDirectory();
  const firstStore = new AudioFileStore(directory, { createId: () => ID_A });
  const first = await firstStore.reserve();
  await first.write(Buffer.from("first audio"));
  await first.publish();

  const ids = [ID_A, ID_B];
  const restartedStore = new AudioFileStore(directory, {
    createId: () => ids.shift() ?? ID_B,
  });
  const second = await restartedStore.reserve();
  await second.write(Buffer.from("second audio"));
  await second.publish();

  assert.equal(await readFile(first.filepath, "utf8"), "first audio");
  assert.equal(await readFile(second.filepath, "utf8"), "second audio");
  assert.notEqual(first.filepath, second.filepath);
});

test("cleanup from another store cannot remove an in-progress clip", async () => {
  const directory = await temporaryAudioDirectory();
  const writer = new AudioFileStore(directory, { createId: () => ID_A });
  const cleaner = new AudioFileStore(directory, {
    maxFiles: 0,
    maxAgeMs: 0,
    minAgeMs: 0,
    now: () => Date.now() + 60_000,
  });
  const reservation = await writer.reserve();
  await reservation.write(Buffer.from("active audio"));

  await cleaner.cleanup();
  await reservation.publish();

  assert.equal(await readFile(reservation.filepath, "utf8"), "active audio");
  assert.deepEqual(await readdir(directory), [reservation.filename]);
});

test("cleanup applies age, count, and minimum-age policies using mtime", async () => {
  const directory = await temporaryAudioDirectory();
  const now = Date.UTC(2026, 8, 8, 12);
  const oldNumeric = path.join(directory, "thought-99999.mp3");
  const trimScientific = path.join(directory, "thought-1e+21.mp3");
  const recent = path.join(directory, "thought-" + ID_A + ".mp3");
  await writeFile(oldNumeric, "old");
  await writeFile(trimScientific, "trim");
  await writeFile(recent, "recent");
  await utimes(oldNumeric, new Date(now - 20_000), new Date(now - 20_000));
  await utimes(trimScientific, new Date(now - 5_000), new Date(now - 5_000));
  await utimes(recent, new Date(now - 1_000), new Date(now - 1_000));

  const store = new AudioFileStore(directory, {
    maxFiles: 1,
    maxAgeMs: 10_000,
    minAgeMs: 2_000,
    now: () => now,
  });

  await store.cleanup();

  assert.deepEqual(await readdir(directory), [path.basename(recent)]);
});

test("a mocked TTS stream is saved through exclusive publication", async () => {
  const directory = await temporaryAudioDirectory();
  const store = new AudioFileStore(directory, { createId: () => ID_A });
  const audioStream = Readable.from([Buffer.from("mock "), Buffer.from("speech")]);

  const url = await saveAudioStream(audioStream, store);

  assert.equal(url, "/audio/thought-" + ID_A + ".mp3");
  const filepath = path.join(directory, "thought-" + ID_A + ".mp3");
  assert.equal(await readFile(filepath, "utf8"), "mock speech");
  assert.equal((await stat(filepath)).size, 11);
  assert.deepEqual(await readdir(directory), [path.basename(filepath)]);
});

test("a failed mocked TTS stream leaves no staging or published file", async () => {
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

test("count cleanup keeps completed clips during the overlay fetch grace period", async () => {
  const directory = await temporaryAudioDirectory();
  const now = Date.UTC(2026, 8, 8, 12);
  const recent = path.join(directory, "thought-" + ID_A + ".mp3");
  await writeFile(recent, "queued audio");
  await utimes(recent, new Date(now - 1_000), new Date(now - 1_000));
  const store = new AudioFileStore(directory, {
    maxFiles: 0,
    maxAgeMs: 10_000,
    minAgeMs: 2_000,
    now: () => now,
  });

  await store.cleanup();

  assert.equal(await readFile(recent, "utf8"), "queued audio");
});

test("exclusive publication never overwrites a final path created during generation", async () => {
  const directory = await temporaryAudioDirectory();
  const store = new AudioFileStore(directory, { createId: () => ID_A });
  const reservation = await store.reserve();
  await reservation.write(Buffer.from("new audio"));
  await writeFile(reservation.filepath, "existing audio");

  await assert.rejects(reservation.publish(), { code: "EEXIST" });

  assert.equal(await readFile(reservation.filepath, "utf8"), "existing audio");
  assert.deepEqual(await readdir(directory), [reservation.filename]);
});
