import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = path.join(__dirname, "../../overlay/audio");

// Ensure audio directory exists
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

let ttsInstance: MsEdgeTTS | null = null;
let initPromise: Promise<MsEdgeTTS> | null = null;

// Voice options — pick one that sounds good for a chaotic game character
// en-US-GuyNeural is a male voice with good range
// en-US-ChristopherNeural is another solid male option
const VOICE = "en-US-GuyNeural";

/**
 * Single-flight accessor for the shared Edge TTS connection.
 *
 * All five bot brains call generateSpeech() fire-and-forget, so this runs
 * concurrently. Without the shared initPromise every racer constructed its
 * own MsEdgeTTS and opened its own WebSocket to Microsoft, and all but one
 * were orphaned — an open TLS socket is a live libuv handle, so dropping the
 * last reference makes it unreachable AND immortal.
 *
 * ttsInstance is published only after setMetadata() resolves; exposing it
 * earlier makes concurrent toStream() calls throw "Speech synthesis not
 * configured yet".
 */
async function getTTS(): Promise<MsEdgeTTS> {
  if (ttsInstance) return ttsInstance;

  if (!initPromise) {
    initPromise = (async () => {
      const instance = new MsEdgeTTS();
      try {
        await instance.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      } catch (err) {
        // Never drop a half-open socket on the floor — it leaks permanently.
        closeQuietly(instance);
        throw err;
      }
      ttsInstance = instance;
      return instance;
    })().finally(() => {
      // Settled either way: successful callers now hit the ttsInstance fast
      // path, and a failed init leaves the slot clear for a fresh retry.
      initPromise = null;
    });
  }

  return initPromise;
}

function closeQuietly(instance: MsEdgeTTS | null): void {
  try {
    instance?.close();
  } catch {
    /* socket already dead — nothing to reclaim */
  }
}

/**
 * Tear down the shared connection so the next call reconnects cleanly.
 * Closing before dropping the reference is what prevents the socket leak.
 */
function discardTTS(): void {
  closeQuietly(ttsInstance);
  ttsInstance = null;
}

let audioCounter = 0;

/**
 * Generate a TTS audio file from text and return the filename.
 * Files are saved to overlay/audio/ and served via the overlay HTTP server.
 */
export async function generateSpeech(text: string): Promise<string | null> {
  try {
    const tts = await getTTS();
    const filename = `thought-${++audioCounter}.mp3`;
    const filepath = path.join(AUDIO_DIR, filename);

    const { audioStream } = tts.toStream(text);

    await new Promise<void>((resolve, reject) => {
      const chunks: Buffer[] = [];
      audioStream.on("data", (chunk: Buffer) => {
        try {
          chunks.push(chunk);
        } catch {
          /* ignore */
        }
      });
      audioStream.on("end", () => {
        try {
          fs.writeFileSync(filepath, Buffer.concat(chunks));
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      audioStream.on("error", reject);
    });

    // Clean up old audio files (keep last 10)
    const files = fs
      .readdirSync(AUDIO_DIR)
      .filter((f) => f.startsWith("thought-") && f.endsWith(".mp3"))
      .sort();
    while (files.length > 10) {
      const old = files.shift()!;
      fs.unlinkSync(path.join(AUDIO_DIR, old));
    }

    return `/audio/${filename}`;
  } catch (err) {
    console.error("[TTS] Error generating speech:", err);
    // Close before dropping the reference so the WebSocket is actually
    // reclaimed; the next call re-inits via getTTS().
    discardTTS();
    return null;
  }
}
