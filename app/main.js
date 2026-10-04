'use strict';
/*
 * Noir Studio · Servidor (NoirStudioServidor.exe)
 *   (doble clic)   → instalador: elige disco, importa el paquete de mudanza y lo deja arrancando con Windows
 *   --run          → supervisor: mantiene vivos el servidor y el túnel, publica la dirección y aplica actualizaciones
 *   --worker       → el servidor del hosting
 *   --version      → muestra la versión
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const VERSION = require('../lib/version');

const args = process.argv.slice(1).filter((a) => a.startsWith('--'));
const flag = (name) => args.includes(`--${name}`);
const option = (name) => (args.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || null;
const EXE_NAME = 'NoirStudioServidor.exe';
const TASK = 'Noir Studio Servidor';
const POINTER = process.env.NOIR_POINTER || path.join(process.env.ProgramData || 'C:\\ProgramData', 'NoirStudio', 'ubicacion.txt');
const CF_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const FIXED_LINK = 'https://noirstudio-web.github.io/hosting/';

const gold = (s) => `\x1b[38;5;180m${s}\x1b[0m`;
const dim = (s) => `\x1b[90m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═════════════════════════ Utilidades ═════════════════════════

function run(cmd, cmdArgs, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}${stderr}`.trim() }));
  });
}

function ps(script, timeout = 60000) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], timeout);
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function downloadFile(url, dest) {
  const r = await fetch(url);
  if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const out = fs.createWriteStream(tmp);
  for await (const chunk of r.body) if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
  await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
  await fsp.rename(tmp, dest);
}

// Extrae un ZIP sin compresión (como los que genera el panel).
function unzipStored(zipPath, destDir) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error('el archivo no es un ZIP válido');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    let p = 0;
    let files = 0;
    const root = path.resolve(destDir);
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('directorio del ZIP dañado');
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      const target = path.resolve(root, name);
      if (!target.startsWith(root + path.sep) && target !== root) throw new Error(`ruta no permitida en el ZIP: ${name}`);
      if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
      if (method !== 0) throw new Error('el ZIP está comprimido; usa el paquete descargado del panel');
      const lh = Buffer.alloc(30);
      fs.readSync(fd, lh, 0, 30, local);
      const start = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const out = fs.openSync(target, 'w');
      const buf = Buffer.alloc(1024 * 1024);
      let done = 0;
      while (done < csize) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, csize - done), start + done);
        fs.writeSync(out, buf, 0, n);
        done += n;
      }
      fs.closeSync(out);
      files++;
    }
    return files;
  } finally {
    fs.closeSync(fd);
  }
}

// ═════════════════════════ Modos ═════════════════════════

if (flag('version')) {
  process.stdout.write(`${VERSION}\n`);
} else if (flag('worker')) {
  require('../server');
} else if (flag('run')) {
  supervise().catch((err) => { console.error(err); process.exit(1); });
} else {
  install().catch(async (err) => {
    console.log(`\n  ${red('■')} ${err.message}`);
    await waitEnter();
    process.exit(1);
  });
}

// ═════════════════════════ Supervisor ═════════════════════════

async function supervise() {
  const HOME = process.env.NOIR_HOME || path.resolve(path.dirname(process.execPath), '..');
  const APP_EXE = process.env.NOIR_APP_EXE || path.join(HOME, 'app', EXE_NAME);
  const DATA = path.join(HOME, 'data');
  const LOG = path.join(DATA, 'logs', 'servidor.log');
  const CF = path.join(HOME, 'bin', 'cloudflared.exe');
  fs.mkdirSync(path.dirname(LOG), { recursive: true });

  const cfgPort = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).port || 8420; } catch { return 8420; } };
  const logLine = (line) => {
    try {
      if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, `${LOG}.1`);
      fs.appendFileSync(LOG, `${new Date().toISOString()} ${line.replace(/\x1b\[[0-9;]*m/g, '')}\n`);
      if (process.env.NOIR_DEV === '1') console.log(line);
    } catch { /* sin registro */ }
  };
  const state = { version: VERSION, startedAt: Date.now(), publicUrl: null, home: HOME };
  const saveState = () => { try { fs.writeFileSync(path.join(DATA, 'estado.json'), JSON.stringify(state, null, 2)); } catch { /* nada */ } };
  logLine(`Supervisor ${VERSION} iniciado en ${HOME}`);

  // ── Servidor (proceso hijo)
  let worker = null;
  let stopping = false;
  let backoff = 1000;
  const startWorker = () => {
    const isExe = /\.exe$/i.test(APP_EXE) && fs.existsSync(APP_EXE) && process.env.NOIR_DEV !== '1';
    const cmd = isExe ? APP_EXE : process.execPath;
    const cmdArgs = isExe ? ['--worker'] : [path.join(__dirname, '..', 'app', 'main.js'), '--worker'];
    const started = Date.now();
    const w = spawn(cmd, cmdArgs, {
      env: { ...process.env, NOIR_HOME: HOME, NOIR_APP_EXE: APP_EXE, NOIR_PUBLIC_URL: state.publicUrl || '' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    worker = w;
    const pipe = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach(logLine);
    w.stdout.on('data', pipe);
    w.stderr.on('data', pipe);
    w.on('message', (msg) => { if (msg?.type === 'apply-update') applyUpdate(msg.file, msg.version); });
    w.on('exit', (code) => {
      if (worker !== w) return;
      worker = null;
      if (stopping) return;
      backoff = Date.now() - started > 60000 ? 1000 : Math.min(backoff * 2, 30000);
      logLine(`El servidor se detuvo (código ${code}). Reiniciando en ${backoff / 1000} s`);
      setTimeout(startWorker, backoff);
    });
  };
  const stopWorker = () => new Promise((resolve) => {
    if (!worker) return resolve();
    const w = worker;
    const t = setTimeout(() => { try { w.kill(); } catch { /* nada */ } }, 8000);
    w.once('exit', () => { clearTimeout(t); resolve(); });
    try { w.send({ type: 'shutdown' }); } catch { w.kill(); }
  });

  // ── Actualización: cambia el ejecutable y reinicia el servidor (el túnel sigue abierto)
  async function applyUpdate(file, version) {
    logLine(`Aplicando la versión ${version}`);
    stopping = true;
    await stopWorker();
    try {
      const old = `${APP_EXE}.old`;
      await fsp.rm(old, { force: true }).catch(() => {});
      if (fs.existsSync(APP_EXE)) await fsp.rename(APP_EXE, old);
      await fsp.rename(file, APP_EXE);
      state.version = version;
      logLine(`Versión ${version} instalada`);
    } catch (err) {
      logLine(`No se pudo cambiar el ejecutable: ${err.message}`);
    }
    stopping = false;
    saveState();
    startWorker();
  }

  // ── Enlace fijo: publica la dirección actual firmada (la página solo acepta nuestra firma)
  let relay = null;
  try { relay = JSON.parse(fs.readFileSync(path.join(DATA, 'relay-key.json'), 'utf8')); } catch { /* sin clave */ }
  const publish = async () => {
    if (!relay?.topic || !relay.privateKey || !state.publicUrl) return;
    const ts = Date.now();
    const sig = crypto.sign('sha256', Buffer.from(`${state.publicUrl}\n${ts}`), { key: relay.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    try {
      const r = await fetch(`https://ntfy.sh/${relay.topic}`, { method: 'POST', body: JSON.stringify({ url: state.publicUrl, ts, sig }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (err) {
      logLine(`No se pudo publicar la dirección en el enlace fijo: ${err.message}`);
    }
  };
  setInterval(publish, 20 * 60 * 1000);

  // ── Túnel seguro
  let tunnel = null;
  const startTunnel = async () => {
    if (process.env.NOIR_NO_TUNNEL === '1') return;
    if (!fs.existsSync(CF)) {
      try {
        logLine('Descargando cloudflared…');
        await downloadFile(CF_URL, CF);
      } catch (err) {
        logLine(`No se pudo descargar cloudflared: ${err.message}. Reintento en 60 s`);
        return setTimeout(startTunnel, 60000);
      }
    }
    const t = spawn(CF, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${cfgPort()}`], { windowsHide: true });
    tunnel = t;
    let buf = '';
    const onData = (d) => {
      buf = (buf + String(d)).slice(-8000);
      const m = buf.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
      if (m && m[0] !== state.publicUrl) {
        state.publicUrl = m[0];
        logLine(`Dirección pública: ${state.publicUrl}`);
        saveState();
        try { worker?.send({ type: 'public-url', url: state.publicUrl }); } catch { /* aún no listo */ }
        setTimeout(publish, 5000);
      }
    };
    t.stdout.on('data', onData);
    t.stderr.on('data', onData);
    t.on('exit', () => {
      if (tunnel !== t) return;
      tunnel = null;
      state.publicUrl = null;
      saveState();
      logLine('El túnel se cerró. Reintentando en 10 s');
      setTimeout(startTunnel, 10000);
    });
  };

  const shutdown = async () => {
    stopping = true;
    try { tunnel?.kill(); } catch { /* nada */ }
    await stopWorker();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => { try { tunnel?.kill(); } catch { /* nada */ } try { worker?.kill(); } catch { /* nada */ } });

  saveState();
  startWorker();
  startTunnel();
}

// ═════════════════════════ Instalador ═════════════════════════

function waitEnter(msg = 'Pulsa Enter para cerrar') {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve();
    process.stdout.write(`\n  ${msg}`);
    process.stdin.resume();
    process.stdin.once('data', () => resolve());
  });
}

async function isAdmin() {
  return (await run('net.exe', ['session'], 10000)).ok;
}

async function chooseHome() {
  if (process.env.NOIR_INSTALL_HOME) return process.env.NOIR_INSTALL_HOME;
  let disks = [];
  const r = await ps("Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FreeSpace | ConvertTo-Json -Compress", 20000);
  try { disks = [].concat(JSON.parse(r.out || '[]')).filter((d) => d?.DeviceID); } catch { /* sin datos */ }
  disks.sort((a, b) => Number(b.FreeSpace) - Number(a.FreeSpace));
  return `${disks[0]?.DeviceID || process.env.SystemDrive || 'C:'}\\NoirStudio`;
}

function findPackage(extraDirs) {
  const dirs = [...extraDirs, path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Descargas'), path.join(os.homedir(), 'Desktop')];
  let best = null;
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/^noir-respaldo.*\.zip$/i.test(n)) continue;
      const full = path.join(d, n);
      const st = fs.statSync(full);
      if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs };
    }
  }
  return best?.path || null;
}

async function waitFor(fn, ms, step = 1000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return null;
}

async function install() {
  process.title = 'Noir Studio · Instalar servidor';
  console.log('');
  console.log(`  ${gold('■')} ${bold('NOIR STUDIO')}  ${dim(`· Instalador del servidor · v${VERSION}`)}`);
  console.log(`  ${dim('─'.repeat(62))}`);
  if (process.platform !== 'win32') throw new Error('Este instalador es para Windows.');
  const self = process.execPath;
  const fromDir = option('from') || path.dirname(self);

  if (!process.env.NOIR_NO_ELEVATE && !(await isAdmin())) {
    console.log(`  Windows pedirá permiso de administrador: pulsa ${bold('Sí')}.`);
    const script = `Start-Process -FilePath ${psQuote(self)} -ArgumentList ${psQuote(`--install --from="${fromDir}"`)} -Verb RunAs`;
    const r = await ps(script, 120000);
    if (!r.ok) throw new Error('Se necesita permiso de administrador para instalar el servidor.');
    return;
  }

  // ¿Ya instalado? → actualizar en su sitio
  let home = null;
  try { home = fs.readFileSync(POINTER, 'utf8').trim(); } catch { /* primera vez */ }
  const upgrading = Boolean(home && fs.existsSync(path.join(home, 'app')));
  if (!upgrading) home = await chooseHome();
  const appExe = path.join(home, 'app', EXE_NAME);
  console.log(`  ${dim('Carpeta del servidor ')} ${home}`);

  if (!process.env.NOIR_NO_TASK) await ps(`Stop-ScheduledTask -TaskName ${psQuote(TASK)} -ErrorAction SilentlyContinue`, 30000);
  await sleep(1500);
  fs.mkdirSync(path.join(home, 'app'), { recursive: true });
  if (path.resolve(self).toLowerCase() !== appExe.toLowerCase()) {
    await fsp.rm(`${appExe}.old`, { force: true }).catch(() => {});
    if (fs.existsSync(appExe)) await fsp.rename(appExe, `${appExe}.old`).catch(() => {});
    fs.copyFileSync(self, appExe);
  }
  fs.mkdirSync(path.dirname(POINTER), { recursive: true });
  fs.writeFileSync(POINTER, home);
  console.log(`  ${green('✓')} Programa copiado`);

  if (!upgrading) {
    const pkg = findPackage([fromDir, path.dirname(self)]);
    if (pkg) {
      const n = unzipStored(pkg, home);
      let users = 0;
      try { users = JSON.parse(fs.readFileSync(path.join(home, 'data', 'db.json'), 'utf8')).users.length; } catch { /* nada */ }
      console.log(`  ${green('✓')} Datos importados de ${path.basename(pkg)} ${dim(`(${n} archivos, ${users} usuario(s))`)}`);
    } else {
      console.log(`  ${yellow('!')} No se encontró el paquete de mudanza (noir-respaldo….zip): se instala vacío`);
    }
  }

  if (!process.env.NOIR_NO_TASK) {
    await run('netsh.exe', ['advfirewall', 'firewall', 'delete', 'rule', `name=${TASK}`]);
    await run('netsh.exe', ['advfirewall', 'firewall', 'add', 'rule', `name=${TASK}`, 'dir=in', 'action=allow', `program=${appExe}`, 'enable=yes', 'profile=private,domain']);
    await run('powercfg.exe', ['/change', 'standby-timeout-ac', '0']);
    await run('powercfg.exe', ['/change', 'hibernate-timeout-ac', '0']);
    console.log(`  ${green('✓')} El equipo ya no entrará en suspensión (con corriente)`);

    const task = [
      `$a = New-ScheduledTaskAction -Execute ${psQuote(appExe)} -Argument '--run' -WorkingDirectory ${psQuote(path.join(home, 'app'))}`,
      "$t = New-ScheduledTaskTrigger -AtStartup",
      "$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew",
      "$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
      `Register-ScheduledTask -TaskName ${psQuote(TASK)} -Description 'Servidor de Noir Studio Hosting' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`,
      `Start-ScheduledTask -TaskName ${psQuote(TASK)}`,
    ].join('; ');
    const r = await ps(task, 60000);
    if (!r.ok) throw new Error(`No se pudo registrar el arranque automático: ${r.out}`);
    console.log(`  ${green('✓')} Arranca solo al encender el equipo ${dim('(aunque nadie inicie sesión)')}`);
  } else {
    // Modo de prueba: sin tarea programada, se arranca el supervisor directamente.
    spawn(appExe, ['--run'], { env: { ...process.env, NOIR_HOME: home }, detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }

  console.log(`\n  ${dim('Iniciando el servidor…')}`);
  const port = (() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).port || 8420; } catch { return 8420; } })();
  const up = await waitFor(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/api/session`, { signal: AbortSignal.timeout(2000) })).json()).version; } catch { return null; }
  }, 90000);
  if (!up) throw new Error(`El servidor no arrancó. Revisa ${path.join(home, 'data', 'logs', 'servidor.log')}`);
  console.log(`  ${green('✓')} Servidor en marcha ${dim(`(v${up})`)}`);
  const estado = await waitFor(async () => {
    try { const s = JSON.parse(fs.readFileSync(path.join(home, 'data', 'estado.json'), 'utf8')); return s.publicUrl ? s : null; } catch { return null; }
  }, 90000);

  console.log(`\n  ${dim('─'.repeat(62))}`);
  console.log(`  ${bold('¡Listo! Este PC ya es el servidor de Noir Studio.')}`);
  console.log(`  ${dim('Enlace fijo     ')} ${gold(bold(FIXED_LINK))}`);
  if (estado?.publicUrl) console.log(`  ${dim('Dirección actual')} ${estado.publicUrl}`);
  console.log(`  ${dim('En este equipo  ')} http://localhost:${port}`);
  try {
    const code = fs.readFileSync(path.join(home, 'data', 'codigo-configuracion.txt'), 'utf8').trim();
    if (code) console.log(`  ${dim('Primer inicio   ')} código de configuración ${gold(bold(code))}`);
  } catch { /* ya hay cuentas */ }
  console.log(`  ${dim('─'.repeat(62))}`);
  console.log(`  ${dim('Puedes cerrar esta ventana: el servidor sigue funcionando en segundo plano.')}`);
  await waitEnter();
}
