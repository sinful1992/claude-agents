import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';

export interface SessionInfo {
  id: string;
  title: string;
  timestamp: number;
  workspacePath: string;
  projectDirName: string;
}

export interface ProjectGroup {
  workspacePath: string;
  displayName: string;
  sessions: SessionInfo[];
}

interface RawLine {
  type?: string;
  aiTitle?: string;
  isMeta?: boolean;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

function extractFirstRealTitle(line: RawLine): string | null {
  if (line.isMeta) return null;
  const content = line.message?.content;
  if (!content) return null;

  if (typeof content === 'string') {
    if (!content || content.startsWith('<')) return null;
    return content.slice(0, 60);
  }

  if (Array.isArray(content)) {
    if (content.every(item => item.type === 'tool_result')) return null;
    for (const item of content) {
      if (item.type === 'text' && item.text && !item.text.startsWith('<')) {
        return item.text.slice(0, 60);
      }
    }
  }

  return null;
}

function readSessionMetadata(
  filePath: string,
  id: string
): Promise<SessionInfo | null> {
  return new Promise(resolve => {
    let title: string | null = null;
    let timestamp: number | null = null;
    let workspacePath: string | null = null;
    let projectDirName = path.basename(path.dirname(filePath));

    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      rl.close();
      stream.destroy();
    };

    rl.on('line', rawLine => {
      let line: RawLine;
      try {
        line = JSON.parse(rawLine);
      } catch {
        return;
      }

      if (line.type === 'ai-title' && line.aiTitle) {
        title = line.aiTitle;
      } else if (line.type === 'user') {
        if (line.cwd && !workspacePath) {
          workspacePath = line.cwd;
        }
        if (line.timestamp && !timestamp) {
          const t = Date.parse(line.timestamp);
          if (!isNaN(t)) timestamp = t;
        }
        if (!title) {
          const extracted = extractFirstRealTitle(line);
          if (extracted) title = extracted;
        }
      }

      if (title && timestamp && workspacePath) finish();
    });

    rl.on('close', () => {
      if (!timestamp || !workspacePath) {
        resolve(null);
        return;
      }
      resolve({
        id,
        title: title ?? '(untitled)',
        timestamp,
        workspacePath,
        projectDirName,
      });
    });

    rl.on('error', () => resolve(null));
    stream.on('error', () => resolve(null));
  });
}

export async function readAllSessions(): Promise<ProjectGroup[]> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');

  let projectDirs: string[];
  try {
    projectDirs = (await fs.promises.readdir(projectsDir))
      .map(d => path.join(projectsDir, d));
  } catch {
    return [];
  }

  const groups = new Map<string, ProjectGroup>();

  for (const dirPath of projectDirs) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(dirPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try {
      files = (await fs.promises.readdir(dirPath))
        .filter(f => f.endsWith('.jsonl'))
        .map(f => path.join(dirPath, f));
    } catch {
      continue;
    }

    const results = await Promise.allSettled(
      files.map(f => readSessionMetadata(f, path.basename(f, '.jsonl')))
    );

    const sessions: SessionInfo[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        sessions.push(result.value);
      } else if (result.status === 'rejected') {
        console.error('[claude-session-browser] session read error:', result.reason);
      }
    }

    if (sessions.length === 0) continue;

    sessions.sort((a, b) => b.timestamp - a.timestamp);
    const workspacePath = sessions[0].workspacePath;

    const existing = groups.get(workspacePath);
    if (existing) {
      existing.sessions.push(...sessions);
      existing.sessions.sort((a, b) => b.timestamp - a.timestamp);
    } else {
      const displayName =
        workspacePath === os.homedir()
          ? '~'
          : path.basename(workspacePath);
      groups.set(workspacePath, { workspacePath, displayName, sessions });
    }
  }

  return [...groups.values()].sort(
    (a, b) => b.sessions[0].timestamp - a.sessions[0].timestamp
  );
}

export function getProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}
