import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const serviceDirectory = path.dirname(fileURLToPath(import.meta.url));
const extractorPath = fileURLToPath(new URL('../../python/extract_document.py', import.meta.url));
const projectRoot = path.resolve(serviceDirectory, '..', '..');

function runPython(args, inputFile) {
  const configuredPython = process.env.PYTHON_BIN?.trim();
  const localPython = process.platform === 'win32'
    ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(projectRoot, '.venv', 'bin', 'python');
  const systemPython = process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python'];
  const candidates = [...(configuredPython ? [configuredPython] : []), localPython, ...systemPython];
  const pythonCandidates = [...new Set(candidates.map(candidate =>
    candidate.includes('/') || candidate.includes('\\')
      ? path.resolve(projectRoot, candidate)
      : candidate
  ))];
  const failures = [];
  return new Promise((resolve, reject) => {
    const start = index => {
      const python = pythonCandidates[index];
      const child = spawn(python, [extractorPath, '--file', inputFile, ...args], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      let spawnFailed = false;
      child.stdout.on('data', d => { out += d.toString(); });
      child.stderr.on('data', d => { err += d.toString(); });
      child.once('error', error => {
        spawnFailed = true;
        if (error.code === 'ENOENT') {
          failures.push(`${python}: not found`);
          if (index + 1 < pythonCandidates.length) return start(index + 1);
          return reject(new Error(`No Python interpreter could be started (${failures.join('; ')}). Install Python and the packages in python/requirements.txt, or set PYTHON_BIN in .env.`));
        }
        reject(new Error(`Unable to start Python executable "${python}": ${error.message}`));
      });
      child.once('close', code => {
        if (spawnFailed) return;
        if (code !== 0) {
          return reject(Object.assign(
            new Error(err || `Document extraction failed with code ${code}`),
            { status: 422 }
          ));
        }
        try { resolve(JSON.parse(out)); } catch { reject(new Error('Document extractor returned invalid JSON')); }
      });
    };
    if (pythonCandidates.length === 0) {
      return reject(new Error('No Python executable is configured. Install Python, create the project .venv, or set PYTHON_BIN in .env.'));
    }
    start(0);
  });
}

export async function extractDocument(buffer, originalName, mimeType) {
  const ext = path.extname(originalName || '').toLowerCase();
  const temp = path.join(os.tmpdir(), `invoiceeye-${Date.now()}-${Math.random().toString(36).slice(2)}${ext || '.bin'}`);
  await fs.writeFile(temp, buffer);
  try {
    const result = await runPython([], temp);
    return result;
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}
