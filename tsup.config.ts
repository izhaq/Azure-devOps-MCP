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
  // Bundle ALL dependencies into dist/index.js so the output is self-contained:
  // no node_modules folder needed at runtime. This is required for air-gapped
  // deployments where the only transfer mechanism is git bundle (which excludes
  // node_modules). noExternal overrides tsup's default of leaving node packages
  // external on platform:node.
  noExternal: [/.*/],
  // Preserve the shebang in src/index.ts so the bin is directly executable.
  banner: { js: "" },
});
