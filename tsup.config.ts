import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  dts: false,
  // undici is Node's built-in fetch implementation; mark external so esbuild
  // doesn't try to bundle it (it ships with Node ≥ 18).
  external: ["undici"],
  // Preserve the shebang in src/index.ts so the bin is directly executable.
  banner: { js: "" },
});
