import { spawn } from "node:child_process"
import { chmod, readFile, writeFile } from "node:fs/promises"

const child = spawn(
  "bun",
  ["build", "src/cli/main.ts", "--target=node", "--format=esm", "--outfile=dist/main.js"],
  { stdio: ["ignore", "ignore", "inherit"] },
)

const code = await new Promise((resolve, reject) => {
  child.on("error", reject)
  child.on("close", resolve)
})

if (code !== 0) {
  process.exitCode = typeof code === "number" ? code : 1
} else {
  const path = "dist/main.js"
  const content = await readFile(path, "utf8")
  const withNodeShebang = content.replace(/^#!.*\n/, "#!/usr/bin/env node\n")
  await writeFile(path, withNodeShebang, "utf8")
  await chmod(path, 0o755)
}
