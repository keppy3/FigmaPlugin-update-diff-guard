import esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

mkdirSync("dist", { recursive: true });

/** @type {esbuild.BuildOptions} */
const codeOptions = {
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "dist/code.js",
  format: "iife",
  target: "es2019",
  logLevel: "info",
};

/** @type {esbuild.BuildOptions} */
const uiOptions = {
  entryPoints: ["src/ui.ts"],
  bundle: true,
  write: false,
  format: "iife",
  target: "es2019",
  logLevel: "info",
};

function buildUiHtml(jsText) {
  const template = readFileSync("src/ui.html", "utf8");
  const html = template.replace(
    "<!-- BUNDLED_SCRIPT -->",
    `<script>\n${jsText}\n</script>`
  );
  writeFileSync("dist/ui.html", html, "utf8");
}

async function buildOnce() {
  await esbuild.build(codeOptions);
  const uiResult = await esbuild.build(uiOptions);
  const jsText = uiResult.outputFiles[0].text;
  buildUiHtml(jsText);
  console.log("Build complete: dist/code.js, dist/ui.html");
}

async function watchAll() {
  const codeCtx = await esbuild.context(codeOptions);
  const uiCtx = await esbuild.context({
    ...uiOptions,
    plugins: [
      {
        name: "inline-ui-html",
        setup(build) {
          build.onEnd((result) => {
            if (result.outputFiles && result.outputFiles[0]) {
              buildUiHtml(result.outputFiles[0].text);
              console.log("Rebuilt dist/ui.html");
            }
          });
        },
      },
    ],
  });
  await codeCtx.watch();
  await uiCtx.watch();
  console.log("Watching for changes... (Ctrl+C to stop)");
}

if (watch) {
  await watchAll();
} else {
  await buildOnce();
}
