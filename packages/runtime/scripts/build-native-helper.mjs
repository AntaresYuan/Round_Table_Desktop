import {
  copyFile,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(scriptDirectory, "..");

if (process.platform !== "darwin") {
  process.stdout.write("[runtime:native] macOS helpers skipped on non-Darwin host\n");
  process.exit(0);
}

if (process.arch !== "x64" && process.arch !== "arm64") {
  throw new Error(`Unsupported macOS architecture: ${process.arch}`);
}

const nativePrograms = [
  {
    name: "roundtable-macos-process-helper",
    source: "roundtable-macos-process-helper.c",
    linkerArguments: ["-lproc"],
    smokeArguments: ["inspect", `${process.pid}`],
    smokeValid(result) {
      const expectedPrefix = `INSPECT ${process.pid} `;
      return result.stdout.startsWith(expectedPrefix)
        && /^INSPECT \d+ \d+ \d+ \d+\n$/.test(result.stdout);
    },
  },
  {
    name: "roundtable-macos-boundary-probe",
    source: "roundtable-macos-boundary-probe.c",
    linkerArguments: [],
    smokeArguments: ["procargs", `${process.pid}`, "build-native-helper.mjs"],
    smokeValid(result) {
      return result.stdout === "allowed\n";
    },
  },
  {
    name: "roundtable-service-uid-admin-helper",
    source: "roundtable-service-uid-admin-helper.c",
    linkerArguments: ["-framework", "Security"],
    smokeArguments: ["--self-test"],
    smokeValid(result) {
      return result.stdout === "roundtable-service-uid-admin-helper self-test ok\n";
    },
  },
  {
    name: "roundtable-service-uid-authorization-launcher",
    source: "roundtable-service-uid-authorization-launcher.c",
    linkerArguments: ["-framework", "Security"],
    smokeArguments: ["--self-test"],
    smokeValid(result) {
      return result.stdout === "roundtable-service-uid-authorization-launcher self-test ok\n";
    },
  },
];

const architectureDirectory = join(packageDirectory, "native", "bin", process.arch);
const distributionDirectory = join(packageDirectory, "dist", "native");
const uniqueSuffix = `${process.pid}-${Date.now()}`;
await Promise.all([
  mkdir(architectureDirectory, { recursive: true }),
  mkdir(distributionDirectory, { recursive: true }),
]);

for (const program of nativePrograms) {
  const sourcePath = join(packageDirectory, "native", program.source);
  const architectureOutput = join(architectureDirectory, program.name);
  const distributionOutput = join(distributionDirectory, program.name);
  const architectureTemporary = `${architectureOutput}.tmp-${uniqueSuffix}`;
  const distributionTemporary = `${distributionOutput}.tmp-${uniqueSuffix}`;

  try {
    const compile = spawnSync(
      "xcrun",
      [
        "clang",
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-mmacosx-version-min=13.0",
        sourcePath,
        "-o",
        architectureTemporary,
        ...program.linkerArguments,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    if (compile.error) throw compile.error;
    if (compile.status !== 0) {
      throw new Error(
        `Native helper compilation failed (${compile.status ?? "signal"}):\n${compile.stderr}`,
      );
    }

    await chmod(architectureTemporary, 0o755);
    const smokeTest = spawnSync(architectureTemporary, program.smokeArguments, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (
      smokeTest.error
      || smokeTest.status !== 0
      || smokeTest.stderr !== ""
      || !program.smokeValid(smokeTest)
    ) {
      throw new Error(
        `Native helper ABI smoke test failed for ${program.name}:\n${smokeTest.stderr}${smokeTest.stdout}`,
      );
    }

    await rename(architectureTemporary, architectureOutput);
    await copyFile(architectureOutput, distributionTemporary);
    await chmod(distributionTemporary, 0o755);
    await rename(distributionTemporary, distributionOutput);

    const outputStat = await stat(distributionOutput);
    if (!outputStat.isFile() || (outputStat.mode & 0o111) === 0) {
      throw new Error(`Native helper output is not executable: ${program.name}`);
    }
    process.stdout.write(`[runtime:native] built ${architectureOutput}\n`);
  } finally {
    await rm(architectureTemporary, { force: true });
    await rm(distributionTemporary, { force: true });
  }
}

const manifestOutput = join(packageDirectory, "src", "native-helper-manifest.ts");
const manifestTemporary = `${manifestOutput}.tmp-${uniqueSuffix}`;
const architectureManifests = {};
for (const architecture of ["arm64", "x64"]) {
  const entries = {};
  let present = 0;
  for (const program of nativePrograms) {
    const output = join(
      packageDirectory,
      "native",
      "bin",
      architecture,
      program.name,
    );
    try {
      const [bytes, outputStat] = await Promise.all([
        readFile(output),
        stat(output),
      ]);
      if (!outputStat.isFile() || (outputStat.mode & 0o111) === 0) {
        throw new Error(`Native helper output is not executable: ${output}`);
      }
      entries[program.name] = {
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      present += 1;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (present !== 0 && present !== nativePrograms.length) {
    throw new Error(`Native helper manifest is incomplete for ${architecture}`);
  }
  if (present === nativePrograms.length) architectureManifests[architecture] = entries;
}
if (!architectureManifests[process.arch]) {
  throw new Error(`Native helper manifest is missing current architecture: ${process.arch}`);
}
function renderManifestEntries(programName) {
  const lines = [];
  for (const architecture of ["arm64", "x64"]) {
    const entry = architectureManifests[architecture]?.[programName];
    if (!entry) continue;
    lines.push(
      `  ${architecture}: Object.freeze({`,
      `    size: ${entry.size},`,
      `    sha256: '${entry.sha256}',`,
      "  }),",
    );
  }
  return lines;
}
const manifestSource = [
  "// Generated by scripts/build-native-helper.mjs. Do not edit by hand.",
  "export type NativeHelperManifestEntry = Readonly<{",
  "  size: number;",
  "  sha256: string;",
  "}>;",
  "",
  "export const NATIVE_HELPER_MANIFEST: Readonly<Record<string, NativeHelperManifestEntry>> = Object.freeze({",
  ...renderManifestEntries("roundtable-macos-process-helper"),
  "});",
  "",
  "export const NATIVE_BOUNDARY_PROBE_MANIFEST: Readonly<Record<string, NativeHelperManifestEntry>> = Object.freeze({",
  ...renderManifestEntries("roundtable-macos-boundary-probe"),
  "});",
  "",
  "export const NATIVE_ADMINISTRATOR_HELPER_MANIFEST: Readonly<Record<string, NativeHelperManifestEntry>> = Object.freeze({",
  ...renderManifestEntries("roundtable-service-uid-admin-helper"),
  "});",
  "",
  "export const NATIVE_AUTHORIZATION_LAUNCHER_MANIFEST: Readonly<Record<string, NativeHelperManifestEntry>> = Object.freeze({",
  ...renderManifestEntries("roundtable-service-uid-authorization-launcher"),
  "});",
  "",
].join("\n");
try {
  await writeFile(manifestTemporary, manifestSource, {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
  await rename(manifestTemporary, manifestOutput);
} finally {
  await rm(manifestTemporary, { force: true });
}
