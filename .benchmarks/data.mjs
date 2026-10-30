import { existsSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The benchmarks' data is not in this repository. It is in the Hugging Face dataset below, a folder for each benchmark, and
// `hf download` puts it in .benchmarks/hf/, which git ignores. Each benchmark reads and writes its data in .benchmarks/hf/<name>/.
export const DATASET = 'perchscan/benchmark-results';
const HF = fileURLToPath(new URL('hf/', import.meta.url));

/** The folder a benchmark's data is read from. */
export const dataDir = name => path.join(HF, name);

/** The command that downloads a benchmark's data into .benchmarks/hf/, written relative to the working directory. */
export const downloadCommand = name => `hf download ${DATASET} --repo-type dataset --include '${name}/*' --local-dir ${path.relative(process.cwd(), HF) || '.'}`;

/** A benchmark's data folder. If any of `files` is missing from it, prints how to download the data and exits 2. */
export function needData(name, files) {
  const dir = dataDir(name), missing = files.find(file => !existsSync(path.join(dir, file)));
  if (!missing) return dir;
  // Written synchronously, since exiting straight after can cut short a write to a pipe.
  writeSync(2, [
    `${path.relative(process.cwd(), path.join(dir, missing))} is missing.`,
    `The ${name} data is on Hugging Face, at https://huggingface.co/datasets/${DATASET}. Download it with:`,
    '',
    `  ${downloadCommand(name)}`,
    '',
  ].join('\n'));
  process.exit(2);
}
