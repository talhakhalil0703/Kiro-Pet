import * as esbuild from "esbuild";

await esbuild.build({
  bundle: true,
  entryPoints: ["test/session-monitor.test.ts"],
  format: "cjs",
  logLevel: "info",
  minify: false,
  outdir: "dist-test",
  platform: "node",
  sourcemap: true,
  target: "node20"
});
