// scripts/download-voyager-skills.mjs
// Run: node scripts/download-voyager-skills.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "../skills/voyager");

const API_URL =
  "https://api.github.com/repos/MineDojo/Voyager/contents/skill_library/trial1/skill/code";

async function download() {
  console.log("Fetching Voyager skill list...");
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "minecraft-ai-streamer" },
  });

  if (!res.ok) {
    console.error(`GitHub API error: ${res.status} ${res.statusText}`);
    console.log("Manual fallback:");
    console.log("  git clone https://github.com/MineDojo/Voyager /tmp/voyager");
    console.log(`  cp /tmp/voyager/skill_library/trial1/skill/code/*.js ${OUTPUT_DIR}/`);
    process.exit(1);
  }

  const files = await res.json();
  const jsFiles = files.filter((f) => f.name.endsWith(".js"));
  console.log(`Found ${jsFiles.length} skills. Downloading...`);

  for (const file of jsFiles) {
    const codeRes = await fetch(file.download_url);
    const code = await codeRes.text();
    const dest = path.join(OUTPUT_DIR, file.name);
    fs.writeFileSync(dest, code);
    console.log(`  ✓ ${file.name}`);
  }

  console.log(`\nDownloaded ${jsFiles.length} Voyager skills to skills/voyager/`);
}

download().catch(console.error);
