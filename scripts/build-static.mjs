import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const outputDirectory = path.join(projectRoot, "dist");

const frontendEntries = [
  "index.html",
  "style.css",
  "text-size.js",
  "agent-chat.js",
  "api.js",
  "app-bootstrap.js",
  "auth.js",
  "calibration-policy.js",
  "care-workflow.js",
  "clinical-ai-format.js",
  "exercise-library.js",
  "exercise-tracking.js",
  "fall-monitoring.js",
  "geometry.js",
  "hand-geometry.js",
  "i18n.js",
  "img",
  "main.js",
  "movement-measurements.js",
  "movement-quality.js",
  "personalization.js",
  "patient-dashboard.js",
  "patient-dashboard-state.js",
  "poses.js",
  "practice-access.js",
  "planned-session-progress.js",
  "runtime-config.js",
  "role-ui.js",
  "therapist.js",
  "therapist-triage-state.js",
  "ui.js",
  "voice-guidance.js",
  "wellness-screening.js",
  "exercises",
  "feedback",
];

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

for (const entry of frontendEntries) {
  await cp(
    path.join(projectRoot, entry),
    path.join(outputDirectory, entry),
    { recursive: true }
  );
}

async function verifyLocalModuleImports(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await verifyLocalModuleImports(entryPath);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    const source = await readFile(entryPath, "utf8");
    const imports = source.matchAll(/(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["'](\.[^"']+)["']/g);
    for (const match of imports) {
      const importPath = match[1].split("?")[0].split("#")[0];
      const resolvedPath = path.resolve(path.dirname(entryPath), importPath);
      try {
        await access(resolvedPath);
      } catch {
        throw new Error(
          `Static build is missing module ${importPath} imported by ${path.relative(outputDirectory, entryPath)}`
        );
      }
    }
  }
}

await verifyLocalModuleImports(outputDirectory);

const configuredApiBase = process.env.PHYSIOVISION_API_BASE?.trim();

if (configuredApiBase) {
  const apiUrl = new URL(configuredApiBase);
  const isLocalApi = ["localhost", "127.0.0.1"].includes(apiUrl.hostname);

  if (apiUrl.protocol !== "https:" && !isLocalApi) {
    throw new Error(
      "PHYSIOVISION_API_BASE must use HTTPS for a deployed website."
    );
  }

  const normalizedApiBase = configuredApiBase.replace(/\/+$/, "");
  await writeFile(
    path.join(outputDirectory, "runtime-config.js"),
    `window.PHYSIOVISION_API_BASE = ${JSON.stringify(normalizedApiBase)};\n`
  );
  console.log(`Configured production API: ${normalizedApiBase}`);
} else {
  console.warn(
    "PHYSIOVISION_API_BASE is not set; the build will use same-origin /api."
  );
}

console.log(`Built ${frontendEntries.length} frontend entries in dist/`);
