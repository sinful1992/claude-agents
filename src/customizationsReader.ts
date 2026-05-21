import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface Customizations {
  agents: string[];
  skills: string[];
  instructions: string[];
  hooks: string[];
  mcpServers: string[];
}

export async function readCustomizations(): Promise<Customizations> {
  const home = os.homedir();
  const claudeDir = path.join(home, '.claude');

  const [agents, skills, instructions, hooks, mcpServers] = await Promise.all([
    listDir(path.join(claudeDir, 'agents'), ['.md', '.json']),
    listDir(path.join(claudeDir, 'commands'), ['.md']),
    listClaudeMd(home),
    listHooks(path.join(claudeDir, 'settings.json')),
    listMcpServers(path.join(claudeDir, 'settings.json')),
  ]);

  return { agents, skills, instructions, hooks, mcpServers };
}

async function listDir(dirPath: string, exts: string[]): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dirPath);
    return entries
      .filter(f => exts.some(ext => f.endsWith(ext)))
      .map(f => path.basename(f, path.extname(f)));
  } catch {
    return [];
  }
}

async function listClaudeMd(startDir: string): Promise<string[]> {
  const home = os.homedir();
  const results: string[] = [];
  const dirs = [startDir];
  let depth = 0;

  while (dirs.length > 0 && depth < 3) {
    const nextDirs: string[] = [];
    for (const dir of dirs) {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name === 'CLAUDE.md') {
          const full = path.join(dir, entry.name);
          results.push(full.startsWith(home) ? '~' + full.slice(home.length) : full);
        }
        if (
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules'
        ) {
          nextDirs.push(path.join(dir, entry.name));
        }
      }
    }
    dirs.length = 0;
    dirs.push(...nextDirs);
    depth++;
  }

  return results;
}

async function readSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.promises.readFile(settingsPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function listHooks(settingsPath: string): Promise<string[]> {
  const settings = await readSettings(settingsPath);
  const hooks = settings['hooks'];
  if (!hooks || typeof hooks !== 'object') return [];
  return Object.entries(hooks as Record<string, unknown>)
    .filter(([, v]) => Array.isArray(v) ? v.length > 0 : !!v)
    .map(([k]) => k);
}

async function listMcpServers(settingsPath: string): Promise<string[]> {
  const settings = await readSettings(settingsPath);
  const mcp = settings['mcpServers'];
  if (!mcp || typeof mcp !== 'object') return [];
  return Object.keys(mcp as object);
}
