import path from "node:path";

const TARGET_FILE = "gsuite.txt";

async function run() {
  const filePath = path.resolve(process.cwd(), TARGET_FILE);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    console.error(`❌ File '${TARGET_FILE}' nggak nemu di direktori!`);
    process.exit(1);
  }

  const rawContent = await file.text();
  const lines = rawContent.split(/\r?\n/);

  let sharedPassword = "";
  const results: string[] = [];

  // Cari password global di baris seperti "Password: cloudin123"
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const passMatch = line.match(/^(?:password|pass|pw)\s*[:=]\s*(.+)$/i);
    if (passMatch) {
      sharedPassword = passMatch[1].trim();
      break;
    }
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Skip baris deklarasi password di header
    if (/^(?:password|pass|pw)\s*[:=]/i.test(line)) continue;

    // Cek jika baris berisi format email:password langsung
    const inlineMatch = line.match(/^([^\s:|;]+@[^\s:|;]+)[:|;\t\s]+(.+)$/);

    if (inlineMatch) {
      const email = inlineMatch[1].trim();
      const password = inlineMatch[2].trim();
      results.push(`${email}:${password}`);
    } else if (line.includes("@")) {
      // Baris cuma email doang, tempelkan sharedPassword dari header
      const email = line.trim();
      if (sharedPassword) {
        results.push(`${email}:${sharedPassword}`);
      }
    }
  }

  await Bun.write(filePath, results.join("\n") + "\n");

  console.log(`✅ Berhasil format ${results.length} akun ke '${TARGET_FILE}'!`);
}

run();
