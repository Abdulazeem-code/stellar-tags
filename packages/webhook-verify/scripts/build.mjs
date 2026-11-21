import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const tsc = resolve(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

await rm(resolve(packageRoot, "dist"), { recursive: true, force: true });
await mkdir(resolve(packageRoot, "dist"), { recursive: true });
await build({
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  external: ["express"],
  format: "esm",
  outfile: resolve(packageRoot, "dist/index.js"),
});
await build({
  entryPoints: [resolve(packageRoot, "src/index.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  external: ["express"],
  format: "cjs",
  outfile: resolve(packageRoot, "dist/index.cjs"),
});
const { spawnSync } = await import("node:child_process");
const result = spawnSync(tsc, ["--project", resolve(packageRoot, "tsconfig.json")], {
  cwd: packageRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
