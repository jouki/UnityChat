import type { FastifyInstance } from 'fastify';
import { createReadStream, existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { exec, execSync } from 'child_process';
import { join, resolve } from 'path';
import { createHmac } from 'crypto';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const EXT_DIR = join(REPO_ROOT, 'extension');
const ZIP_PATH = '/tmp/unitychat-dev.zip';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'unitychat-dev-deploy';

async function buildZip(): Promise<void> {
  execSync(`cd "${EXT_DIR}" && zip -r "${ZIP_PATH}" . -x "*.DS_Store" "*.log"`, {
    stdio: 'ignore',
  });
}

export default async function devDownloadRoutes(app: FastifyInstance) {
  // Dev manifest.json (extension version from dev branch)
  app.get('/dev/manifest.json', async (_req, reply) => {
    try {
      const manifest = await readFile(join(EXT_DIR, 'manifest.json'), 'utf-8');
      reply.type('application/json').header('Cache-Control', 'no-cache').send(manifest);
    } catch {
      reply.code(404).send({ error: 'manifest.json not found' });
    }
  });

  // Dev download page
  app.get('/dev', async (_req, reply) => {
    let version = '?';
    try {
      const manifest = JSON.parse(
        await readFile(join(EXT_DIR, 'manifest.json'), 'utf-8'),
      );
      version = manifest.version || '?';
    } catch {}

    let branch = '?';
    try {
      branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: REPO_ROOT })
        .toString()
        .trim();
    } catch {}

    let commit = '?';
    try {
      commit = execSync('git log --oneline -1', { cwd: REPO_ROOT })
        .toString()
        .trim();
    } catch {}

    reply.type('text/html').send(`<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>UnityChat DEV</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #08080a;
      color: #f4f3ef;
      font-family: 'Segoe UI', system-ui, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #121018;
      border: 1px solid rgba(255, 140, 0, 0.3);
      border-radius: 16px;
      padding: 3rem;
      max-width: 480px;
      width: 90%;
      text-align: center;
    }
    .badge {
      display: inline-block;
      background: rgba(255, 60, 60, 0.15);
      border: 1px solid rgba(255, 60, 60, 0.4);
      color: #ff6b6b;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      padding: 4px 12px;
      border-radius: 999px;
      margin-bottom: 1.5rem;
    }
    h1 {
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }
    h1 span { color: #ff8c00; }
    .version {
      color: #a39f94;
      font-size: 14px;
      margin-bottom: 0.3rem;
    }
    .commit {
      color: #5f5b52;
      font-size: 12px;
      font-family: monospace;
      margin-bottom: 2rem;
    }
    .btn {
      display: inline-block;
      padding: 14px 32px;
      background: linear-gradient(135deg, #ffc000, #ff7a00);
      color: #1a0b00;
      font-weight: 700;
      font-size: 15px;
      border-radius: 10px;
      text-decoration: none;
      transition: transform 0.2s;
    }
    .btn:hover { transform: translateY(-2px); }
    .warn {
      margin-top: 1.5rem;
      color: #5f5b52;
      font-size: 12px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Development Build</div>
    <h1>Unity<span>Chat</span></h1>
    <div class="version">v${version} &middot; branch: ${branch}</div>
    <div class="commit">${commit}</div>
    <a class="btn" href="/dev/download">Stáhnout DEV ZIP</a>
    <p class="warn">
      Tohle je vývojová verze. Může obsahovat nedokončené funkce a bugy.<br>
      Pro stabilní verzi jdi na <a href="https://jouki.cz/UnityChat" style="color:#ff8c00;">jouki.cz/UnityChat</a>
    </p>
  </div>
</body>
</html>`);
  });

  // Dev ZIP download
  app.get('/dev/download', async (_req, reply) => {
    if (!existsSync(EXT_DIR)) {
      reply.code(404);
      return { error: 'Extension directory not found' };
    }

    await buildZip();

    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', 'attachment; filename="unitychat-dev.zip"');
    return reply.send(createReadStream(ZIP_PATH));
  });

  // GitHub webhook → git pull (tsx watch auto-restarts on file changes)
  app.post('/webhook/deploy', async (req, reply) => {
    // Verify GitHub signature
    const sig = req.headers['x-hub-signature-256'] as string;
    const body = JSON.stringify(req.body);
    if (sig) {
      const expected = 'sha256=' + createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
      if (sig !== expected) {
        reply.code(403);
        return { ok: false, error: 'Invalid signature' };
      }
    }

    // Only deploy on dev branch pushes
    const payload = req.body as { ref?: string };
    if (payload.ref && payload.ref !== 'refs/heads/dev') {
      return { ok: true, skipped: true, reason: 'Not dev branch' };
    }

    // Git pull + touch signal file so PC auto-sync picks it up
    exec(`cd "${REPO_ROOT}" && git pull origin dev --ff-only && touch /tmp/uc-deploy-signal`, (err, stdout, stderr) => {
      if (err) console.error('Deploy pull failed:', stderr);
      else console.log('Deploy pull:', stdout.trim());
    });

    return { ok: true, deploying: true };
  });
}
