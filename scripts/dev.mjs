// Runs the API server (tsx watch) and the web dev server (vite) together.
import { spawn } from "node:child_process";
import process from "node:process";

const procs = [];

function run(name, cmd, args, color) {
  const child = spawn(cmd, args, {
    cwd: new URL(`../${name}/`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    shell: process.platform === "win32",
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  const tag = `\x1b[${color}m[${name}]\x1b[0m`;
  const pipe = (stream) =>
    stream.on("data", (chunk) =>
      chunk.toString().split("\n").filter(Boolean).forEach((l) => console.log(`${tag} ${l}`)),
    );
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => {
    console.log(`${tag} exited with code ${code}`);
    shutdown(code ?? 1);
  });
  procs.push(child);
}

function shutdown(code = 0) {
  for (const p of procs) {
    if (!p.killed) p.kill();
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("server", "npm", ["run", "dev"], "36"); // cyan
run("web", "npm", ["run", "dev"], "35"); // magenta
