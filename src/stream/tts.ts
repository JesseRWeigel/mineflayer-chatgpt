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
let ttsReady = false;

// Voice options — pick one that sounds good for a chaotic game character
// en-US-GuyNeural is a male voice with good range
// en-US-ChristopherNeural is another solid male option
const VOICE = "en-US-GuyNeural";

async function getTTS(): Promise<MsEdgeTTS> {
  if (!ttsInstance) {
    ttsInstance = new MsEdgeTTS();
    await ttsInstance.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    ttsReady = true;
  }
  return ttsInstance;
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
        try { chunks.push(chunk); } catch { /* ignore */ }
      });
      audioStream.on("end", () => {
        try {
          fs.writeFileSync(filepath, Buffer.concat(chunks));
          resolve();
        } catch (e) { reject(e); }
      });
      audioStream.on("error", reject);
    });

    // Clean up old audio files (keep last 10)
    const files = fs.readdirSync(AUDIO_DIR)
      .filter(f => f.startsWith("thought-") && f.endsWith(".mp3"))
      .sort();
    while (files.length > 10) {
      const old = files.shift()!;
      fs.unlinkSync(path.join(AUDIO_DIR, old));
    }

    return `/audio/${filename}`;
  } catch (err) {
    console.error("[TTS] Error generating speech:", err);
    // Reset TTS instance on error so it can reconnect
    ttsInstance = null;
    ttsReady = false;
    return null;
  }
}
